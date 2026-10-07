/**
 * Clustering by meaning, with a fake embedder that answers the vectors the
 * real model gave these texts (`fixtures/vectors.json`, recorded with
 * `loadEmbedder`): the same fixtures as `cluster.test.ts` must hold with
 * vectors on, synthetic vectors walk the merge line and the band, and the
 * poller's step keeps to its time budget. No model runs here; the real one
 * is `meaning.real.test.ts`, opt-in.
 */
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import type { OnnxTensor } from '@buddi/core/plugin';
import { assignStories, matchStory, MEANING_BAND, MEANING_MERGE, topicTerms, type ClusterArticle } from './cluster.js';
import { articleText, embedPending, fromBytes, toBytes, type Embedder } from './embed.js';
import { loadEmbedder, Meaning, MEANING_MODEL, MEANING_REASON, modelRequest, type MeaningHost } from './meaning.js';
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
 * The model on buddi's engine: the host's states, the one card, the load
 * ------------------------------------------------------------------ */

type EngineState = 'absent' | 'downloading' | 'ready' | 'failed';

/** A host with buddi's engine and shared models (1.32), faked: what the settings line and the poller see. */
function fakeHost(folder = '/models/minilm-l12-multilingual-q8') {
  const calls: { ensure: unknown[]; sessions: Array<{ path: string; opts: unknown }>; feeds: Array<Record<string, OnnxTensor>> } = { ensure: [], sessions: [], feeds: [] };
  const world = {
    engine: 'absent' as EngineState,
    model: 'absent' as EngineState,
    engineReason: undefined as string | undefined,
    pending: undefined as string | undefined,
    received: 0,
  };
  const host: MeaningHost = {
    onnx: {
      async state() {
        return {
          state: world.engine, version: '1.30.0', sizeBytes: 45_000_000, downloadBytes: 114_000_000, platform: 'darwin-arm64', available: world.engine !== 'failed',
          ...(world.engineReason ? { reason: world.engineReason } : {}), ...(world.engine === 'downloading' ? { receivedBytes: world.received } : {}),
          ...(world.pending ? { pending: world.pending } : {}),
        };
      },
      async ensure(req) {
        calls.ensure.push(req);
        if (world.engine === 'absent' || world.model === 'absent') world.pending = 'card-1';
        return host.onnx!.state();
      },
      async createSession(modelPath, opts) {
        calls.sessions.push({ path: modelPath, opts });
        let loaded = false;
        return {
          async names() { return { inputs: ['input_ids', 'attention_mask', 'token_type_ids'], outputs: ['last_hidden_state'] }; },
          async run(feeds) {
            loaded = true;
            calls.feeds.push(feeds);
            // Hidden states: token t of every row is the unit vector on axis (id % 3), so pooling is checkable.
            const [rows, width] = feeds.input_ids!.dims;
            const ids = feeds.input_ids!.data as BigInt64Array;
            const hidden = new Float32Array(rows! * width! * 3);
            for (let i = 0; i < rows! * width!; i++) hidden[i * 3 + Number(ids[i]! % 3n)] = 1;
            return { last_hidden_state: { type: 'float32', data: hidden, dims: [rows!, width!, 3] } };
          },
          get loaded() { return loaded; },
          async close() {},
        };
      },
    },
    models: {
      async state(id) {
        return { id, state: world.model, sizeBytes: 135_391_535, ...(world.model === 'ready' ? { path: folder } : {}), ...(world.model === 'downloading' ? { receivedBytes: world.received } : {}) };
      },
      async ensure(req) {
        calls.ensure.push(req);
        return host.models!.state(req.id);
      },
    },
  };
  return { host, world, calls };
}

describe('the meaning model on buddi\'s engine', () => {
  const MODEL = MEANING_MODEL.files.reduce((n, f) => n + f.bytes, 0);

  it('asks for the engine and the model on one card, then follows the host: waiting, downloading, ready, loaded', async () => {
    const { host, world, calls } = fakeHost();
    let loads = 0;
    const meaning = new Meaning({ load: async (_h, folder) => { loads += 1; expect(folder).toBe('/models/minilm-l12-multilingual-q8'); return fixtureEmbedder; } });

    const absent = await meaning.state(host);
    expect(absent).toEqual({ state: 'absent', bytes: MODEL + 114_000_000 });
    expect(meaningRow(absent)).toMatchObject({ state: 'absent', action: 'Download (249 MB)', heading: 'Multilingual MiniLM · 135 MB', line: expect.stringMatching(/^Not downloaded.*with the engine buddi runs it on/) });
    expect(meaning.ready(host)).toBeUndefined();
    await meaning.settled();
    expect(loads).toBe(0);

    const asked = await meaning.start(host);
    expect(calls.ensure).toEqual([{ reason: MEANING_REASON, model: modelRequest() }]);
    expect(modelRequest().files.map((f) => f.name)).toEqual(['tokenizer_config.json', 'tokenizer.json', 'onnx/model_quantized.onnx']);
    expect(asked).toMatchObject({ state: 'absent', pending: 'card-1' });
    expect(meaningRow(asked)).toMatchObject({ state: 'waiting', approvalId: 'card-1', line: expect.stringMatching(/^Waiting for your answer/) });

    // The owner approves: buddi downloads the engine, then the model.
    world.pending = undefined;
    world.engine = 'downloading';
    world.received = 50_000_000;
    const downloading = await meaning.state(host);
    expect(downloading).toEqual({ state: 'downloading', bytes: 50_000_000, total: MODEL + 114_000_000 });
    expect(meaningRow(downloading)).toMatchObject({ line: 'Downloading: 50 of 249 MB.', bytes: 50_000_000, total: MODEL + 114_000_000 });

    world.engine = 'ready';
    world.model = 'downloading';
    world.received = 10_000_000;
    expect(await meaning.state(host)).toEqual({ state: 'downloading', bytes: 10_000_000, total: MODEL });

    world.model = 'ready';
    expect(await meaning.state(host)).toEqual({ state: 'ready', bytes: MODEL, loaded: false });
    expect(meaning.ready(host)).toBeUndefined(); // never waits
    await meaning.settled();
    expect(meaning.ready(host)).toBe(fixtureEmbedder);
    expect(await meaning.state(host)).toMatchObject({ state: 'ready', loaded: true });
    expect(loads).toBe(1);
    expect(meaningRow(await meaning.state(host)).done).toMatch(/stories cluster by meaning/);
  });

  it('asks for the model alone once the engine is here, and nothing once both are', async () => {
    const { host, world, calls } = fakeHost();
    world.engine = 'ready';
    const meaning = new Meaning({ load: async () => fixtureEmbedder });
    expect(await meaning.state(host)).toEqual({ state: 'absent', bytes: MODEL });
    expect(meaningRow(await meaning.state(host)).action).toBe('Download (135 MB)');
    world.model = 'ready';
    expect(await meaning.start(host)).toMatchObject({ state: 'ready' });
    await meaning.settled();
    expect(meaning.ready(host)).toBe(fixtureEmbedder);
    expect(calls.ensure).toHaveLength(1);
  });

  it('says why when the engine failed, when the load failed, and when this buddi has no engine', async () => {
    const { host, world } = fakeHost();
    world.engine = 'failed';
    world.engineReason = 'The engine is not available on this platform (win32-x64).';
    const meaning = new Meaning({ load: async () => fixtureEmbedder });
    const failed = await meaning.state(host);
    expect(failed).toMatchObject({ state: 'failed', reason: 'The engine is not available on this platform (win32-x64).' });
    expect(meaningRow(failed)).toMatchObject({ action: 'Try again', line: expect.stringMatching(/grouped by their words meanwhile/) });

    world.engine = 'ready';
    world.engineReason = undefined;
    world.model = 'ready';
    const broken = new Meaning({ load: async () => { throw new Error('the session would not open'); } });
    expect(broken.ready(host)).toBeUndefined();
    await broken.settled();
    expect(await broken.state(host)).toMatchObject({ state: 'failed', reason: 'The model did not load: the session would not open' });
    expect(broken.ready(host)).toBeUndefined();

    expect(await new Meaning().state({ onnx: undefined, models: undefined })).toMatchObject({ state: 'failed', reason: expect.stringMatching(/no engine for local models/) });
  });

  it('feeds the session int64 ids, mask and token types, and mean-pools and normalises what it answers', async () => {
    const folder = mkdtempSync(path.join(tmpdir(), 'news-meaning-'));
    try {
      writeFileSync(path.join(folder, 'tokenizer.json'), JSON.stringify({
        version: '1.0', truncation: null, padding: null, added_tokens: [], normalizer: null, pre_tokenizer: { type: 'Whitespace' }, post_processor: null, decoder: null,
        model: { type: 'WordLevel', vocab: { '[UNK]': 0, fed: 1, cuts: 2, rates: 3, togo: 4 }, unk_token: '[UNK]' },
      }));
      writeFileSync(path.join(folder, 'tokenizer_config.json'), '{}');
      const { host, calls } = fakeHost(folder);
      const embedder = await loadEmbedder(host, folder);
      expect(embedder.model).toBe(MEANING_MODEL.id);
      expect(calls.sessions).toEqual([{ path: path.join(folder, 'onnx/model_quantized.onnx'), opts: { threads: 2 } }]);
      expect(await embedder.embed([])).toEqual([]);
      const [a, b] = await embedder.embed(['fed cuts rates', 'togo']);
      const feeds = calls.feeds[0]!;
      expect(feeds.input_ids).toMatchObject({ type: 'int64', dims: [2, 3] });
      expect([...(feeds.input_ids!.data as BigInt64Array)]).toEqual([1n, 2n, 3n, 4n, 0n, 0n]);
      expect([...(feeds.attention_mask!.data as BigInt64Array)]).toEqual([1n, 1n, 1n, 1n, 0n, 0n]);
      expect(feeds.token_type_ids).toMatchObject({ type: 'int64', dims: [2, 3] });
      // ids 1, 2, 3 land on axes 1, 2, 0: their mean is (1,1,1)/3, normalised; the padding of row two is left out.
      expect([...a!].map((x) => +x.toFixed(4))).toEqual([0.5774, 0.5774, 0.5774]);
      expect([...b!]).toEqual([0, 1, 0]);
    } finally {
      rmSync(folder, { recursive: true, force: true });
    }
  });
});
