/**
 * The real meaning model, opt-in: set `NEWS_MEANING_DIR` to a directory
 * holding a downloaded model (`<dir>/meaning`, as Download leaves it under
 * the plugin's own; `isDownloaded` must say yes). It loads onnxruntime-node
 * and the tokenizer, embeds every fixture text, checks the vectors against
 * the recorded ones the other tests use, and clusters the Togo day by them.
 * Skipped otherwise: no test fetches 135 MB.
 */
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { assignStories, topicTerms } from './cluster.js';
import { articleText, dot, fromBytes } from './embed.js';
import { isDownloaded, loadEmbedder, MEANING_MODEL } from './meaning.js';
import { articleSequence } from './text.js';

const dir = process.env.NEWS_MEANING_DIR;
const suite = dir ? describe : describe.skip;

interface Fixture { lang: string; at: string; title: string; lead: string }
const fx = JSON.parse(readFileSync(new URL('./fixtures/stories.json', import.meta.url), 'utf8')) as Record<string, Fixture[] | Array<[Fixture, Fixture]>>;
const recorded = JSON.parse(readFileSync(new URL('./fixtures/vectors.json', import.meta.url), 'utf8')) as { model: string; vectors: Record<string, string> };

suite('the meaning model on this machine', () => {
  it('embeds the fixtures as recorded, and keeps the Togo day apart by them', async () => {
    expect(isDownloaded(dir!)).toBe(true);
    const embedder = await loadEmbedder(dir!);
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
