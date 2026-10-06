/**
 * The real meaning model, opt-in: set `NEWS_MEANING_DATA` to a buddi data
 * directory where Download on Settings → News has left buddi's engine
 * (`runtimes/onnx/…`) and the model (`models/minilm-l12-multilingual-q8`).
 * It runs on buddi's own engine through core's runtimes area, loads the
 * tokenizer, embeds every fixture text, checks the vectors against the
 * recorded ones the other tests use, and clusters the Togo day by them.
 * Skipped otherwise: no test fetches 249 MB.
 *
 * Core's runtimes are not in `@buddi/core/plugin` or `@buddi/core/testing`, so
 * this opt-in test alone reaches them by the package's main entry, resolved
 * at run time; no other test, and no plugin code, does.
 */
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { assignStories, topicTerms } from './cluster.js';
import { articleText, dot, fromBytes } from './embed.js';
import { loadEmbedder, MEANING_MODEL, type MeaningHost } from './meaning.js';
import { articleSequence } from './text.js';

const data = process.env.NEWS_MEANING_DATA;
const suite = data ? describe : describe.skip;

/** The host's engine and shared models, as buddi binds them for this plugin, over `data`. */
async function realHost(): Promise<MeaningHost> {
  const main = ['@buddi', 'core'].join('/');
  const core = (await import(main)) as {
    configureRuntimes(c: { env: Record<string, string | undefined> }): void;
    onnxAreaOf(f: object): NonNullable<MeaningHost['onnx']>;
    modelsAreaOf(f: object): NonNullable<MeaningHost['models']>;
  };
  core.configureRuntimes({ env: { ...process.env, BUDDI_DATA_DIR: data } });
  const facts = { plugin: 'news', dir: () => data!, pool: () => { throw new Error('no cards in this test'); }, now: () => new Date() };
  return { onnx: core.onnxAreaOf(facts), models: core.modelsAreaOf(facts) };
}

interface Fixture { lang: string; at: string; title: string; lead: string }
const fx = JSON.parse(readFileSync(new URL('./fixtures/stories.json', import.meta.url), 'utf8')) as Record<string, Fixture[] | Array<[Fixture, Fixture]>>;
const recorded = JSON.parse(readFileSync(new URL('./fixtures/vectors.json', import.meta.url), 'utf8')) as { model: string; vectors: Record<string, string> };

suite('the meaning model on this machine', () => {
  it('embeds the fixtures as recorded, and keeps the Togo day apart by them', async () => {
    const host = await realHost();
    expect((await host.onnx!.state()).state).toBe('ready');
    const model = await host.models!.state(MEANING_MODEL.id);
    expect(model.state).toBe('ready');
    const embedder = await loadEmbedder(host, model.path!);
    expect(embedder.model).toBe(MEANING_MODEL.id);
    const texts = Object.keys(recorded.vectors);
    const vectors = await embedder.embed(texts);
    for (const [i, t] of texts.entries()) {
      expect(vectors[i]!).toHaveLength(MEANING_MODEL.dims);
      expect(dot(vectors[i]!, fromBytes(Buffer.from(recorded.vectors[t]!, 'base64')))).toBeGreaterThan(0.99);
    }
    const byText = new Map(texts.map((t, i) => [t, vectors[i]!]));
    const togo = (fx.togoMix as Fixture[]).map((f, i) => ({
      id: `t${i}`, publishedAt: new Date(f.at), sequence: articleSequence(f.title, f.lead), language: f.lang, vector: byText.get(articleText(f.title, f.lead))!,
    }));
    let n = 0;
    const { created } = assignStories(togo, [], () => `s${n++}`, topicTerms('Togo and West Africa'), byText.get('Togo and West Africa'));
    expect(created.length).toBeGreaterThanOrEqual(4);
  }, 60_000);
});
