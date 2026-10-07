/**
 * The whole path on a real Postgres with core migrated, through the host a
 * plugin is handed: the starter Economy sources fetched from a fake web
 * (conditional GETs, a failing source, Google News items naming outlets),
 * articles grouped into one story told by six outlets in two languages, the
 * reads and exports, told-marks and material updates, the owner's feedback,
 * twins across topics, logos, health, and retention. No socket is opened.
 * Skipped without `DATABASE_URL`.
 */
import { mkdtempSync, readFileSync, rmSync, mkdirSync } from 'node:fs';
import path from 'node:path';
import type { Pool } from 'pg';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import {
  configurePluginHost, createMemoryVault, createPluginHost, createPool, hostBindingOf, resetPluginHost, runMigrations, testDatabaseUrl,
  type CoreToolContext,
} from '@buddi/core/testing';
import type { BuddiHost, ToolDefinition } from '@buddi/core/plugin';
import { manifest } from './index.js';
import { fetchMissingLogos, moveKeptLogos, refresh, resetPoller, fetchSourceDefinition } from './poller.js';
import { resetPoliteness } from './fetch.js';
import { gnewsUrl, type StarterTopic, type StarterSource, type StarterOutlet } from './starter.js';
import { FIRST_READ_NOTE, SETUP_NOTE } from './setup.js';
import type { HeadlinesOutput } from './tools.js';
import type { StoryDetail } from './reads.js';
import { setupView, storiesFor } from './dashboard.js';
import { reclusterOpen, ensureTopic, ensureOutlet, addSourceRow } from './store.js';
import { fromBytes, type Embedder } from './embed.js';
import { MEANING_MODEL } from './meaning.js';

const databaseUrl = await testDatabaseUrl();
const suite = databaseUrl ? describe : describe.skip;
const TEST_DB = `buddi_news_test_${process.pid}`;

interface Fixture { outlet: string; lang: string; at: string; title: string; lead: string }
const fx = JSON.parse(readFileSync(new URL('./fixtures/stories.json', import.meta.url), 'utf8')) as { fedCut: Fixture[]; crossLanguage: Array<[Fixture, Fixture]>; togoMix: Fixture[] };
const legacy = JSON.parse(readFileSync(new URL('./testing/legacy-starters.json', import.meta.url), 'utf8')) as { topics: StarterTopic[]; sources: StarterSource[]; outlets: StarterOutlet[] };
const recorded = JSON.parse(readFileSync(new URL('./fixtures/vectors.json', import.meta.url), 'utf8')) as { vectors: Record<string, string> };
/** The meaning model, faked: the recorded vector of a fixture text, a fixed vector of its own for any other. */
const fakeMeaning = (onEmbed: (n: number) => void = () => {}): Embedder => ({
  model: MEANING_MODEL.id,
  async embed(texts) {
    onEmbed(texts.length);
    return texts.map((t) => {
      const b64 = recorded.vectors[t];
      if (b64) return fromBytes(Buffer.from(b64, 'base64'));
      const v = new Float32Array(MEANING_MODEL.dims);
      for (let i = 0; i < t.length; i++) v[(t.charCodeAt(i) * 31 + i) % v.length]! += 1;
      const norm = Math.hypot(...v);
      return v.map((x) => x / norm);
    });
  },
});
const PNG = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.alloc(64)]);

const esc = (s: string): string => s.replace(/&/g, '&amp;').replace(/</g, '&lt;');
const rfc822 = (iso: string): string => new Date(iso).toUTCString();

interface Item { title: string; link: string; lead?: string; at: string; source?: { name: string; url: string } }
function rss(items: Item[]): string {
  return `<?xml version="1.0" encoding="UTF-8"?><rss version="2.0"><channel><title>Feed</title><link>https://example.com/</link>${items
    .map((i) => `<item><title>${esc(i.title)}</title><link>${esc(i.link)}</link><description>${esc(i.lead ?? '')}</description><pubDate>${rfc822(i.at)}</pubDate>${
      i.source ? `<source url="${i.source.url}">${esc(i.source.name)}</source>` : ''}</item>`)
    .join('')}</channel></rss>`;
}

const [cnbc, npr, bbc, lemonde, france24, rfi] = fx.fedCut as [Fixture, Fixture, Fixture, Fixture, Fixture, Fixture];
const item = (f: Fixture, link: string): Item => ({ title: f.title, link, lead: f.lead, at: f.at });

suite('news (postgres)', () => {
  let admin: Pool;
  let dataDir = '';
  let pool: Pool;
  let now = new Date('2026-09-17T22:00:00Z');
  /** What the fake web answers, by URL. */
  let web: Record<string, (headers: Record<string, string>) => { status: number; body?: string | Buffer; headers?: Record<string, string> }> = {};
  const requested: string[] = [];
  const noSleep = async (): Promise<void> => {};

  const transport = () => async (url: string, init: { headers?: Record<string, string> } = {}) => {
    requested.push(url);
    const headers = Object.fromEntries(Object.entries(init.headers ?? {}).map(([k, v]) => [k.toLowerCase(), v]));
    const answer = web[url]?.(headers) ?? { status: 404, body: 'not found' };
    const body = answer.body === undefined ? Buffer.alloc(0) : Buffer.isBuffer(answer.body) ? answer.body : Buffer.from(answer.body);
    const lower = Object.fromEntries(Object.entries(answer.headers ?? {}).map(([k, v]) => [k.toLowerCase(), v]));
    return {
      ok: answer.status >= 200 && answer.status < 300, status: answer.status, statusText: '', headers: { get: (n: string) => lower[n.toLowerCase()] ?? null },
      text: async () => body.toString('utf8'), json: async () => JSON.parse(body.toString('utf8')),
      arrayBuffer: async () => body.buffer.slice(body.byteOffset, body.byteOffset + body.byteLength) as ArrayBuffer,
    };
  };

  const facts = (over: Partial<CoreToolContext> = {}): CoreToolContext => ({ db: pool, ownerId: 'owner', now: () => now, timezone: 'Europe/Paris', agentId: 'anchor', ...over });
  const host = (over: Partial<CoreToolContext> = {}): BuddiHost => createPluginHost(hostBindingOf(manifest), facts(over));
  const ctx = (over: Partial<CoreToolContext> = {}): CoreToolContext => ({ ...facts(over), buddi: host(over) });
  const tool = (name: string) => manifest.tools.find((t) => t.name === name)! as ToolDefinition<any, any>;
  const run = (name: string, input: unknown, over: Partial<CoreToolContext> = {}) => tool(name).execute(input as never, ctx(over));
  const asOwner = { agentId: 'owner' };
  const fetchAll = (topicId = 'economy') => refresh(host(), { topicId, sleep: noSleep });

  // Recorded clustering scenarios remain independent of the public starter kit.
  const seedFixtureTopic = async (id: string) => {
    const db = host().db;
    const topic = legacy.topics.find((t) => t.id === id)!;
    await ensureTopic(db, { ...topic, builtin: true });
    for (const outlet of legacy.outlets) await ensureOutlet(db, outlet.domain, outlet.name, {
      kind: outlet.kind, ...(outlet.language ? { language: outlet.language } : {}), ...(outlet.paywall ? { paywall: true } : {}),
    });
    let sources = 0;
    for (const source of legacy.sources.filter((s) => s.topics.some((t) => t.topic === id))) {
      const outletId = source.outlet ? await ensureOutlet(db, source.outlet, '') : null;
      if (await addSourceRow(db, { ...source, outletId, addedBy: 'starter' }, source.topics.filter((t) => t.topic === id), now)) sources++;
    }
    return { topics: [topic.name], sources };
  };

  const serveEconomy = (): void => {
    web = {
      'https://rss.nytimes.com/services/xml/rss/nyt/Economy.xml': () => ({ status: 200, body: rss([item(cnbc, 'https://www.nytimes.com/2026/09/17/business/fed-cuts-rates.html?smid=rss')]) }),
      'https://www.theguardian.com/business/economics/rss': () => ({ status: 200, body: rss([item(bbc, 'https://www.theguardian.com/business/2026/sep/17/fed-rates')]) }),
      'https://www.lemonde.fr/economie/rss_full.xml': () => ({ status: 200, body: rss([item(lemonde, 'https://www.lemonde.fr/economie/article/2026/09/17/la-fed-abaisse-ses-taux.html?xtor=RSS-1')]) }),
      'https://www.lefigaro.fr/rss/figaro_economie.xml': () => ({ status: 200, body: rss([item(rfi, 'https://www.lefigaro.fr/conjoncture/la-fed-reduit-ses-taux')]) }),
      [gnewsUrl('site:reuters.com business when:1d', 'en')]: () => ({
        status: 200,
        body: rss([{ ...item(npr, 'https://news.google.com/rss/articles/CBMiREUTERS1?oc=5'), title: `${npr.title} - Reuters`, source: { name: 'Reuters', url: 'https://www.reuters.com' } }]),
      }),
      [gnewsUrl('site:lesechos.fr when:1d', 'fr')]: () => ({
        status: 200,
        body: rss([{ ...item(france24, 'https://news.google.com/rss/articles/CBMiECHOS1?oc=5'), title: `${france24.title} - Les Echos`, source: { name: 'Les Echos', url: 'https://www.lesechos.fr' } }]),
      }),
      'https://www.cnbc.com/id/100003114/device/rss/rss.html': () => ({
        status: 200,
        body: rss([{ title: 'Apple unveils new iPhone with faster chip at September event', link: 'https://www.cnbc.com/2026/09/17/apple-iphone.html', lead: 'Apple announced its new iPhone on Tuesday.', at: '2026-09-17T17:00:00Z' }]),
      }),
      'https://www.ft.com/rss/home/international': (h) => (h['if-none-match'] === '"ft-1"'
        ? { status: 304 }
        : { status: 200, body: rss([]), headers: { etag: '"ft-1"' } }),
      'https://www.bloomberg.com/feeds/markets/news.rss': () => ({ status: 500 }),
      'https://nytimes.com/': () => ({ status: 301, headers: { location: 'https://www.nytimes.com/' } }),
      'https://www.nytimes.com/': () => ({ status: 200, body: '<html><head><link rel="apple-touch-icon" href="/touch.png"></head></html>' }),
      'https://www.nytimes.com/touch.png': () => ({ status: 200, body: PNG, headers: { 'content-type': 'image/png' } }),
    };
  };

  beforeAll(async () => {
    admin = createPool(databaseUrl as string);
    await admin.query(`drop database if exists ${TEST_DB}`);
    await admin.query(`create database ${TEST_DB}`);
    const url = new URL(databaseUrl as string);
    url.pathname = `/${TEST_DB}`;
    pool = createPool(url.toString());
    await runMigrations(pool, [manifest]);
    // Logos go through the assets area: a fake codec, and a data directory of the test's own.
    mkdirSync(new URL('../node_modules/.cache/', import.meta.url), { recursive: true });
    dataDir = mkdtempSync(path.join(new URL('../node_modules/.cache/', import.meta.url).pathname, 'news-assets-'));
    configurePluginHost({
      vault: createMemoryVault(), httpTransport: transport as never, env: { BUDDI_DATA_DIR: dataDir },
      images: { normalise: async (bytes: Buffer) => ({ 64: bytes, 128: bytes }) },
    });
  }, 60_000);

  afterAll(async () => {
    resetPluginHost();
    if (dataDir) rmSync(dataDir, { recursive: true, force: true });
    await pool?.end();
    await admin?.query(`drop database if exists ${TEST_DB}`);
    await admin?.end();
  });

  beforeEach(async () => {
    now = new Date('2026-09-17T22:00:00Z');
    requested.length = 0;
    resetPoller();
    resetPoliteness();
    serveEconomy();
    await pool.query(`truncate news.topics, news.sources, news.outlets, news.logos, news.articles, news.stories, news.editions cascade`);
  });

  it('gates fresh setup, rejects premature continuation and remembers the explicit fallback', async () => {
    await pool.query('update news.settings set meaning_setup_done = false');
    expect((await setupView(host())).rows[0]!.gate).toBe(true);
    await expect(run('news.finish_meaning_setup', { skip: false }, asOwner)).rejects.toThrow('Wait for the download');
    expect((await setupView(host())).rows[0]!.gate).toBe(true);
    await run('news.finish_meaning_setup', { skip: true }, asOwner);
    expect((await setupView(host())).rows[0]!.gate).toBe(false);
    expect((await setupView(host())).rows[0]!.gate).toBe(false);
    await pool.query('update news.settings set meaning_setup_done = false');
  });

  it('keeps source selection focused until starter or custom sources exist', async () => {
    await pool.query('update news.settings set meaning_setup_done = true, custom_source_setup = false');
    expect((await setupView(host())).rows[0]).toMatchObject({ gate: false, sourcesGate: true, settingsReady: false, customSources: false });
    await run('news.choose_custom_sources', {}, asOwner);
    expect((await setupView(host())).rows[0]).toMatchObject({ sourcesGate: true, settingsReady: false, customSources: true });
    const review = await manifest.queries!.find((q) => q.name === 'starter_review')!.produce({}, ctx());
    expect((review as { sources: unknown[] }).sources).toHaveLength(28);
    expect((await pool.query('select count(*)::int as n from news.sources')).rows[0].n).toBe(0);
    await run('news.add_topic', tool('news.add_topic').input!.parse({ name: 'Local news', keywords: 'local news' }), asOwner);
    expect((await setupView(host())).rows[0]).toMatchObject({ sourcesGate: false, settingsReady: true });
    await pool.query('update news.settings set meaning_setup_done = false, custom_source_setup = false');
  });

  it('keeps settings accessible for configured sources', async () => {
    await pool.query('update news.settings set meaning_setup_done = false');
    await run('news.enable_starter', {}, asOwner);
    expect((await setupView(host())).rows[0]).toMatchObject({ gate: false, sourcesGate: false, settingsReady: true });
  });

  it('enables only US and International by default, without duplicating sources', async () => {
    const enabled = await run('news.enable_starter', {}, asOwner);
    expect(enabled.topics).toEqual(['US', 'International']);
    expect(enabled.sources).toBe(28);
    expect((await pool.query('select id from news.topics order by id')).rows).toEqual([{ id: 'international' }, { id: 'us-politics' }]);
    expect((await run('news.enable_starter', {}, asOwner)).sources).toBe(0);
  });

  it('says what to do first, then that it is reading, then is ready', async () => {
    const setup = manifest.setup!;
    expect(await setup.produce(ctx())).toEqual({ ready: false, note: SETUP_NOTE });
    expect(await run('news.headlines', {})).toEqual({ setUp: false, message: expect.stringContaining('No news topic yet') });
    const enabled = await seedFixtureTopic('economy');
    expect(enabled.topics).toEqual(['Economy']);
    expect(enabled.sources).toBe(12);
    expect(await setup.produce(ctx())).toEqual({ ready: false, note: FIRST_READ_NOTE });
    await fetchAll();
    expect(await setup.produce(ctx())).toEqual({ ready: true });
  });

  it('fetches on the timer only what is due, at most eight a tick', async () => {
    await seedFixtureTopic('economy');
    await fetchSourceDefinition.poll({ buddi: host() });
    // Nothing due yet: a new source's first fetch is up to a minute ahead.
    const { rows: urls } = await pool.query(`select url from news.sources`);
    expect(requested.filter((u) => urls.some((r) => r.url === u))).toEqual([]);
    now = new Date(now.getTime() + 2 * 60_000);
    resetPoller();
    const { rows: before } = await pool.query(`select count(*)::int as n from news.sources where last_ok_at is not null or last_error is not null`);
    expect(before[0].n).toBe(0);
    await refresh(host(), { sleep: noSleep });
    const { rows: after } = await pool.query(`select count(*)::int as n from news.sources where last_ok_at is not null or last_error is not null`);
    expect(after[0].n).toBe(8);
  });

  it('keeps feed imagery on existing articles and exposes a locally cached attributed image', async () => {
    await seedFixtureTopic('economy');
    await fetchAll();
    const url = 'https://rss.nytimes.com/services/xml/rss/nyt/Economy.xml';
    const original = web[url]!;
    web[url] = (request) => { const reply = original(request); return { ...reply, body: String(reply.body).replace('</item>', '<enclosure url="https://www.nytimes.com/story-photo.png" type="image/png" /></item>') }; };
    web['https://www.nytimes.com/story-photo.png'] = () => ({ status: 200, body: PNG, headers: { 'content-type': 'image/png' } });
    await fetchAll();
    const saved = (await pool.query('select image_url, image_key from news.articles where image_url is not null')).rows;
    expect(saved).toHaveLength(1);
    expect(saved[0].image_key).toMatch(/^story-a_/);
    const out = await run('news.headlines', { topic: 'Economy' });
    const story = out.stories.find((story: { image?: unknown }) => story.image);
    expect(story.image).toMatchObject({ key: saved[0].image_key, outlet: 'The New York Times' });
    const detail = await run('news.story', { id: story.id });
    expect(detail.image).toEqual(story.image);
    // Telegram leads with it (host API 1.33 `attachments`): this plugin's own asset, captioned.
    expect(detail.attachments).toEqual([{ kind: 'image', asset: saved[0].image_key, caption: expect.stringContaining('The New York Times') }]);
  });

  it('groups one story told by six outlets in English and French, and reads it back', async () => {
    await seedFixtureTopic('economy');
    const report = await fetchAll();
    expect(report.failed).toBeGreaterThan(0);
    const out = (await run('news.headlines', { topic: 'Economy' })) as HeadlinesOutput;
    expect(out.topic).toBe('Economy');
    const [fed, other] = out.stories;
    expect(fed!.outlets.sort()).toEqual(['Le Figaro', 'Le Monde', 'Les Echos', 'Reuters', 'The Guardian', 'The New York Times']);
    expect(fed!.languages).toEqual(['en', 'fr']);
    expect(fed!.status).toBe('new');
    expect(fed!.articles).toBe(6);
    // The best link is an outlet's own page, never a Google redirect, tracking parameters gone.
    expect(fed!.url).not.toContain('news.google.com');
    expect(other!.title).toBe('Apple unveils new iPhone with faster chip at September event');

    const story = (await run('news.story', { id: fed!.id })) as StoryDetail;
    expect(story.sources).toHaveLength(6);
    // The tool answers in buddi's StoryRow words too (host API 1.33 `story` renderer).
    expect(story.timeline.map((t) => (t as unknown as { text: string }).text.split(':')[0])).toEqual(['The New York Times', 'Reuters', 'The Guardian', 'Le Monde', 'Les Echos', 'Le Figaro']);
    expect((story as unknown as { kicker: string }).kicker).toBe(story.topic);
    expect((story.sources.find((s) => s.outlet === 'Les Echos') as unknown as { meta: string }).meta).toMatch(/^Les Echos · French · .* · Paywalled$/);
    expect((await manifest.exports!.story!.produce({ id: fed!.id }, ctx()) as StoryDetail).timeline[0]).toHaveProperty('outlet');
    expect(story.sources.find((s) => s.outlet === 'Le Monde')!.url).toBe('https://www.lemonde.fr/economie/article/2026/09/17/la-fed-abaisse-ses-taux.html');
    expect(story.sources.find((s) => s.outlet === 'Reuters')!.title).toBe(npr.title);
    expect(story.sources.find((s) => s.outlet === 'Les Echos')!.paywall).toBe(true);

    // The exports answer the same, for a plugin that requires this one.
    const exported = (await manifest.exports!.headlines!.produce({ topic: 'economy', n: 1 }, ctx())) as HeadlinesOutput;
    expect(exported.stories.map((s) => s.id)).toEqual([fed!.id]);
    expect(((await manifest.exports!.story!.produce({ id: fed!.id }, ctx())) as StoryDetail).sources).toHaveLength(6);
  });

  it('embeds new articles within the tick and groups them by meaning; without the model, by words', async () => {
    await seedFixtureTopic('economy');
    const report = await refresh(host(), { topicId: 'economy', sleep: noSleep, embedder: fakeMeaning() });
    const articles = (await pool.query(`select count(*)::int as n from news.articles`)).rows[0].n;
    expect(report.embedded).toBe(articles);
    expect((await pool.query(`select count(*)::int as n from news.article_vectors where model = $1 and octet_length(vector) = $2`, [MEANING_MODEL.id, MEANING_MODEL.dims * 4])).rows[0].n).toBe(articles);
    expect((await pool.query(`select topic_id, name from news.topic_vectors`)).rows).toEqual([{ topic_id: 'economy', name: 'Economy' }]);
    const out = (await run('news.headlines', { topic: 'Economy' })) as HeadlinesOutput;
    expect(out.stories[0]!.articles).toBe(6);
    expect(out.stories[1]!.title).toBe('Apple unveils new iPhone with faster chip at September event');
    // The model gone: nothing more is embedded, and grouping goes on by words.
    await pool.query(`truncate news.articles, news.stories cascade`);
    await pool.query(`update news.sources set etag = null, last_modified = null`);
    resetPoller();
    const without = await refresh(host(), { topicId: 'economy', sleep: noSleep, embedder: null });
    expect(without.embedded).toBe(0);
    expect((await pool.query(`select count(*)::int as n from news.article_vectors`)).rows[0].n).toBe(0);
    expect(((await run('news.headlines', { topic: 'Economy' })) as HeadlinesOutput).stories[0]!.articles).toBe(6);
  });

  it('keeps the tick to its time budget: with a slow model the articles are grouped by words and embedded on a later tick', async () => {
    await seedFixtureTopic('economy');
    let clock = 0;
    const slow = fakeMeaning(() => { clock += 10_000; });
    const report = await refresh(host(), { topicId: 'economy', sleep: noSleep, embedder: slow, clock: () => clock });
    // The topic's name took the whole budget: no article was embedded this tick, and the story formed by words.
    expect(report.embedded).toBe(0);
    expect(((await run('news.headlines', { topic: 'Economy' })) as HeadlinesOutput).stories[0]!.articles).toBe(6);
    // The next tick embeds them.
    resetPoller();
    const next = await refresh(host(), { topicId: 'economy', sleep: noSleep, embedder: fakeMeaning() });
    expect(next.embedded).toBe((await pool.query(`select count(*)::int as n from news.articles`)).rows[0].n);
  });

  it('groups the stories made by words again once by meaning, when the model has caught up', async () => {
    await seedFixtureTopic('togo-west-africa');
    now = new Date('2026-10-05T22:00:00Z');
    const source = (await pool.query(`select id from news.sources limit 1`)).rows[0].id;
    // One story by words gone wrong: the Togo day in one.
    await pool.query(`insert into news.stories (id, topic_id, first_seen, updated_at) values ('mixed', 'togo-west-africa', $1, $2)`, [fx.togoMix[2]!.at, fx.togoMix[1]!.at]);
    for (const [i, f] of fx.togoMix.entries()) {
      await pool.query(
        `insert into news.articles (id, source_id, url_canonical, url, title, lead, language, published_at, title_hash, tokens, kind)
         values ($1, $2, $3, $3, $4, $5, $6, $7, $1, '{}', 'news')`,
        [`m${i}`, source, `https://example.com/m${i}`, f.title, f.lead, f.lang, f.at],
      );
      await pool.query(`insert into news.article_topics (article_id, topic_id, story_id) values ($1, 'togo-west-africa', 'mixed')`, [`m${i}`]);
    }
    await pool.query(`update news.settings set meaning_regrouped = null`);
    resetPoller();
    // No fetch due: the tick only embeds, then regroups.
    await refresh(host(), { sleep: noSleep, embedder: fakeMeaning() });
    const stories = (await pool.query(`select id from news.stories where topic_id = 'togo-west-africa' and article_count > 0`)).rows;
    expect(stories.length).toBeGreaterThanOrEqual(4);
    expect((await pool.query(`select meaning_regrouped from news.settings`)).rows[0].meaning_regrouped).toBe(MEANING_MODEL.id);
  });

  it('keeps each source\'s health: a failure counted, failing after a day, Try again; a 304 costs nothing', async () => {
    await seedFixtureTopic('economy');
    await fetchAll();
    const health = async (id: string) => (await pool.query(`select state, failures, last_error, etag, last_ok_at, next_at from news.sources where id = $1`, [id])).rows[0];
    expect(await health('bloomberg-markets')).toMatchObject({ state: 'ok', failures: 1, last_error: 'answered 500' });
    expect(await health('financial-times')).toMatchObject({ etag: '"ft-1"', failures: 0 });

    now = new Date(now.getTime() + 25 * 3600_000);
    resetPoller();
    await fetchAll();
    expect(await health('bloomberg-markets')).toMatchObject({ state: 'failing', failures: 2 });
    const ft = await health('financial-times');
    expect(ft.last_ok_at.getTime()).toBe(now.getTime());
    expect(ft.etag).toBe('"ft-1"');

    const sources = (await (manifest.queries!.find((q) => q.name === 'sources')!.produce({ topic: 'economy' }, ctx()))) as { sources: Array<{ id: string; state: string; lastError: string | null }> };
    expect(sources.sources.find((s) => s.id === 'bloomberg-markets')).toMatchObject({ state: 'failing', lastError: 'answered 500' });
    expect(await run('news.retry_source', { id: 'bloomberg-markets' }, asOwner)).toEqual({ id: 'bloomberg-markets', retried: true });
    expect(await health('bloomberg-markets')).toMatchObject({ state: 'ok' });
    // The three feeds the fake web does not serve have failed for a day too.
    const topics = (await run('news.topics', {})) as { topics: Array<{ id: string; failing: number; sourcesFailing: string[] }> };
    expect(topics.topics[0]).toMatchObject({ id: 'economy', failing: 3 });
    expect(topics.topics[0]!.sourcesFailing.sort()).toEqual([
      'Le Monde · Économie mondiale: answered 404', 'Libération · Économie: answered 404', 'The Economist · Finance and economics: answered 404',
    ]);
  });

  it('marks what was told, skips it, and brings it back with two new outlets', async () => {
    await seedFixtureTopic('economy');
    await fetchAll();
    const [fed] = ((await run('news.headlines', { topic: 'economy' })) as HeadlinesOutput).stories;
    const told = await run('news.mark_told', { storyIds: [fed!.id, 's_missing'], edition: 'morning' });
    expect(told.marked).toEqual([{ id: fed!.id, wasUpdate: false }]);
    expect(told.unknown).toEqual(['s_missing']);
    expect(((await run('news.headlines', { topic: 'economy' })) as HeadlinesOutput).stories[0]!.status).toBe('told');
    expect(((await run('news.headlines', { topic: 'economy', untold: true })) as HeadlinesOutput).stories.map((s) => s.id)).not.toContain(fed!.id);

    // A reworded title from an outlet already there is not news; two new outlets are.
    now = new Date('2026-09-18T06:00:00Z');
    resetPoller();
    web['https://www.cnbc.com/id/100003114/device/rss/rss.html'] = () => ({ status: 200, body: rss([item({ ...cnbc, at: '2026-09-18T05:00:00Z' }, 'https://www.cnbc.com/2026/09/18/fed-cut.html')]) });
    web['https://www.theguardian.com/business/economics/rss'] = () => ({ status: 200, body: rss([item(bbc, 'https://www.theguardian.com/business/2026/sep/17/fed-rates'), item({ ...npr, at: '2026-09-18T05:30:00Z' }, 'https://www.theguardian.com/business/2026/sep/18/fed-again')]) });
    web['https://www.ft.com/rss/home/international'] = () => ({ status: 200, body: rss([item({ ...bbc, title: 'Federal Reserve cuts rates for the second time this year', at: '2026-09-18T05:40:00Z' }, 'https://www.ft.com/content/fed-cut')]) });
    await fetchAll();
    const again = ((await run('news.headlines', { topic: 'economy', untold: true, since: '2d' })) as HeadlinesOutput).stories.find((s) => s.id === fed!.id);
    expect(again?.status).toBe('update');
    const second = await run('news.mark_told', { storyIds: [fed!.id], edition: 'midday' });
    expect(second.marked).toEqual([{ id: fed!.id, wasUpdate: true }]);
    const detail = (await run('news.story', { id: fed!.id })) as StoryDetail;
    expect(detail.told.map((t) => [t.edition, t.wasUpdate])).toEqual([['morning', false], ['midday', true]]);
  });

  it('takes the owner\'s word: not interested, snooze, mute an outlet, mute a topic, and back', async () => {
    await seedFixtureTopic('economy');
    await fetchAll();
    const ids = async (input: object = { topic: 'economy' }) => ((await run('news.headlines', input)) as HeadlinesOutput).stories.map((s) => s.id);
    const [fed, apple] = await ids();
    await run('news.feedback', { storyId: apple, action: 'not_interested' });
    expect(await ids()).toEqual([fed]);
    expect(await run('news.story', { id: apple })).toMatchObject({ found: false });
    await run('news.feedback', { storyId: apple, action: 'clear' });
    expect(await ids()).toContain(apple);

    const snoozed = await run('news.feedback', { storyId: apple, action: 'snooze', hours: 2 });
    expect(snoozed.until).toBe(new Date(now.getTime() + 2 * 3600_000).toISOString());
    expect(await ids()).toEqual([fed]);
    now = new Date(now.getTime() + 3 * 3600_000);
    expect(await ids()).toContain(apple);

    // Muting an outlet is news.mute_outlet's, which asks the owner when an agent calls it.
    await expect(run('news.feedback', { outlet: 'Le Monde', action: 'mute' })).rejects.toThrow('news.mute_outlet');
    const muted = await run('news.mute_outlet', { outlet: 'Le Monde' }, asOwner);
    expect(muted).toMatchObject({ id: 'lemonde.fr', muted: true });
    const story = (await run('news.story', { id: fed })) as StoryDetail;
    expect(story.outlets).not.toContain('Le Monde');
    await run('news.feedback', { outlet: 'lemonde.fr', action: 'clear' });

    await run('news.feedback', { topic: 'Economy', action: 'mute' });
    expect(await ids({})).toEqual([]);
    await expect(run('news.feedback', { topic: 'economy', storyId: fed, action: 'mute' })).rejects.toThrow('Name exactly one');
    await run('news.feedback', { topic: 'economy', action: 'clear' });
    expect((await ids({})).length).toBe(2);
  });

  it('searches the articles kept, accents and case aside', async () => {
    await seedFixtureTopic('economy');
    await fetchAll();
    const hits = await run('news.search', { query: 'REDUIT taux' });
    expect(hits.articles.map((a: { outlet: string }) => a.outlet)).toEqual(['Le Figaro', 'Le Monde']);
    expect(hits.articles[0].storyId).toMatch(/^s_/);
    expect(hits.articles[0].meta).toContain('Le Figaro');
    expect((await run('news.search', { query: 'iPhone', topic: 'economy' })).articles).toHaveLength(1);
    expect((await run('news.search', { query: 'nothing like this' })).articles).toEqual([]);
  });

  it('links twins across topics, so a hide or a told-mark on one is on both, and shows a story once across topics', async () => {
    await seedFixtureTopic('economy');
    await run('news.add_topic', { name: 'Fed watch', keywords: ['Fed', 'Réserve fédérale'] }, asOwner);
    for (const id of ['nyt-economy', 'le-monde-economie', 'le-figaro-economie', 'guardian-economics']) {
      const { rows } = await pool.query(`select topic_id from news.topic_sources where source_id = $1`, [id]);
      await run('news.set_source', { id, topics: [...rows.map((r) => ({ topic: r.topic_id })), { topic: 'fed-watch', filter: 'keywords' }] }, asOwner);
    }
    await fetchAll();
    await fetchAll('fed-watch');
    const { rows } = await pool.query(`select id, topic_id, twin_of from news.stories where article_count >= 3 order by first_seen, id`);
    expect(rows.map((r) => r.topic_id).sort()).toEqual(['economy', 'fed-watch']);
    expect(rows.filter((r) => r.twin_of !== null)).toHaveLength(1);
    const all = ((await run('news.headlines', {})) as HeadlinesOutput).stories;
    expect(all.filter((s) => s.title.toLowerCase().includes('fed') || s.title.includes('Réserve'))).toHaveLength(1);
    await run('news.hide_story', { id: rows[0].id, action: 'not_interested' }, asOwner);
    const { rows: hidden } = await pool.query(`select hidden from news.stories where id = any($1)`, [rows.map((r) => r.id)]);
    expect(hidden.map((h) => h.hidden)).toEqual(['not_interested', 'not_interested']);
  });

  it('keeps an outlet\'s logo through the assets area, refreshes it weekly, and moves the ones 0.1.0 kept', async () => {
    await seedFixtureTopic('economy');
    await fetchAll();
    await fetchMissingLogos(host(), 1, noSleep, 'nytimes.com'); // the timer may have fetched it already
    const { rows } = await pool.query(`select logo_key, logo_fetched_at from news.outlets where id = 'nytimes.com'`);
    expect(rows[0].logo_key).toBe('nytimes.com');
    expect((await host().assets!.list()).map((a) => a.key)).toContain('nytimes.com');
    const story = ((await run('news.headlines', { topic: 'economy' })) as HeadlinesOutput).stories[0]!;
    const detail = (await run('news.story', { id: story.id })) as StoryDetail;
    expect(detail.sources.find((s) => s.outletId === 'nytimes.com')!.logo).toBe('nytimes.com');

    // A week on, it is asked again; a site that no longer answers keeps the logo it had.
    now = new Date(now.getTime() + 8 * 86_400_000);
    delete web['https://www.nytimes.com/touch.png'];
    requested.length = 0;
    await fetchMissingLogos(host(), 5, noSleep, 'nytimes.com');
    expect(requested).toContain('https://www.nytimes.com/');
    expect((await pool.query(`select logo_key from news.outlets where id = 'nytimes.com'`)).rows[0].logo_key).toBe('nytimes.com');

    // A WebP is refused by the area: the next candidate is tried.
    web['https://cnbc.com/'] = () => ({ status: 200, body: '<link rel="icon" href="/a.webp"><link rel="apple-touch-icon" href="/b.png">' });
    web['https://cnbc.com/a.webp'] = () => ({ status: 200, body: Buffer.concat([Buffer.from('RIFF'), Buffer.alloc(4), Buffer.from('WEBP'), Buffer.alloc(20)]) });
    web['https://cnbc.com/b.png'] = () => ({ status: 200, body: PNG });
    expect(await fetchMissingLogos(host(), 1, noSleep, 'cnbc.com')).toBe(1);

    // 0.1.0's rows are handed to the area once, then deleted.
    await pool.query(`insert into news.logos (key, mime, bytes, sha256, source_url) values ('lefigaro.fr', 'image/png', $1, 'x', 'https://www.lefigaro.fr/i.png')`, [PNG]);
    await pool.query(`update news.outlets set logo_key = 'lefigaro.fr' where id = 'lefigaro.fr'`);
    resetPoller();
    expect(await moveKeptLogos(host())).toBe(1);
    expect((await pool.query(`select count(*)::int as n from news.logos`)).rows[0].n).toBe(0);
    expect((await host().assets!.list()).map((a) => a.key)).toContain('lefigaro.fr');
  });

  it('drops one outlet\'s repeat and items older than three days, and forgets what is past the retention', async () => {
    await seedFixtureTopic('economy');
    web['https://www.lemonde.fr/economie/rss_full.xml'] = () => ({ status: 200, body: rss([
      item(lemonde, 'https://www.lemonde.fr/economie/article/a.html'),
      item(lemonde, 'https://www.lemonde.fr/economie/article/a-bis.html'),
      { title: 'Une vieille nouvelle', link: 'https://www.lemonde.fr/old.html', at: '2026-09-10T08:00:00Z' },
    ]) });
    await fetchAll();
    const { rows } = await pool.query(`select url from news.articles where outlet_id = 'lemonde.fr'`);
    expect(rows.map((r) => r.url)).toEqual(['https://www.lemonde.fr/economie/article/a.html']);

    now = new Date(now.getTime() + 31 * 86_400_000);
    resetPoller();
    web = {};
    await refresh(host(), { sleep: noSleep });
    const { rows: left } = await pool.query(`select (select count(*)::int from news.stories) as stories, (select count(*)::int from news.articles) as articles`);
    expect(left[0]).toEqual({ stories: 0, articles: 0 });
  });

  const query = (name: string, params: object = {}, over: Partial<CoreToolContext> = {}) =>
    manifest.queries!.find((q) => q.name === name)!.produce(params, ctx(over)) as Promise<any>;

  it('attributes a fallback excerpt to its own publisher rather than the headline publisher', async () => {
    await seedFixtureTopic('economy');
    await fetchAll();
    const { rows } = await pool.query(`select s.id, s.title_article_id, a.outlet_id as title_outlet from news.stories s join news.articles a on a.id = s.title_article_id where s.article_count > 1 limit 1`);
    const story = rows[0];
    const { rows: other } = await pool.query(`select a.id, coalesce(o.name, src.name) as outlet from news.article_topics t join news.articles a on a.id = t.article_id join news.sources src on src.id = a.source_id left join news.outlets o on o.id = a.outlet_id where t.story_id = $1 and a.outlet_id <> $2 limit 1`, [story.id, story.title_outlet]);
    await pool.query(`update news.articles set lead = 'A distinct fallback excerpt for attribution.' where id = $1`, [other[0].id]);
    await pool.query(`update news.stories set lead = 'A distinct fallback excerpt for attribution.' where id = $1`, [story.id]);
    const card = (await query('stories')).stories.find((row: { id: string }) => row.id === story.id);
    expect(card.titleAttribution).toMatch(/^Headline from /);
    expect(card.summaryAttribution).toBe(`Feed excerpt from ${other[0].outlet}`);
    expect(card.titleAttribution).not.toBe(`Headline from ${other[0].outlet}`);
  });

  it('draws the News page: the quiet line, chips, stories grouped by topic, and what an empty feed means', async () => {
    expect(await query('stories', {})).toMatchObject({ stories: [], state: 'none' });
    await seedFixtureTopic('economy');
    expect(await query('stories', {})).toMatchObject({ state: 'first' });
    await fetchAll();
    const view = await query('overview');
    expect(view.fetched).toMatch(/^Fetched at 00:00 from \d+ sources · next at \d\d:\d\d$/);
    expect(view.failing).toBeNull(); // a source is failing only after a day without an answer
    expect(view.failed).toBe(false);
    expect(view.anchor).toBe('anchor'); // a host with no roster says yes
    expect((await query('topics')).topics).toEqual([{ id: 'all', name: 'All' }, { id: 'economy', name: 'Economy' }]);
    const all = await query('stories', { topic: 'all', filter: 'all' });
    expect(all.state).toBe('ok');
    const fed = all.stories[0];
    expect(fed.group).toEqual({ id: 'economy', name: 'Economy' });
    expect(fed.outlets).toHaveLength(6);
    expect(fed.languages).toBe('EN · FR');
    expect(fed.ago).toMatch(/^\d+ h ago$/);
    expect(fed.sources[0].url).toMatch(/^https:\/\//);
    expect(fed.timeline[0].text).toMatch(/^Earliest collected coverage: /);
    expect(fed.mark).toBeUndefined();

    // Told in an edition: Told you on the card; Not yet told is then empty, with the way back.
    await run('news.edition_save', { edition: 'morning', storyIds: all.stories.map((st: { id: string }) => st.id), text: 'Morning edition' });
    const after = await query('stories', {});
    expect(after.stories[0].mark).toEqual({ kind: 'told', text: 'Told you · last night' });
    expect(after.stories[0].quiet).toBe(true);
    expect(await query('stories', { filter: 'untold' })).toMatchObject({ stories: [], state: 'told', emptyTitle: 'Anchor has told you all of this' });

    // A topic of the owner's with no source says so.
    await pool.query(`insert into news.topics (id, slug, name, keywords, position) values ('lyon', 'lyon', 'Lyon', '{Lyon}', 9)`);
    expect(await query('stories', { topic: 'lyon' })).toMatchObject({ state: 'nosources', emptyTitle: 'No sources for Lyon yet' });

    // Nothing answering for 40 minutes: the failed fetch instead of the quiet line.
    now = new Date(now.getTime() + 2 * 3600_000);
    await pool.query(`update news.sources set last_tried_at = $1`, [now]);
    expect(await query('overview')).toMatchObject({ failed: true, failedTitle: 'Couldn’t fetch at 02:00.', fetched: null });
  });

  it('runs the ways out of the page: Not interested and Undo, mute an outlet and back, quiet and mute a topic', async () => {
    await seedFixtureTopic('economy');
    await fetchAll();
    const ids = async () => (await query('stories', {})).stories.map((st: { id: string }) => st.id);
    const [fed, apple] = await ids();
    await run('news.hide_story', { id: apple, action: 'not_interested' }, asOwner);
    expect(await ids()).toEqual([fed]);
    await run('news.hide_story', { id: apple, action: 'undo' }, asOwner);
    expect(await ids()).toContain(apple);

    await run('news.mute_outlet', { outlet: 'cnbc.com', muted: true }, asOwner);
    expect(await ids()).toEqual([fed]);
    await run('news.mute_outlet', { outlet: 'cnbc.com', muted: false }, asOwner);
    expect(await ids()).toContain(apple);

    await run('news.set_topic', { topic: 'economy', mutedForHours: 168 }, asOwner);
    expect(await ids()).toEqual([]);
    expect((await query('topic_rows')).topics[0]).toMatchObject({ quiet: true, muted: false, line: expect.stringContaining('Quiet until') });
    await run('news.set_topic', { topic: 'economy', mutedForHours: 0 }, asOwner);
    await run('news.set_topic', { topic: 'economy', muted: true }, asOwner);
    expect((await query('topic_rows')).topics[0]).toMatchObject({ muted: true, line: expect.stringContaining('Muted') });
    expect((await query('topics')).topics.map((t: { id: string }) => t.id)).toEqual(['all']);
    await run('news.set_topic', { topic: 'economy', muted: false }, asOwner);
    expect((await ids()).length).toBe(2);
  });

  it('lists the sources per topic with their logos, health in words and the starter line; removes one from a topic', async () => {
    let settings = await query('news_settings');
    expect(settings.starterOff).toBe(true);
    await seedFixtureTopic('economy');
    now = new Date(now.getTime() + 25 * 3600_000);
    await fetchAll();
    resetPoller();
    now = new Date(now.getTime() + 25 * 3600_000);
    await fetchAll();
    settings = await query('news_settings');
    expect(settings.starterOff).toBe(false);
    expect(settings.starterLine).toMatch(/starter sources are not on/);
    const { sources } = await query('source_rows');
    const bloomberg = sources.find((r: { id: string }) => r.id === 'bloomberg-markets');
    expect(bloomberg).toMatchObject({ key: 'economy:bloomberg-markets', topic: 'Economy', lang: 'EN', tone: 'warning', failing: true });
    expect(bloomberg.problem).toMatch(/^Failing since .*: answered 500\.$/);
    expect(bloomberg.line).toMatch(/^bloomberg\.com · Paywalled · 0 stories this week$/);
    expect(sources.find((r: { id: string }) => r.id === 'les-echos')).toMatchObject({ lang: 'FR · Google News' });
    expect(sources[0].topicAside).toBe('12 sources');
    await run('news.remove_source', { id: 'bloomberg-markets', topic: 'economy' }, asOwner);
    expect((await pool.query(`select count(*)::int as n from news.sources where id = 'bloomberg-markets'`)).rows[0].n).toBe(0);
  });

  it('adds a source only once it answers a feed, and words as a Google News search', async () => {
    await seedFixtureTopic('economy');
    web['https://www.leprogres.fr/'] = () => ({ status: 200, body: '<html><head><link rel="alternate" type="application/rss+xml" href="/lyon/rss"></head></html>' });
    web['https://www.leprogres.fr/lyon/rss'] = () => ({ status: 200, body: rss([{ title: 'Le tram T10 ouvre lundi aux voyageurs', link: 'https://www.leprogres.fr/t10', at: '2026-09-17T20:00:00Z' }]) });
    const added = await run('news.add_feed', { address: 'www.leprogres.fr', topic: 'Economy' }, asOwner);
    expect(added.note).toMatch(/^Added .* \(English\), 1 articles\.$/);
    expect((await pool.query(`select url from news.sources where added_by = 'owner'`)).rows.map((r) => r.url)).toEqual(['https://www.leprogres.fr/lyon/rss']);
    await expect(run('news.add_feed', { address: 'https://nothing.example/feed', topic: 'economy' }, asOwner)).rejects.toThrow();
    expect((await pool.query(`select count(*)::int as n from news.sources where url like '%nothing.example%'`)).rows[0].n).toBe(0);
    web[gnewsUrl('Lyon tram when:2d', 'en')] = () => ({ status: 200, body: rss([{ title: 'Lyon opens a tram line', link: 'https://news.google.com/rss/articles/x', at: '2026-09-17T20:00:00Z' }]) });
    const search = await run('news.add_feed', { address: 'Lyon tram', topic: 'economy' }, asOwner);
    expect(search.note).toBe('Added the Google News search “Lyon tram” to Economy, 1 articles now.');
  });

  it('hands an edition its material untold first, records it, and keeps a quiet day', async () => {
    await seedFixtureTopic('economy');
    await run('news.set_settings', { voiceEditions: ['morning'] }, asOwner);
    // consent_for_run (host API 1.33): Speech may narrate an edition the owner chose, in that edition's run only.
    const consent = (tool: string, name: string, args: Record<string, unknown>) => manifest.exports!.consent_for_run!.produce({ tool, export: name, args }, ctx());
    expect(await consent('speech.say', 'edition_material', { edition: 'morning' })).toBe(true);
    expect(await consent('speech.say', 'edition_material', { edition: 'evening' })).toBe(false);
    expect(await consent('speech.transcribe', 'edition_material', { edition: 'morning' })).toBe(false);
    expect(await consent('speech.say', 'headlines', { edition: 'morning' })).toBe(false);
    expect(await consent('speech.say', 'edition_material', { edition: 'midnight' })).toBe(false);
    expect(await consent('speech.say', 'edition_material', {})).toBe(false);
    await fetchAll();
    const material = await run('news.edition_material', { edition: 'morning' });
    expect(material).toMatchObject({ edition: 'morning', language: 'en', voice: false, voiceOff: 'the Speech plugin is not installed', quietToday: false, lastEdition: null });
    expect(material.next).toBeNull();
    expect(material.timezone).toBeDefined();
    expect(material.localDate).toMatch(/^\d{4}-\d{2}-\d{2}$/);
    expect(material.topics.map((t: { topicId: string }) => t.topicId)).toEqual(['economy']);
    const [fed] = material.topics[0].stories;
    expect(fed.status).toBe('new');
    expect(fed.articles.length).toBeLessThanOrEqual(4);
    expect(new Set(fed.articles.map((a: { outlet: string }) => a.outlet)).size).toBe(fed.articles.length);
    expect(fed.outlets.find((o: { name: string }) => o.name === 'Reuters')).toMatchObject({ lean: 'center', kind: 'wire' });
    // The export answers the same, for a mission's context.
    expect(await manifest.exports!.edition_material!.produce({ edition: 'morning', next: '13:00' }, ctx())).toMatchObject({ next: { edition: 'midday', at: '13:00' } });

    const first = fed.articles[0];
    const text = [
      'Morning edition · Thu 17 Sep', 'One story. The Fed moved.', '', '### Economy', '',
      `**UPDATE · ${fed.title}**`, '', 'What is new since last night, in a sentence.', '',
      `*${first.outlet} and ${fed.outlets.length - 1} more* · [example.org](${first.url})`, '',
      '**A story the edition told from nowhere**', '', 'No link of ours.', '', '*Nobody* · [nobody.example](https://nobody.example/x)', '',
      '— Anchor · next at 12:30',
    ].join('\n');
    const saved = await run('news.edition_save', { edition: 'morning', storyIds: [fed.id, 's_none'], text });
    expect(saved).toMatchObject({ told: [{ id: fed.id, wasUpdate: false }], unknown: ['s_none'], link: `#/p/news/stories?edition=${saved.edition}` });
    const { rows } = await pool.query(`select kind, text, agent_id from news.editions`);
    expect(rows).toEqual([{ kind: 'morning', text, agent_id: 'anchor' }]);
    // The chat's edition card reads it back: Anchor's words, the told story's logos.
    const history = await run('news.editions', {});
    expect(history.total).toBe(1);
    expect(history.editions[0]).toMatchObject({ id: saved.edition, text });
    expect((await run('news.editions', { kind: 'evening' })).editions).toEqual([]);
    expect((await run('news.editions', { id: 'e_missing' })).editions).toEqual([]);
    // Playing one saved edition leads with its report's recording (host API 1.33 `attachments`); a list does not.
    expect(history.attachments).toBeUndefined();
    expect((await run('news.editions', { attachAudio: true })).attachments).toEqual([{ kind: 'audio', report: `#/p/news/stories?edition=${saved.edition}` }]);
    expect((await run('news.editions', { attachAudio: true, id: 'e_missing' })).attachments).toBeUndefined();
    const { edition } = await query('edition', { id: saved.edition });
    expect((await query('edition', { id: 'latest' })).edition.id).toBe(saved.edition);
    expect((await query('edition', { id: 'missing' })).edition).toBeNull();
    expect(edition).toMatchObject({ id: saved.edition, kind: 'morning', name: 'Morning edition', lede: 'One story. The Fed moved.', next: '12:30', text });
    expect(edition).toMatchObject({ report: `#/p/news/stories?edition=${saved.edition}`, foot: 'Next edition at 12:30. Tell me what to leave out, or mute anything from News.' });
    expect(edition.when).toMatch(/^Thu 17 Sep · \d{2}:\d{2}$/);
    expect(edition.groups).toHaveLength(1);
    const [told, stray] = edition.groups[0].stories;
    expect(edition.groups[0].topic).toBe('Economy');
    expect(told).toMatchObject({ storyId: fed.id, mark: 'update', title: fed.title, lead: 'What is new since last night, in a sentence.', outlet: first.outlet, more: fed.outlets.length - 1, link: { url: first.url, label: 'example.org' } });
    expect(told.logos[0].name).toBe(first.outlet);
    expect(told.logos.length).toBe(Math.min(3, fed.outlets.length));
    expect(stray).toMatchObject({ title: 'A story the edition told from nowhere', outlet: 'Nobody', logos: [{ name: 'Nobody' }] });
    expect(stray.storyId).toBeUndefined();
    // The card's ways out: the told story's topic and its mutable outlets; nothing for the stray.
    expect(told).toMatchObject({ topicId: 'economy', topicName: material.topics[0].topic });
    expect(told.mutable[0]).toMatchObject({ name: first.outlet });
    expect(told.mutable.length).toBeLessThanOrEqual(4);
    expect(stray.topicId).toBeUndefined();
    expect(stray.mutable).toBeUndefined();
    // …handed to the card as declared page actions, ids written in; none for the stray.
    expect(told.actions.map((a: { tool: string }) => a.tool)).toEqual([
      'news.hide_story', ...told.mutable.map(() => 'news.mute_outlet'), 'news.set_topic', 'news.set_topic',
    ]);
    expect(told.actions[0]).toMatchObject({
      label: 'Not interested', args: { id: { const: fed.id }, action: { const: 'not_interested' } },
      undo: { tool: 'news.hide_story', label: 'Undo', args: { id: { const: fed.id }, action: { const: 'undo' } } },
    });
    expect(stray.actions).toBeUndefined();
    expect(await query('edition', { id: 'e_gone' })).toEqual({ edition: null });
    const next = await run('news.edition_material', { edition: 'midday' });
    expect(next.alreadyTold.map((t: { id: string }) => t.id)).toContain(fed.id);
    expect(next.topics.flatMap((t: { stories: Array<{ id: string }> }) => t.stories.map((st) => st.id))).not.toContain(fed.id);

    const quiet = await run('news.quiet_today', {});
    expect(quiet.quietUntil).toBe('2026-09-18T22:00:00.000Z'); // 00:00 in Paris is already the 18th: until its midnight
    expect(await run('news.edition_material', { edition: 'evening' })).toMatchObject({ quietToday: true });
    now = new Date('2026-09-18T22:30:00Z');
    expect(await run('news.edition_material', { edition: 'morning' })).toMatchObject({ quietToday: false });
  });

  it('reads an article once, refuses a paywalled outlet and a page robots.txt closes', async () => {
    await seedFixtureTopic('economy');
    await fetchAll();
    const { rows } = await pool.query(`select a.id, a.url, a.outlet_id from news.articles a where a.outlet_id in ('lemonde.fr', 'lesechos.fr', 'theguardian.com') order by a.outlet_id`);
    const byOutlet = Object.fromEntries(rows.map((r) => [r.outlet_id, r]));
    const para = 'La Réserve fédérale a abaissé ses taux directeurs d’un quart de point mercredi, une première depuis des mois. '.repeat(3);
    web['https://www.lemonde.fr/robots.txt'] = () => ({ status: 200, body: 'User-agent: *\nDisallow: /private/' });
    web[byOutlet['lemonde.fr'].url] = () => ({ status: 200, body: `<article><p>${para}</p></article>` });
    const first = await run('news.read', { articleId: byOutlet['lemonde.fr'].id });
    expect(first).toMatchObject({ status: 'ok', outlet: 'Le Monde' });
    expect(first.text).toContain('Réserve fédérale');
    requested.length = 0;
    expect(await run('news.read', { articleId: byOutlet['lemonde.fr'].id })).toMatchObject({ status: 'ok' });
    expect(requested).toEqual([]); // kept: not fetched twice
    expect(await run('news.read', { articleId: byOutlet['lesechos.fr'].id })).toMatchObject({ status: 'refused', reason: expect.stringContaining('paywalled') });
    web['https://www.theguardian.com/robots.txt'] = () => ({ status: 200, body: 'User-agent: *\nDisallow: /business/' });
    expect(await run('news.read', { articleId: byOutlet['theguardian.com'].id })).toMatchObject({ status: 'refused', reason: expect.stringContaining('robots.txt') });
  });

  it('answers the Top stories widget: logos, five at medium, untold first, a placement\'s topics', async () => {
    const widget = manifest.widgets!.find((w) => w.id === 'news.top')!;
    expect(await widget.produce(ctx(), { size: 'small', settings: {} })).toMatchObject({ kind: 'text' });
    await seedFixtureTopic('economy');
    await fetchAll();
    await fetchMissingLogos(host(), 1, noSleep, 'nytimes.com');
    const small = (await widget.produce(ctx(), { size: 'small', settings: {} })) as any;
    expect(small).toMatchObject({ kind: 'list', wrap: true });
    expect(small.rows.length).toBe(2);
    expect(small.rows[0].side).toBeUndefined();
    const medium = (await widget.produce(ctx(), { size: 'medium', settings: { show: 'top' } })) as any;
    expect(medium.max).toBe(5);
    expect(medium.rows[0].side).toMatch(/^[\w ]+ · \d+ h$/);
    expect(medium.rows.some((r: { image?: { asset: string } }) => r.image?.asset === 'nytimes.com')).toBe(true);
    expect(medium.rows.every((r: { image?: { label?: string } }) => typeof r.image?.label === 'string')).toBe(true);
    await run('news.mark_told', { storyIds: [((await run('news.headlines', {})) as HeadlinesOutput).stories[0]!.id], edition: 'morning' });
    const untold = (await widget.produce(ctx(), { size: 'medium', settings: {} })) as any;
    expect(untold.rows[0].title).toBe('Apple unveils new iPhone with faster chip at September event');
    expect(await widget.produce(ctx(), { size: 'small', settings: { topics: ['nope'], show: 'untold' } })).toMatchObject({ kind: 'list' });
  });
  it('keeps deals out of editions, the widget and the News page but Deals, and swaps a Google News redirect for the outlet\'s link', async () => {
    const reuters = 'https://news.google.com/rss/articles/CBMiREUTERS1'; // as kept: tracking parameters stripped
    web['https://rss.nytimes.com/services/xml/rss/nyt/Economy.xml'] = () => ({
      status: 200,
      body: rss([
        item(cnbc, 'https://www.nytimes.com/2026/09/17/business/fed-cuts-rates.html?smid=rss'),
        { title: 'The best credit cards to get right now for travel rewards', link: 'https://www.nytimes.com/wirecutter/money/best-travel-cards/', lead: 'Our picks.', at: '2026-09-17T19:30:00Z' },
      ]),
    });
    web[reuters] = () => ({ status: 200, body: '<html><c-wiz><div data-n-a-ts="1791013716" data-n-a-sg="sig-1"></div></c-wiz></html>' });
    web['https://news.google.com/_/DotsSplashUi/data/batchexecute'] = () => ({
      status: 200,
      body: `)]}'\n\n[["wrb.fr","Fbv4je","[\\"garturlres\\",\\"https://www.reuters.com/business/fed-cuts-rates-2026-09-17/?utm_source=gn\\",1]",null,null,null,"generic"]]`,
    });
    await seedFixtureTopic('economy');
    await fetchAll();

    const kinds = (await pool.query(`select title, kind from news.articles where kind = 'deal'`)).rows;
    expect(kinds.map((r) => r.title)).toEqual(['The best credit cards to get right now for travel rewards']);
    const titles = (stories: Array<{ title: string }>): string[] => stories.map((x) => x.title);
    const headlines = (await run('news.headlines', {})) as HeadlinesOutput;
    expect(headlines.stories.some((x) => /credit cards/.test(x.title))).toBe(false);
    const material = await run('news.edition_material', { edition: 'morning' });
    expect(JSON.stringify(material)).not.toContain('credit cards');
    const widget = (await manifest.widgets!.find((w) => w.id === 'news.top')!.produce(ctx(), { size: 'medium', settings: {} })) as any;
    expect(JSON.stringify(widget)).not.toContain('credit cards');
    expect(titles((await storiesFor(host(), {})).stories)).not.toContain('The best credit cards to get right now for travel rewards');
    expect(titles((await storiesFor(host(), { filter: 'deals' })).stories)).toEqual(['The best credit cards to get right now for travel rewards']);

    const links = (await pool.query(`select o.name, a.url, a.link_state from news.articles a join news.outlets o on o.id = a.outlet_id where o.name in ('Reuters', 'Les Echos') order by o.name`)).rows;
    expect(links).toEqual([
      { name: 'Les Echos', url: 'https://news.google.com/rss/articles/CBMiECHOS1', link_state: 'unresolved' },
      { name: 'Reuters', url: 'https://www.reuters.com/business/fed-cuts-rates-2026-09-17', link_state: 'resolved' },
    ]);
    const fed = headlines.stories.find((x) => x.outlets.includes('Reuters'))!;
    const detail = (await run('news.story', { id: fed.id })) as StoryDetail;
    expect(detail.sources.find((x) => x.outlet === 'Reuters')?.url).toBe('https://www.reuters.com/business/fed-cuts-rates-2026-09-17');
    // Tried once: the next tick does not ask again.
    requested.length = 0;
    await fetchAll();
    expect(requested.filter((u) => u.startsWith('https://news.google.com/rss/articles/'))).toEqual([]);

    // An edition resolves its picks the timer has not reached yet.
    await pool.query(`update news.articles set url = $1, link_state = null where outlet_id = 'reuters.com'`, [reuters]);
    const again = await run('news.edition_material', { edition: 'midday' });
    const urls = again.topics.flatMap((t: { stories: Array<{ articles: Array<{ outlet: string; url: string }> }> }) => t.stories.flatMap((st) => st.articles));
    expect(urls.find((a: { outlet: string }) => a.outlet === 'Reuters')?.url).toBe('https://www.reuters.com/business/fed-cuts-rates-2026-09-17');
    expect((await pool.query(`select link_state from news.articles where outlet_id = 'reuters.com'`)).rows).toEqual([{ link_state: 'resolved' }]);
  }, 30_000); // the edition's own requests wait their turn at news.google.com, a second apart
  it('joins an open English story and its French twin made before 0.2.1, its told-mark with it', async () => {
    await seedFixtureTopic('economy');
    const [en, fr] = fx.crossLanguage[0]!;
    now = new Date('2026-10-03T08:00:00Z');
    const source = (await pool.query(`select id from news.sources limit 1`)).rows[0].id;
    for (const [i, f] of [en!, fr!].entries()) {
      await pool.query(
        `insert into news.articles (id, source_id, url_canonical, url, title, lead, language, published_at, title_hash, tokens, kind)
         values ($1, $2, $3, $3, $4, $5, $6, $7, $1, '{}', 'news')`,
        [`a${i}`, source, `https://example.com/${i}`, f.title, f.lead, f.lang, f.at],
      );
      await pool.query(`insert into news.stories (id, topic_id, first_seen, updated_at, title) values ($1, 'economy', $2, $2, $3)`, [`s${i}`, f.at, f.title]);
      await pool.query(`insert into news.article_topics (article_id, topic_id, story_id) values ($1, 'economy', $2)`, [`a${i}`, `s${i}`]);
    }
    await pool.query(`insert into news.editions (id, kind) values ('e1', 'morning')`);
    await pool.query(`insert into news.told (edition_id, story_id, told_at, article_count, outlet_count) values ('e1', 's1', $1, 1, 1)`, [now]);
    await pool.query(`update news.stories set last_told_at = $1 where id = 's1'`, [now]);
    const db = host().db;
    expect(await reclusterOpen(db as never, 'economy', now)).toBe(1);
    const left = (await pool.query(`select s.id, s.article_count, s.last_told_at is not null as told, (select count(*)::int from news.told t where t.story_id = s.id) as marks from news.stories s`)).rows;
    expect(left).toEqual([{ id: 's0', article_count: 2, told: true, marks: 1 }]);
    expect(await reclusterOpen(db as never, 'economy', now)).toBe(0);
  });

  it('splits an open story made by one shared name once, on the first tick after the rules change, keeping its told-mark', async () => {
    await seedFixtureTopic('togo-west-africa');
    now = new Date('2026-10-05T22:00:00Z');
    const source = (await pool.query(`select id from news.sources limit 1`)).rows[0].id;
    // The owner's screenshot: the match, the diaspora, the plastics bill, the
    // coast, the equipment and the tax meeting, one story titled after the tax meeting.
    await pool.query(`insert into news.stories (id, topic_id, first_seen, updated_at, title) values ('mix', 'togo-west-africa', $1, $2, $3)`, [fx.togoMix[2]!.at, fx.togoMix[1]!.at, fx.togoMix[6]!.title]);
    for (const [i, f] of fx.togoMix.entries()) {
      await pool.query(
        `insert into news.articles (id, source_id, url_canonical, url, title, lead, language, published_at, title_hash, tokens, kind)
         values ($1, $2, $3, $3, $4, $5, $6, $7, $1, '{}', 'news')`,
        [`t${i}`, source, `https://example.com/t${i}`, f.title, f.lead, f.lang, f.at],
      );
      await pool.query(`insert into news.article_topics (article_id, topic_id, story_id) values ($1, 'togo-west-africa', 'mix')`, [`t${i}`]);
    }
    await pool.query(`update news.stories set title_article_id = 't6' where id = 'mix'`);
    await pool.query(`insert into news.editions (id, kind) values ('e2', 'evening')`);
    await pool.query(`insert into news.told (edition_id, story_id, told_at, article_count, outlet_count) values ('e2', 'mix', $1, 8, 7)`, [now]);
    await pool.query(`update news.stories set last_told_at = $1 where id = 'mix'`, [now]);
    await pool.query(`update news.settings set cluster_rules = 1`);

    resetPoller();
    await refresh(host(), { topicId: 'togo-west-africa', sleep: noSleep });
    const stories = (await pool.query(
      `select s.id, s.title, s.article_count, (select count(*)::int from news.told t where t.story_id = s.id) as marks
         from news.stories s where s.topic_id = 'togo-west-africa' and s.article_count > 0 order by s.first_seen`,
    )).rows;
    expect(stories.length).toBeGreaterThanOrEqual(4);
    // The tax meeting keeps the id and the told-mark; its title and count are its own now.
    const kept = stories.find((x) => x.id === 'mix');
    expect(kept).toMatchObject({ article_count: 2, marks: 1 });
    expect(stories.filter((x) => x.id !== 'mix').every((x) => x.marks === 0)).toBe(true);
    expect((await pool.query(`select cluster_rules from news.settings`)).rows[0].cluster_rules).toBeGreaterThan(1);
    // Once: the next run changes nothing.
    expect(await reclusterOpen(host().db as never, 'togo-west-africa', now)).toBe(0);
  });
});
