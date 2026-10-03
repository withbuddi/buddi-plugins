/**
 * The whole path on a real Postgres with core migrated, through the host a
 * plugin is handed: the starter Economy sources fetched from a fake web
 * (conditional GETs, a failing source, Google News items naming outlets),
 * articles grouped into one story told by six outlets in two languages, the
 * reads and exports, told-marks and material updates, the owner's feedback,
 * twins across topics, logos, health, and retention. No socket is opened.
 * Skipped without `DATABASE_URL`.
 */
import { readFileSync } from 'node:fs';
import type { Pool } from 'pg';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import {
  configurePluginHost, createMemoryVault, createPluginHost, createPool, hostBindingOf, resetPluginHost, runMigrations, testDatabaseUrl,
  type CoreToolContext,
} from '@buddi/core/testing';
import type { BuddiHost, ToolDefinition } from '@buddi/core/plugin';
import { manifest } from './index.js';
import { fetchMissingLogos, refresh, resetPoller, fetchSourceDefinition } from './poller.js';
import { resetPoliteness } from './fetch.js';
import { gnewsUrl } from './starter.js';
import { FIRST_READ_NOTE, SETUP_NOTE } from './setup.js';
import type { HeadlinesOutput } from './tools.js';
import type { StoryDetail } from './reads.js';

const databaseUrl = await testDatabaseUrl();
const suite = databaseUrl ? describe : describe.skip;
const TEST_DB = `buddi_news_test_${process.pid}`;

interface Fixture { outlet: string; lang: string; at: string; title: string; lead: string }
const fx = JSON.parse(readFileSync(new URL('./fixtures/stories.json', import.meta.url), 'utf8')) as { fedCut: Fixture[] };
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
    configurePluginHost({ vault: createMemoryVault(), httpTransport: transport as never });
  }, 60_000);

  afterAll(async () => {
    resetPluginHost();
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

  it('says what to do first, then that it is reading, then is ready', async () => {
    const setup = manifest.setup!;
    expect(await setup.produce(ctx())).toEqual({ ready: false, note: SETUP_NOTE });
    expect(await run('news.headlines', {})).toEqual({ setUp: false, message: expect.stringContaining('No news topic yet') });
    const enabled = await run('news.enable_starter', { topics: ['economy'] }, asOwner);
    expect(enabled.topics).toEqual(['Economy']);
    expect(enabled.sources).toBe(12);
    expect(await setup.produce(ctx())).toEqual({ ready: false, note: FIRST_READ_NOTE });
    await fetchAll();
    expect(await setup.produce(ctx())).toEqual({ ready: true });
  });

  it('fetches on the timer only what is due, at most eight a tick', async () => {
    await run('news.enable_starter', { topics: ['economy'] }, asOwner);
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

  it('groups one story told by six outlets in English and French, and reads it back', async () => {
    await run('news.enable_starter', { topics: ['economy'] }, asOwner);
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
    expect(story.timeline.map((t) => t.outlet)).toEqual(['The New York Times', 'Reuters', 'The Guardian', 'Le Monde', 'Les Echos', 'Le Figaro']);
    expect(story.sources.find((s) => s.outlet === 'Le Monde')!.url).toBe('https://www.lemonde.fr/economie/article/2026/09/17/la-fed-abaisse-ses-taux.html');
    expect(story.sources.find((s) => s.outlet === 'Reuters')!.title).toBe(npr.title);
    expect(story.sources.find((s) => s.outlet === 'Les Echos')!.paywall).toBe(true);

    // The exports answer the same, for a plugin that requires this one.
    const exported = (await manifest.exports!.headlines!.produce({ topic: 'economy', n: 1 }, ctx())) as HeadlinesOutput;
    expect(exported.stories.map((s) => s.id)).toEqual([fed!.id]);
    expect(((await manifest.exports!.story!.produce({ id: fed!.id }, ctx())) as StoryDetail).sources).toHaveLength(6);
  });

  it('keeps each source\'s health: a failure counted, failing after a day, Try again; a 304 costs nothing', async () => {
    await run('news.enable_starter', { topics: ['economy'] }, asOwner);
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
    await run('news.enable_starter', { topics: ['economy'] }, asOwner);
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
    await run('news.enable_starter', { topics: ['economy'] }, asOwner);
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

    const muted = await run('news.feedback', { outlet: 'Le Monde', action: 'mute' });
    expect(muted).toMatchObject({ kind: 'outlet', subject: 'lemonde.fr', action: 'mute' });
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
    await run('news.enable_starter', { topics: ['economy'] }, asOwner);
    await fetchAll();
    const hits = await run('news.search', { query: 'REDUIT taux' });
    expect(hits.articles.map((a: { outlet: string }) => a.outlet)).toEqual(['Le Figaro', 'Le Monde']);
    expect(hits.articles[0].storyId).toMatch(/^s_/);
    expect((await run('news.search', { query: 'iPhone', topic: 'economy' })).articles).toHaveLength(1);
    expect((await run('news.search', { query: 'nothing like this' })).articles).toEqual([]);
  });

  it('links twins across topics, so a hide or a told-mark on one is on both, and shows a story once across topics', async () => {
    await run('news.enable_starter', { topics: ['economy'] }, asOwner);
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

  it('fetches an outlet\'s logo through its redirect and serves it as an image', async () => {
    await run('news.enable_starter', { topics: ['economy'] }, asOwner);
    await fetchAll();
    await fetchMissingLogos(host(), 1, noSleep, 'nytimes.com'); // the timer may have fetched it already
    const { rows } = await pool.query(`select logo_key from news.outlets where id = 'nytimes.com'`);
    expect(rows[0].logo_key).toBe('nytimes.com');
    const file = (await manifest.queries!.find((q) => q.name === 'logo')!.produce({ outlet: 'nytimes.com' }, ctx())) as { contentType: string; body: Buffer };
    expect(file.contentType).toBe('image/png');
    expect(Buffer.compare(file.body, PNG)).toBe(0);
    await expect(manifest.queries!.find((q) => q.name === 'logo')!.produce({ outlet: 'cnbc.com' }, ctx())).rejects.toThrow('no logo');
    const story = ((await run('news.headlines', { topic: 'economy' })) as HeadlinesOutput).stories[0]!;
    const detail = (await run('news.story', { id: story.id })) as StoryDetail;
    expect(detail.sources.find((s) => s.outletId === 'nytimes.com')!.logo).toBe(true);
  });

  it('drops one outlet\'s repeat and items older than three days, and forgets what is past the retention', async () => {
    await run('news.enable_starter', { topics: ['economy'] }, asOwner);
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
});
