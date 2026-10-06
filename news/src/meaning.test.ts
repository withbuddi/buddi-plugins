/**
 * Clustering by meaning, with a fake embedder that answers the vectors the
 * real model gave these texts (`fixtures/vectors.json`, recorded with
 * `loadEmbedder`): the same fixtures as `cluster.test.ts` must hold with
 * vectors on, synthetic vectors walk the merge line and the band, and the
 * poller's step keeps to its time budget. No model runs here; the real one
 * is `meaning.real.test.ts`, opt-in.
 */
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { afterEach, describe, expect, it } from 'vitest';
import type { HttpArea, HttpRequest } from '@buddi/core/plugin';
import { assignStories, matchStory, MEANING_BAND, MEANING_MERGE, topicTerms, type ClusterArticle } from './cluster.js';
import { articleText, embedPending, fromBytes, toBytes, type Embedder } from './embed.js';
import { downloadModel, isDownloaded, Meaning, MEANING_MODEL, type MeaningModel } from './meaning.js';
import { meaningRow } from './settings.js';
import { articleSequence } from './text.js';

interface Fixture { outlet: string; lang: string; at: string; title: string; lead: string }
const fx = JSON.parse(readFileSync(new URL('./fixtures/stories.json', import.meta.url), 'utf8')) as {
  fedCut: Fixture[]; togoVote: Fixture[]; similarButDifferent: Array<[Fixture, Fixture]>;
  crossLanguage: Array<[Fixture, Fixture]>; crossLanguageApart: Array<[Fixture, Fixture]>;
  togoMix: Fixture[]; economyBudget: Fixture[];
};
const recorded = JSON.parse(readFileSync(new URL('./fixtures/vectors.json', import.meta.url), 'utf8')) as { model: string; vectors: Record<string, string> };

/** The fake embedder: the recorded vector of each text, and a refusal for a text it was not given. */
const fixtureEmbedder: Embedder = {
  model: recorded.model,
  async embed(texts) {
    return texts.map((t) => {
      const b64 = recorded.vectors[t];
      if (!b64) throw new Error(`no recorded vector for "${t}"`);
      return fromBytes(Buffer.from(b64, 'base64'));
    });
  },
};
const vectorOf = (text: string): Float32Array => fromBytes(Buffer.from(recorded.vectors[text]!, 'base64'));

const article = (f: Fixture, i: number, prefix: string, withVector = true): ClusterArticle => ({
  id: `${prefix}${i}`, publishedAt: new Date(f.at), sequence: articleSequence(f.title, f.lead), language: f.lang,
  ...(withVector ? { vector: vectorOf(articleText(f.title, f.lead)) } : {}),
});

let counter = 0;
const newId = (): string => `m${++counter}`;
const ECONOMY = { words: topicTerms('Economy'), vector: vectorOf('Economy') };
const TOGO = { words: topicTerms('Togo and West Africa'), vector: vectorOf('Togo and West Africa') };
const WORLD = { words: topicTerms('World'), vector: vectorOf('World') };

describe('clustering by meaning, on the fixtures', () => {
  it('records a vector for every fixture text, from the model in use', () => {
    expect(recorded.model).toBe(MEANING_MODEL.id);
    for (const f of Object.values(fx).flat(2) as Fixture[]) expect(recorded.vectors[articleText(f.title, f.lead)]).toBeTruthy();
  });

  it.each([['fedCut', ECONOMY], ['togoVote', TOGO], ['fedCut', WORLD], ['togoVote', WORLD]] as const)('puts one story told by six outlets in two languages together (%s)', (key, topic) => {
    const articles = fx[key].map((f, i) => article(f, i, key));
    const { created } = assignStories(articles, [], newId, topic.words, topic.vector);
    expect(created).toHaveLength(1);
    // And by meaning: the last one joins the other five on its vector.
    const [last, ...rest] = [...articles].reverse();
    expect(matchStory(last!, { id: 's', updatedAt: last!.publishedAt, members: rest }, topic.words, topic.vector)).toMatchObject({ joins: true, by: 'meaning' });
  });

  it('keeps the Fed and the Togo vote apart when both arrive in one fetch', () => {
    const mixed = [...fx.fedCut.map((f, i) => article(f, i, 'fed')), ...fx.togoVote.map((f, i) => article(f, i, 'togo'))];
    mixed.sort((a, b) => a.id.localeCompare(b.id));
    const { assignments, created } = assignStories(mixed, [], newId, WORLD.words, WORLD.vector);
    expect(created).toHaveLength(2);
    expect(assignments.get('fed0')).not.toBe(assignments.get('togo0'));
  });

  it.each(fx.similarButDifferent.map((p) => [p[0].title, p[1].title, p] as const))('keeps "%s" and "%s" apart: told in the same words, not the same story', (_a, _b, pair) => {
    const [a, b] = pair.map((f, i) => article(f, i, 'same'));
    expect(assignStories([a!, b!], [], newId, WORLD.words, WORLD.vector).created).toHaveLength(2);
    const match = matchStory(b!, { id: 's', updatedAt: a!.publishedAt, members: [a!] }, WORLD.words, WORLD.vector);
    expect(match.joins).toBe(false);
    expect(match.score).toBeLessThan(MEANING_MERGE);
  });

  it.each(fx.crossLanguage.map((p) => [p[0].title, p[1].title, p] as const))('puts "%s" and "%s" together across English and French', (_a, _b, pair) => {
    const [a, b] = pair.map((f, i) => article(f, i, 'x'));
    expect(assignStories([a!, b!], [], newId, WORLD.words, WORLD.vector).created).toHaveLength(1);
  });

  it.each(fx.crossLanguageApart.map((p) => [p[0].title, p[1].title, p] as const))('keeps "%s" and "%s" apart across English and French', (_a, _b, pair) => {
    const [a, b] = pair.map((f, i) => article(f, i, 'y'));
    expect(assignStories([a!, b!], [], newId, WORLD.words, WORLD.vector).created).toHaveLength(2);
  });

  it('keeps a Togo day apart: the match, the diaspora, the plastics bill, the coast, the equipment and the tax meeting', () => {
    const articles = fx.togoMix.map((f, i) => article(f, i, 'tm'));
    const { assignments, created } = assignStories(articles, [], newId, TOGO.words, TOGO.vector);
    const of = (i: number) => assignments.get(`tm${i}`)!;
    expect(created.length).toBeGreaterThanOrEqual(4);
    expect(of(6)).toBe(of(7)); // the tax meeting, in English and French
    expect(new Set([of(0), of(2), of(3), of(4), of(5), of(6)]).size).toBe(6);
    expect(of(1)).not.toBe(of(6));
  });

  it('needs the topic\'s direction out: with it left in, every "Togo : …" headline is alike', () => {
    const [diaspora, coast] = [fx.togoMix[2]!, fx.togoMix[4]!].map((f, i) => article(f, i, 'raw'));
    const story = { id: 's', updatedAt: diaspora!.publishedAt, members: [diaspora!] };
    // A topic vector of zeros takes nothing out.
    expect(matchStory(coast!, story, TOGO.words, new Float32Array(MEANING_MODEL.dims)).score).toBeGreaterThanOrEqual(MEANING_MERGE);
    expect(matchStory(coast!, story, TOGO.words, TOGO.vector).score).toBeLessThan(MEANING_MERGE);
  });

  it('keeps Malaysia\'s 2027 budget out of the French one', () => {
    const articles = fx.economyBudget.map((f, i) => article(f, i, 'eb'));
    const { assignments } = assignStories(articles, [], newId, ECONOMY.words, ECONOMY.vector);
    expect(assignments.get('eb0')).not.toBe(assignments.get('eb1'));
    expect(assignments.get('eb0')).not.toBe(assignments.get('eb2'));
  });

  it('joins a title alone to the story its title tells', () => {
    const full = fx.fedCut.map((f, i) => article(f, i, 'full'));
    const title = { id: 't', publishedAt: full[3]!.publishedAt, sequence: articleSequence(fx.fedCut[3]!.title, ''), vector: vectorOf(fx.fedCut[3]!.title) };
    const { created } = assignStories([...full.slice(0, 3), title, full[5]!], [], newId, ECONOMY.words, ECONOMY.vector);
    expect(created).toHaveLength(1);
  });
});

describe('the merge line and the band', () => {
  const DIMS = 8;
  const unit = (i: number): Float32Array => Object.assign(new Float32Array(DIMS), { [i]: 1 });
  /** A vector at cosine `c` from `unit(0)`, both away from the topic's `unit(7)`. */
  const at = (c: number): Float32Array => Object.assign(new Float32Array(DIMS), { 0: c, 1: Math.sqrt(1 - c * c) });
  const topic = unit(7);
  const when = new Date('2026-10-05T10:00:00Z');
  const story = (title: string, lead: string, vector: Float32Array) => ({
    id: 's', updatedAt: when, members: [{ id: 'a', publishedAt: when, sequence: articleSequence(title, lead), vector }],
  });
  const incoming = (title: string, lead: string, vector?: Float32Array): ClusterArticle => ({
    id: 'b', publishedAt: new Date(when.getTime() + 3600_000), sequence: articleSequence(title, lead), ...(vector ? { vector } : {}),
  });
  // Words the 0.2.4 rules join, and words they keep apart.
  const [fedA, fedB] = [fx.fedCut[0]!, fx.fedCut[1]!];
  const unrelated = ['Fed staff move to a new building', 'The Fed staff moved offices across town.'] as const;

  it('joins on meaning alone at the merge line, words or not', () => {
    const m = matchStory(incoming(...unrelated, at(MEANING_MERGE + 0.01)), story(fedA.title, fedA.lead, unit(0)), new Set(), topic);
    expect(m).toMatchObject({ joins: true, by: 'meaning' });
  });

  it('lets the words decide in the band: they join when the words agree, not otherwise', () => {
    const c = (MEANING_BAND + MEANING_MERGE) / 2;
    expect(matchStory(incoming(fedB.title, fedB.lead, at(c)), story(fedA.title, fedA.lead, unit(0)), new Set(), topic)).toMatchObject({ joins: true, by: 'band' });
    expect(matchStory(incoming(...unrelated, at(c)), story(fedA.title, fedA.lead, unit(0)), new Set(), topic)).toMatchObject({ joins: false, by: 'band' });
  });

  it('keeps apart below the band, even when the words would join', () => {
    expect(matchStory(incoming(fedB.title, fedB.lead, at(MEANING_BAND - 0.05)), story(fedA.title, fedA.lead, unit(0)), new Set(), topic)).toMatchObject({ joins: false, by: 'meaning' });
  });

  it('keeps the rules that forbid: two articles naming different things never join, however alike their vectors', () => {
    const [apple, google] = fx.similarButDifferent[0]!;
    expect(matchStory(incoming(google.title, google.lead, at(0.99)), story(apple.title, apple.lead, unit(0)), new Set(), topic).joins).toBe(false);
  });

  it('decides by words alone without the topic\'s vector, or when the article has none', () => {
    const words = matchStory(incoming(fedB.title, fedB.lead), story(fedA.title, fedA.lead, unit(0)), new Set());
    expect(words.by).toBe('words');
    expect(matchStory(incoming(fedB.title, fedB.lead, at(0.1)), story(fedA.title, fedA.lead, unit(0)), new Set())).toEqual(words);
    expect(matchStory(incoming(fedB.title, fedB.lead), story(fedA.title, fedA.lead, unit(0)), new Set(), topic)).toEqual(words);
  });

  it('lets the words decide for an article that says little besides the topic', () => {
    const nearTopic = Object.assign(new Float32Array(DIMS), { 7: 0.99, 0: Math.sqrt(1 - 0.99 * 0.99) });
    expect(matchStory(incoming(fedB.title, fedB.lead, nearTopic), story(fedA.title, fedA.lead, unit(0)), new Set(), topic)).toMatchObject({ joins: true, by: 'words' });
  });

  it('groups exactly as 0.2.4 with no model: no vectors, no topic vector', () => {
    const plain = fx.togoMix.map((f, i) => article(f, i, 'p', false));
    let a = 0;
    let b = 0;
    const withVectorsButNoTopic = assignStories(fx.togoMix.map((f, i) => article(f, i, 'p')), [], () => `x${a++}`, TOGO.words);
    const words = assignStories(plain, [], () => `x${b++}`, TOGO.words);
    expect([...withVectorsButNoTopic.assignments]).toEqual([...words.assignments]);
    expect(words.created.length).toBeGreaterThanOrEqual(4);
  });
});

/* ------------------------------------------------------------------ *
 * The poller's step, on a fake database
 * ------------------------------------------------------------------ */

function fakeDb(articles: Array<{ id: string; title: string; lead: string }>, topics: Array<{ id: string; name: string }> = []) {
  const vectors = new Map<string, Buffer>();
  const topicVectors = new Map<string, Buffer>();
  return {
    vectors,
    topicVectors,
    async query<R>(sql: string, params: unknown[] = []): Promise<{ rows: R[]; rowCount: number }> {
      if (sql.includes('from news.topics t')) return { rows: topics.filter((t) => !topicVectors.has(t.id)) as R[], rowCount: 0 };
      if (sql.includes('from news.articles a')) {
        const rows = articles.filter((a) => !vectors.has(a.id)).slice(0, params[2] as number);
        return { rows: rows as R[], rowCount: rows.length };
      }
      if (sql.includes('insert into news.article_vectors')) vectors.set(params[0] as string, params[2] as Buffer);
      if (sql.includes('insert into news.topic_vectors')) topicVectors.set(params[0] as string, params[3] as Buffer);
      return { rows: [], rowCount: 1 };
    },
  };
}

describe('embedding in the poller', () => {
  const many = Array.from({ length: 100 }, (_, i) => ({ id: `a${i}`, title: `Headline ${i}`, lead: i % 2 ? `Lead ${i}` : '' }));

  it('stops at its time budget and leaves the rest for a later tick', async () => {
    let clock = 0;
    const texts: string[] = [];
    const slow: Embedder = {
      model: 'fake',
      async embed(batch) {
        texts.push(...batch);
        clock += 1_000; // a second a batch
        return batch.map(() => new Float32Array([1, 0]));
      },
    };
    const db = fakeDb(many, [{ id: 't', name: 'Economy' }]);
    const report = await embedPending(db, slow, new Date(), { budgetMs: 3_000, batch: 10, now: () => clock });
    // The topic's name (one call), then batches until three seconds have gone.
    expect(report).toEqual({ topics: 1, articles: 20, outOfTime: true });
    expect(db.vectors.size).toBe(20);
    expect(texts).toContain('Headline 1. Lead 1');
    expect(texts).toContain('Headline 0');
    // The next tick carries on where it stopped.
    clock = 0;
    const next = await embedPending(db, slow, new Date(), { budgetMs: 3_000, batch: 10, now: () => clock });
    expect(next.topics).toBe(0);
    expect(db.vectors.size).toBe(50);
  });

  it('does not start a batch that would run past the budget when the last one was slow', async () => {
    let clock = 0;
    const lumpy: Embedder = { model: 'fake', async embed(batch) { clock += 2_500; return batch.map(() => new Float32Array([1, 0])); } };
    const db = fakeDb(many);
    expect(await embedPending(db, lumpy, new Date(), { budgetMs: 3_000, batch: 10, now: () => clock })).toEqual({ topics: 0, articles: 10, outOfTime: true });
    expect(clock).toBe(2_500);
  });

  it('embeds at most its share a tick when the model is quick, and round-trips each vector', async () => {
    const quick: Embedder = { model: 'fake', embed: async (batch) => batch.map((_, i) => new Float32Array([i, 0.5, -1])) };
    const db = fakeDb(many);
    const report = await embedPending(db, quick, new Date(), { max: 40, batch: 16, now: () => 0 });
    expect(report).toEqual({ topics: 0, articles: 40, outOfTime: false });
    expect([...fromBytes(db.vectors.get('a1')!)]).toEqual([1, 0.5, -1]);
    expect([...fromBytes(toBytes(new Float32Array([0.25, -2])))]).toEqual([0.25, -2]);
  });
});

/* ------------------------------------------------------------------ *
 * The model's download and its state
 * ------------------------------------------------------------------ */

describe('the meaning model', () => {
  const dirs: string[] = [];
  afterEach(() => {
    for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
  });
  const tempDir = (): string => {
    const d = mkdtempSync(path.join(tmpdir(), 'news-meaning-'));
    dirs.push(d);
    return d;
  };
  const bodies: Record<string, Buffer> = { 'tokenizer.json': Buffer.from('{"tok":1}'), 'onnx/model_quantized.onnx': Buffer.from('ONNX-BYTES') };
  const tiny: MeaningModel = {
    ...MEANING_MODEL,
    files: Object.entries(bodies).map(([p, b]) => ({ path: p, url: `https://huggingface.co/x/resolve/c/${p}`, bytes: b.length, sha256: createHash('sha256').update(b).digest('hex') })),
  };
  const fakeHttp = (asked: string[], tamper = false): HttpArea => ({
    async request(req: HttpRequest) {
      asked.push(req.url);
      const url = new URL(req.url);
      if (url.host === 'huggingface.co') {
        return { ok: false, status: 302, statusText: '', headers: { get: (n: string) => (n === 'location' ? `https://us.aws.cdn.hf.co${url.pathname}` : null) }, text: async () => '', json: async () => ({}), arrayBuffer: async () => new ArrayBuffer(0) };
      }
      const file = url.pathname.replace('/x/resolve/c/', '');
      const body = tamper ? Buffer.from('something else') : bodies[file]!;
      return { ok: true, status: 200, statusText: '', headers: { get: () => null }, text: async () => '', json: async () => ({}), arrayBuffer: async () => body.buffer.slice(body.byteOffset, body.byteOffset + body.byteLength) as ArrayBuffer };
    },
  });

  it('fetches each pinned file through the redirect, checks it, and puts the model in place', async () => {
    const dir = tempDir();
    const asked: string[] = [];
    await downloadModel(dir, fakeHttp(asked), () => {}, tiny);
    expect(isDownloaded(dir, tiny)).toBe(true);
    expect(asked.filter((u) => u.includes('cdn.hf.co'))).toHaveLength(2);
  });

  it('keeps nothing when a file does not match its checksum', async () => {
    const dir = tempDir();
    await expect(downloadModel(dir, fakeHttp([], true), () => {}, tiny)).rejects.toThrow(/did not match its checksum/);
    expect(isDownloaded(dir, tiny)).toBe(false);
  });

  it('says where it stands for the settings line: not downloaded, downloading, ready, failed', async () => {
    const dir = tempDir();
    let loads = 0;
    const meaning = new Meaning(dir, { model: tiny, load: async () => { loads += 1; return fixtureEmbedder; } });
    expect(meaning.state().state).toBe('absent');
    expect(meaningRow(meaning.state())).toMatchObject({ action: 'Download (1 MB)', line: expect.stringMatching(/^Not downloaded/) });
    expect(meaning.ready()).toBeUndefined();
    expect(meaning.start(fakeHttp([])).state).toBe('downloading');
    while (meaning.busy) await new Promise((r) => setTimeout(r, 5));
    expect(meaning.state()).toMatchObject({ state: 'ready', loaded: true });
    expect(meaning.ready()).toBe(fixtureEmbedder);
    expect(loads).toBe(1);
    expect(meaningRow(meaning.state()).done).toMatch(/stories cluster by meaning/);

    const broken = new Meaning(dir, { model: tiny, load: async () => { throw new Error('no ONNX Runtime for this CPU'); } });
    expect(broken.ready()).toBeUndefined(); // never waits
    await broken.settled();
    expect(broken.state()).toMatchObject({ state: 'failed', reason: 'The model did not load: no ONNX Runtime for this CPU' });
    expect(broken.ready()).toBeUndefined();
    expect(meaningRow(broken.state())).toMatchObject({ action: 'Try again' });
  });
});
