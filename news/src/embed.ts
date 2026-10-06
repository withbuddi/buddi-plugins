/**
 * Articles into vectors, a few at a time: what the poller does each tick
 * once the meaning model is ready (`meaning.ts`), and the arithmetic the
 * clustering does with them (`cluster.ts`).
 *
 * An article's text is its title, then ". " and its lead when it has one. Its
 * vector is kept per article (`news.article_vectors`, with the model's id), a
 * topic's name's per topic (`news.topic_vectors`): the clustering takes the
 * topic's own direction out of every vector, as the word rules take the
 * topic's own words out ("Togo : …" in every headline of "Togo and West
 * Africa" says nothing about which story it is).
 *
 * Polling never waits for this: each tick embeds what it can within
 * `EMBED_BUDGET_MS`, at most `EMBED_PER_TICK` articles, newest first, in
 * batches of `EMBED_BATCH`; an article not embedded yet is clustered by its
 * words and embedded on a later tick.
 */
import type { BuddiHost } from '@buddi/core/plugin';
import { MAX_AGE_MS } from './store.js';

type Query = { query: BuddiHost['db']['query'] };

export interface Embedder {
  /** The model's id, stored with each vector. */
  model: string;
  /** One unit vector per text. */
  embed(texts: string[]): Promise<Float32Array[]>;
}

export const EMBED_BATCH = 16;
export const EMBED_PER_TICK = 128;
export const EMBED_BUDGET_MS = 4_000;

export function articleText(title: string, lead: string): string {
  const t = title.trim();
  const l = lead.trim();
  return l ? `${t}. ${l}` : t;
}

export function dot(a: Float32Array, b: Float32Array): number {
  let s = 0;
  for (let i = 0; i < a.length; i++) s += a[i]! * b[i]!;
  return s;
}

/** `v` without its component along the unit vector `t`, normalised again. */
export function without(v: Float32Array, t: Float32Array): Float32Array {
  const d = dot(v, t);
  const out = new Float32Array(v.length);
  let norm = 0;
  for (let i = 0; i < v.length; i++) {
    out[i] = v[i]! - d * t[i]!;
    norm += out[i]! * out[i]!;
  }
  norm = Math.sqrt(norm) || 1;
  for (let i = 0; i < out.length; i++) out[i]! /= norm;
  return out;
}

export function toBytes(v: Float32Array): Buffer {
  return Buffer.from(v.buffer, v.byteOffset, v.byteLength);
}

export function fromBytes(b: Buffer | Uint8Array): Float32Array {
  // A copy: the driver's buffer may not be aligned for a Float32Array.
  const copy = new Uint8Array(b.byteLength);
  copy.set(b);
  return new Float32Array(copy.buffer);
}

export interface EmbedReport {
  topics: number;
  articles: number;
  /** Stopped by the time budget with articles still waiting. */
  outOfTime: boolean;
}

/**
 * Embed the topics whose name has no vector yet, then the newest articles
 * without one, a batch at a time while a batch as long as the longest so far
 * still fits in the budget. `now` is the clock the budget is
 * read on (a test hands in its own).
 */
export async function embedPending(
  db: Query,
  embedder: Embedder,
  at: Date,
  options: { budgetMs?: number; max?: number; batch?: number; now?: () => number } = {},
): Promise<EmbedReport> {
  const now = options.now ?? Date.now;
  const started = now();
  const budget = options.budgetMs ?? EMBED_BUDGET_MS;
  const batch = options.batch ?? EMBED_BATCH;
  const report: EmbedReport = { topics: 0, articles: 0, outOfTime: false };
  // The longest batch so far: the next one starts only when one as long still fits in the budget.
  let longest = 0;
  const fits = (): boolean => now() - started + longest <= budget;
  const timed = async <T>(job: () => Promise<T>): Promise<T> => {
    const at = now();
    try {
      return await job();
    } finally {
      longest = Math.max(longest, now() - at);
    }
  };

  const { rows: topics } = await db.query<{ id: string; name: string }>(
    `select t.id, t.name from news.topics t
      where not exists (select 1 from news.topic_vectors v where v.topic_id = t.id and v.model = $1 and v.name = t.name)`,
    [embedder.model],
  );
  if (topics.length > 0 && !fits()) return { ...report, outOfTime: true };
  if (topics.length > 0) {
    const vectors = await timed(() => embedder.embed(topics.map((t) => t.name)));
    for (const [i, t] of topics.entries()) {
      await db.query(
        `insert into news.topic_vectors (topic_id, model, name, vector) values ($1, $2, $3, $4)
         on conflict (topic_id) do update set model = excluded.model, name = excluded.name, vector = excluded.vector`,
        [t.id, embedder.model, t.name, toBytes(vectors[i]!)],
      );
    }
    report.topics = topics.length;
  }

  const { rows: articles } = await db.query<{ id: string; title: string; lead: string }>(
    `select a.id, a.title, a.lead from news.articles a
      where a.published_at >= $2
        and not exists (select 1 from news.article_vectors v where v.article_id = a.id and v.model = $1)
      order by a.published_at desc, a.id limit $3`,
    [embedder.model, new Date(at.getTime() - MAX_AGE_MS), options.max ?? EMBED_PER_TICK],
  );
  for (let i = 0; i < articles.length; i += batch) {
    if (!fits()) {
      report.outOfTime = true;
      break;
    }
    const chunk = articles.slice(i, i + batch);
    const vectors = await timed(() => embedder.embed(chunk.map((a) => articleText(a.title, a.lead))));
    for (const [j, a] of chunk.entries()) {
      await db.query(
        `insert into news.article_vectors (article_id, model, vector) values ($1, $2, $3)
         on conflict (article_id) do update set model = excluded.model, vector = excluded.vector, created_at = now()`,
        [a.id, embedder.model, toBytes(vectors[j]!)],
      );
    }
    report.articles += chunk.length;
  }
  return report;
}
