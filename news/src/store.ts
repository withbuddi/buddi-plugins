/**
 * The `news` schema's writes: topics, outlets and sources; what a fetch
 * brought; grouping into stories; each source's health; told-marks; the
 * owner's feedback; retention. The reads tools, exports and pages share are
 * in `reads.ts`. Every statement names its tables with the schema, as
 * `ctx.buddi.db.query` sets no search_path.
 */
import { createHash, randomBytes } from 'node:crypto';
import type { BuddiHost } from '@buddi/core/plugin';
import { canonicalUrl, outletHost } from './canonical.js';
import { assignStories, likeness, WINDOW_MS, type ClusterArticle, type OpenStory } from './cluster.js';
import type { FetchedItem } from './fetch.js';
import { articleSequence, featuresOf, isNews, isOpinion, LEAD_MARK, normalise, stripOutletSuffix } from './text.js';
import { EVERY_SECONDS, STARTER_OUTLETS, STARTER_SOURCES, STARTER_TOPICS, starterSources, type Language, type SourceKind } from './starter.js';

type Db = BuddiHost['db'];
type Query = { query: Db['query'] };

export const MAX_BACKOFF_MS = 6 * 3600_000;
export const FAILING_AFTER_MS = 24 * 3600_000;
export const PAUSED_AFTER_MS = 7 * 86_400_000;
/** Items older than this are not kept: a machine that slept a week keeps the last three days. */
export const MAX_AGE_MS = 72 * 3600_000;
/** One outlet's same title within this long is a repeat. */
export const REPEAT_MS = 3 * 86_400_000;
export const TOLD_RETENTION_DAYS = 90;

export interface SourceRow {
  id: string;
  outlet_id: string | null;
  name: string;
  kind: SourceKind;
  url: string;
  final_url: string | null;
  language: Language;
  opinion: boolean;
  every_seconds: number;
  etag: string | null;
  last_modified: string | null;
  failures: number;
  state: 'ok' | 'failing' | 'paused';
  added_by: 'starter' | 'owner';
}

/** When to fetch next: the source's period (up to a tenth more, as jitter), doubled for each failure in a row, at most six hours. */
export function nextFetchAt(now: Date, everySeconds: number, failures: number, random: () => number = Math.random): Date {
  const base = Math.min(everySeconds * 1000 * 2 ** Math.min(failures, 10), Math.max(MAX_BACKOFF_MS, everySeconds * 1000));
  return new Date(now.getTime() + base + Math.floor(random() * everySeconds * 100));
}

/** A failing source's state: failing after a day, paused after a week. */
export function stateAfterFailure(failingSince: Date, now: Date): 'ok' | 'failing' | 'paused' {
  const for_ = now.getTime() - failingSince.getTime();
  return for_ >= PAUSED_AFTER_MS ? 'paused' : for_ >= FAILING_AFTER_MS ? 'failing' : 'ok';
}

export const slug = (text: string): string =>
  normalise(text).replace(/\./g, ' ').trim().replace(/\s+/g, '-').slice(0, 60) || 'topic';

const sha = (text: string): string => createHash('sha256').update(text).digest('hex');
const articleId = (canonical: string): string => `a_${sha(canonical.replace(/^http:/i, 'https:')).slice(0, 24)}`;
const newId = (prefix: string): string => `${prefix}_${randomBytes(8).toString('hex')}`;

/* ------------------------------------------------------------------ *
 * Topics, outlets, sources
 * ------------------------------------------------------------------ */

export async function ensureTopic(
  db: Query,
  topic: { id: string; name: string; keywords: string[]; builtin: boolean; languages: Language[]; position?: number },
): Promise<void> {
  await db.query(
    `insert into news.topics (id, slug, name, keywords, builtin, languages, position)
     values ($1, $1, $2, $3, $4, $5, coalesce($6, (select coalesce(max(position), 0) + 1 from news.topics)))
     on conflict (id) do nothing`,
    [topic.id, topic.name, topic.keywords, topic.builtin, topic.languages, topic.position ?? null],
  );
}

/** The outlet behind a domain, made on first sight. Answers its id, or null for no domain. */
export async function ensureOutlet(db: Query, domain: string, name: string, extra: { kind?: string; language?: Language; paywall?: boolean } = {}): Promise<string | null> {
  const d = domain.toLowerCase().replace(/^www\d?\./, '');
  if (!d || !/^[a-z0-9.-]+\.[a-z]{2,}$/.test(d)) return null;
  const starter = STARTER_OUTLETS.find((o) => o.domain === d);
  await db.query(
    `insert into news.outlets (id, name, domain, kind, language, paywall) values ($1, $2, $1, $3, $4, $5) on conflict (id) do nothing`,
    [d, starter?.name ?? (name || d), starter?.kind ?? extra.kind ?? null, starter?.language ?? extra.language ?? null, starter?.paywall ?? extra.paywall ?? false],
  );
  return d;
}

export async function addSourceRow(
  db: Query,
  s: { id: string; name: string; kind: SourceKind; url: string; language: Language; outletId: string | null; opinion?: boolean; addedBy: 'starter' | 'owner' },
  topics: Array<{ topic: string; filter?: 'keywords' }>,
  now: Date,
): Promise<boolean> {
  const { rowCount } = await db.query(
    `insert into news.sources (id, outlet_id, name, kind, url, language, opinion, every_seconds, added_by, next_at)
     values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10) on conflict do nothing`,
    [s.id, s.outletId, s.name, s.kind, s.url, s.language, s.opinion ?? false, EVERY_SECONDS[s.kind], s.addedBy, new Date(now.getTime() + Math.floor(Math.random() * 60_000))],
  );
  const { rows } = await db.query<{ id: string }>(`select id from news.sources where id = $1 or url = $2 limit 1`, [s.id, s.url]);
  const id = rows[0]?.id ?? s.id;
  for (const t of topics) {
    await db.query(
      `insert into news.topic_sources (topic_id, source_id, filter) values ($1, $2, $3) on conflict (topic_id, source_id) do update set filter = excluded.filter`,
      [t.topic, id, t.filter ?? 'none'],
    );
  }
  return (rowCount ?? 0) > 0;
}

/** Add the starter topics (all, or those named) with their verified sources and outlets. Idempotent. */
export async function enableStarter(db: Db, now: Date, only?: string[]): Promise<{ topics: string[]; sources: number }> {
  return db.transaction(async (tx) => {
    const wanted = STARTER_TOPICS.filter((t) => !only || only.length === 0 || only.includes(t.id));
    const ids = wanted.map((t) => t.id);
    for (const [position, t] of STARTER_TOPICS.entries()) {
      if (!ids.includes(t.id)) continue;
      await ensureTopic(tx, { id: t.id, name: t.name, keywords: t.keywords, builtin: true, languages: t.languages, position });
    }
    let sources = 0;
    for (const s of starterSources(ids)) {
      const outletId = s.outlet ? await ensureOutlet(tx, s.outlet, '') : null;
      const topics = s.topics.filter((t) => ids.includes(t.topic));
      if (await addSourceRow(tx, { id: s.id, name: s.name, kind: s.kind, url: s.url, language: s.language, outletId, ...(s.opinion ? { opinion: true } : {}), addedBy: 'starter' }, topics, now)) sources += 1;
    }
    // The outlets Google News site: searches name, so they have their kind and name before the first item.
    for (const o of STARTER_OUTLETS) {
      if (STARTER_SOURCES.some((s) => s.kind === 'gnews' && s.verified && s.url.includes(encodeURIComponent(`site:${o.domain}`).replace(/%20/g, '+')))) await ensureOutlet(tx, o.domain, o.name);
    }
    return { topics: wanted.map((t) => t.name), sources };
  });
}

/** A topic by id or name, ignoring case. */
export async function findTopic(db: Query, idOrName: string): Promise<{ id: string; name: string; keywords: string[] } | undefined> {
  const { rows } = await db.query<{ id: string; name: string; keywords: string[] }>(
    `select id, name, keywords from news.topics where id = $1 or lower(name) = lower($1) or id = $2 limit 1`,
    [idOrName.trim(), slug(idOrName)],
  );
  return rows[0];
}

/* ------------------------------------------------------------------ *
 * Health
 * ------------------------------------------------------------------ */

export async function recordSuccess(
  db: Query, source: Pick<SourceRow, 'id' | 'every_seconds'>, now: Date,
  update: { etag?: string; lastModified?: string; keepValidators?: boolean; finalUrl?: string } = {},
): Promise<void> {
  await db.query(
    `update news.sources set last_ok_at = $2, last_error = null, failures = 0, failing_since = null, state = 'ok', next_at = $3,
       etag = case when $6 then etag else $4 end, last_modified = case when $6 then last_modified else $5 end,
       final_url = coalesce($7, final_url)
     where id = $1`,
    [source.id, now, nextFetchAt(now, source.every_seconds, 0), update.etag ?? null, update.lastModified ?? null, update.keepValidators ?? false, update.finalUrl ?? null],
  );
}

/** A failure: one more in a row, the wait doubled (or what Retry-After asks), failing after a day, paused after a week. */
export async function recordFailure(db: Query, source: Pick<SourceRow, 'id' | 'every_seconds'>, now: Date, error: string, retryAfterMs?: number): Promise<'ok' | 'failing' | 'paused'> {
  const { rows } = await db.query<{ failures: number; failing_since: Date }>(
    `update news.sources set last_error = $3, failures = failures + 1, failing_since = coalesce(failing_since, $2)
     where id = $1 returning failures, failing_since`,
    [source.id, now, error.slice(0, 300)],
  );
  const row = rows[0];
  if (!row) return 'ok';
  const state = stateAfterFailure(row.failing_since, now);
  let next = nextFetchAt(now, source.every_seconds, row.failures);
  if (retryAfterMs !== undefined && now.getTime() + retryAfterMs > next.getTime()) next = new Date(now.getTime() + Math.min(retryAfterMs, 86_400_000));
  await db.query(`update news.sources set next_at = $2, state = $3 where id = $1`, [source.id, next, state]);
  return state;
}

/** Try a source again now (the source manager's Try again): resumes a paused one. */
export async function retrySource(db: Query, id: string, now: Date): Promise<boolean> {
  const { rowCount } = await db.query(`update news.sources set state = 'ok', next_at = $2, muted = false where id = $1`, [id, now]);
  return (rowCount ?? 0) > 0;
}

/* ------------------------------------------------------------------ *
 * Articles
 * ------------------------------------------------------------------ */

/** Whether a text mentions one of the keywords, accents and case aside, on word boundaries. */
export function matchesKeywords(text: string, keywords: string[]): boolean {
  const hay = ` ${normalise(text).replace(/\./g, ' ')} `;
  return keywords.some((k) => {
    const needle = normalise(k).replace(/\./g, ' ').trim();
    return needle.length > 0 && hay.includes(` ${needle} `);
  });
}

export interface TopicLink {
  topic_id: string;
  filter: 'none' | 'keywords';
  keywords: string[];
}

/**
 * Write a fetch's items for a source and link each to the source's topics (a
 * keywords-filtered link only when the article matches). An article another
 * source already brought keeps its row and gains the links. Answers how many
 * article–topic links are new.
 */
export async function ingest(db: Db, source: SourceRow, links: TopicLink[], items: FetchedItem[], now: Date): Promise<number> {
  let added = 0;
  for (const item of items) {
    const url = canonicalUrl(item.url);
    const aggregator = source.kind === 'gnews' || source.kind === 'hn' || source.kind === 'gdelt';
    const title = source.kind === 'gnews' ? stripOutletSuffix(item.title, item.outletName) : item.title;
    if (!title || !isNews(title, item.outletName)) continue;
    const published = item.publishedAt && item.publishedAt.getTime() <= now.getTime() + 10 * 60_000 ? item.publishedAt : now;
    if (now.getTime() - published.getTime() > MAX_AGE_MS) continue;
    // A lead that only repeats the title says nothing.
    const lead = item.summary && !normalise(item.summary).startsWith(normalise(title)) ? item.summary : '';
    const topics = links.filter((l) => l.filter === 'none' || matchesKeywords(`${title} ${lead}`, l.keywords));
    if (topics.length === 0) continue;

    const outletId = aggregator ? (item.outletHost ? await ensureOutlet(db, item.outletHost, item.outletName) : null) : source.outlet_id;
    const titleHash = sha(normalise(title));
    const id = articleId(url);
    const { rows: existing } = await db.query<{ id: string }>(
      `select id from news.articles where url_canonical = $1
       union all
       select id from news.articles where outlet_id = $2 and title_hash = $3 and published_at > $4 and url_canonical <> $1
       limit 1`,
      [url, outletId, titleHash, new Date(published.getTime() - REPEAT_MS)],
    );
    let articleRow = existing[0]?.id;
    if (!articleRow) {
      const sequence = articleSequence(title, lead);
      await db.query(
        `insert into news.articles (id, source_id, outlet_id, url_canonical, url, guid, title, lead, language, opinion, published_at, fetched_at, tokens, entities, title_hash, search)
         values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16)
         on conflict (url_canonical) do nothing`,
        [
          id, source.id, outletId, url, url, item.guid ?? null, title.slice(0, 500), lead, item.language,
          source.opinion || isOpinion(url, title, item.categories), published, now, sequence,
          [...new Set(sequence.filter((t) => t.startsWith('!')).map((t) => t.slice(1)))], titleHash, normalise(`${title} ${lead}`),
        ],
      );
      articleRow = id;
    }
    for (const t of topics) {
      const { rowCount } = await db.query(
        `insert into news.article_topics (article_id, topic_id) values ($1, $2) on conflict do nothing`,
        [articleRow, t.topic_id],
      );
      added += rowCount ?? 0;
    }
  }
  return added;
}

/* ------------------------------------------------------------------ *
 * Stories
 * ------------------------------------------------------------------ */

/**
 * Group a topic's unclustered articles into stories, against the stories
 * still open, then bring every touched story's title, counts and score up to
 * date, link twins in other topics, and bring back a snoozed story that got
 * news. One transaction per topic.
 */
export async function clusterTopic(db: Db, topicId: string, ownerLanguage?: string): Promise<{ assigned: number; created: number }> {
  return db.transaction(async (tx) => {
    await tx.query(`select pg_advisory_xact_lock(hashtext('news.cluster:' || $1))`, [topicId]);
    const { rows: fresh } = await tx.query<{ id: string; published_at: Date; tokens: string[] }>(
      `select a.id, a.published_at, a.tokens from news.article_topics at join news.articles a on a.id = at.article_id
        where at.topic_id = $1 and at.story_id is null order by a.published_at limit 3000`,
      [topicId],
    );
    if (fresh.length === 0) return { assigned: 0, created: 0 };
    const earliest = Math.min(...fresh.map((a) => a.published_at.getTime()));
    const { rows: members } = await tx.query<{ story_id: string; id: string; published_at: Date; tokens: string[] }>(
      `select at.story_id, a.id, a.published_at, a.tokens
         from news.stories s join news.article_topics at on at.story_id = s.id and at.topic_id = s.topic_id join news.articles a on a.id = at.article_id
        where s.topic_id = $1 and s.updated_at >= $2`,
      [topicId, new Date(earliest - WINDOW_MS)],
    );
    const open = new Map<string, OpenStory>();
    for (const m of members) {
      const story = open.get(m.story_id) ?? { id: m.story_id, updatedAt: m.published_at, members: [] };
      story.members.push({ id: m.id, publishedAt: m.published_at, sequence: m.tokens });
      if (m.published_at > story.updatedAt) story.updatedAt = m.published_at;
      open.set(m.story_id, story);
    }
    const incoming: ClusterArticle[] = fresh.map((a) => ({ id: a.id, publishedAt: a.published_at, sequence: a.tokens }));
    const { assignments, created } = assignStories(incoming, [...open.values()], () => newId('s'));
    for (const id of created) {
      const first = incoming.find((a) => assignments.get(a.id) === id)!;
      await tx.query(`insert into news.stories (id, topic_id, first_seen, updated_at) values ($1, $2, $3, $3)`, [id, topicId, first.publishedAt]);
    }
    const byStory = new Map<string, string[]>();
    for (const [article, story] of assignments) byStory.set(story, [...(byStory.get(story) ?? []), article]);
    for (const [story, ids] of byStory) {
      await tx.query(`update news.article_topics set story_id = $1 where topic_id = $2 and article_id = any($3)`, [story, topicId, ids]);
    }
    const touched = [...byStory.keys()];
    // A snoozed story that got news comes back.
    await tx.query(`update news.stories set hidden = null, snoozed_until = null where id = any($1) and hidden = 'snoozed' and not (id = any($2))`, [touched, created]);
    await refreshStories(tx, touched, ownerLanguage);
    await linkTwins(tx, touched);
    return { assigned: assignments.size, created: created.length };
  });
}

interface MemberRow {
  story_id: string; id: string; title: string; lead: string; language: string; tokens: string[]; published_at: Date; fetched_at: Date;
  outlet_id: string | null; source_id: string; source_kind: SourceKind; opinion: boolean; outlet_kind: string | null;
}

/** The ranking's parts that do not age (spec §4.5): outlets, diversity, damping. */
export function baseScore(members: Array<{ outlet: string; language: string; opinion: boolean; outletKind: string | null; sourceKind: SourceKind }>): number {
  const outlets = new Set(members.map((m) => m.outlet)).size;
  const languages = new Set(members.map((m) => m.language)).size;
  const kinds = new Set(members.map((m) => m.outletKind).filter(Boolean)).size;
  const diversity = (languages >= 2 ? 0.5 : 0) + (kinds >= 2 ? 0.5 : 0);
  let damp = 1;
  if (members.length > 0 && members.every((m) => m.opinion)) damp = 0.5;
  else if (outlets === 1 && members.every((m) => m.sourceKind === 'gdelt')) damp = 0.6;
  return (2 * Math.log2(1 + outlets) + diversity) * damp;
}

/**
 * Bring stories up to date with their articles. The title is the article
 * nearest the story's centre, in the owner's language when one is, from an
 * outlet's own feed before an aggregator's; ties go to the earliest.
 */
export async function refreshStories(tx: Query, storyIds: string[], ownerLanguage?: string): Promise<void> {
  if (storyIds.length === 0) return;
  const { rows } = await tx.query<MemberRow>(
    `select at.story_id, a.id, a.title, a.lead, a.language, a.tokens, a.published_at, a.fetched_at, a.outlet_id, a.source_id,
            src.kind as source_kind, a.opinion, o.kind as outlet_kind
       from news.article_topics at
       join news.stories s on s.id = at.story_id and s.topic_id = at.topic_id
       join news.articles a on a.id = at.article_id
       join news.sources src on src.id = a.source_id
       left join news.outlets o on o.id = a.outlet_id
      where at.story_id = any($1)`,
    [storyIds],
  );
  const byStory = new Map<string, MemberRow[]>();
  for (const r of rows) byStory.set(r.story_id, [...(byStory.get(r.story_id) ?? []), r]);
  for (const id of storyIds) {
    const members = byStory.get(id) ?? [];
    if (members.length === 0) {
      await tx.query(`delete from news.stories where id = $1`, [id]);
      continue;
    }
    const features = members.map((m) => featuresOf(m.tokens));
    const centrality = members.map((_, i) => members.length === 1 ? 1 : features.reduce((sum, f, j) => (i === j ? sum : sum + likeness(features[i]!, f)), 0) / (members.length - 1));
    const lang = ownerLanguage?.slice(0, 2);
    const ranked = members
      .map((m, i) => ({ m, i }))
      .sort((x, y) =>
        Number(y.m.language === lang) - Number(x.m.language === lang) ||
        Number(y.m.source_kind === 'rss' || y.m.source_kind === 'atom') - Number(x.m.source_kind === 'rss' || x.m.source_kind === 'atom') ||
        Number(x.m.opinion) - Number(y.m.opinion) ||
        centrality[y.i]! - centrality[x.i]! ||
        x.m.published_at.getTime() - y.m.published_at.getTime());
    const best = ranked[0]!.m;
    const lead = best.lead || ranked.find((r) => r.m.lead)?.m.lead || '';
    const counts = new Map<string, number>();
    for (const m of members) for (const t of new Set(m.tokens.filter((x) => x !== LEAD_MARK).map((x) => x.replace(/^!/, '')))) counts.set(t, (counts.get(t) ?? 0) + 1);
    const tokens = [...counts].sort((a, b) => b[1] - a[1]).slice(0, 60).map(([t]) => t);
    const score = baseScore(members.map((m) => ({ outlet: m.outlet_id ?? m.source_id, language: m.language, opinion: m.opinion, outletKind: m.outlet_kind, sourceKind: m.source_kind })));
    await tx.query(
      `update news.stories set title = $2, lead = $3, title_article_id = $4, languages = $5, first_seen = $6, updated_at = $7,
         article_count = $8, outlet_count = $9, tokens = $10, score = $11
       where id = $1`,
      [
        id, best.title, lead, best.id, [...new Set(members.map((m) => m.language))].sort(),
        new Date(Math.min(...members.map((m) => m.fetched_at.getTime()))), new Date(Math.max(...members.map((m) => m.published_at.getTime()))),
        members.length, new Set(members.map((m) => m.outlet_id ?? m.source_id)).size, tokens, score,
      ],
    );
  }
}

/** Stories in other topics sharing at least half their articles are twins: the newer points at the older. */
export async function linkTwins(tx: Query, storyIds: string[]): Promise<void> {
  if (storyIds.length === 0) return;
  const { rows } = await tx.query<{ a: string; b: string; shared: number; a_count: number; b_count: number; a_first: Date; b_first: Date; b_twin: string | null }>(
    `select m.story_id as a, o.story_id as b, count(*)::int as shared, sa.article_count as a_count, sb.article_count as b_count,
            sa.first_seen as a_first, sb.first_seen as b_first, sb.twin_of as b_twin
       from news.article_topics m
       join news.article_topics o on o.article_id = m.article_id and o.topic_id <> m.topic_id and o.story_id is not null
       join news.stories sa on sa.id = m.story_id
       join news.stories sb on sb.id = o.story_id
      where m.story_id = any($1)
      group by m.story_id, o.story_id, sa.article_count, sb.article_count, sa.first_seen, sb.first_seen, sb.twin_of`,
    [storyIds],
  );
  for (const r of rows) {
    if (r.shared * 2 < Math.min(r.a_count, r.b_count)) continue;
    const [newer, older] = r.a_first > r.b_first || (r.a_first.getTime() === r.b_first.getTime() && r.a > r.b) ? [r.a, r.b_twin ?? r.b] : [r.b, r.a];
    if (newer !== older) await tx.query(`update news.stories set twin_of = $2 where id = $1 and twin_of is null`, [newer, older]);
  }
}

/** These stories and their twins. */
export async function withTwins(db: Query, ids: string[]): Promise<string[]> {
  if (ids.length === 0) return [];
  const { rows } = await db.query<{ id: string }>(
    `select id from news.stories where id = any($1) or twin_of = any($1)
        or id in (select twin_of from news.stories where id = any($1) and twin_of is not null)
        or twin_of in (select twin_of from news.stories where id = any($1) and twin_of is not null)`,
    [ids],
  );
  return rows.map((r) => r.id);
}

/** Forget what is past the retention: stories and their articles after `retention_days`, editions and told-marks after 90 days. */
export async function prune(db: Db, now: Date): Promise<number> {
  const { rows } = await db.query<{ retention_days: number }>(`select retention_days from news.settings`);
  const cutoff = new Date(now.getTime() - (rows[0]?.retention_days ?? 30) * 86_400_000);
  await db.query(`delete from news.stories where updated_at < $1`, [cutoff]);
  const { rowCount } = await db.query(
    `delete from news.articles a where a.fetched_at < $1
       and not exists (select 1 from news.article_topics at where at.article_id = a.id and at.story_id is not null)`,
    [cutoff],
  );
  await db.query(`delete from news.editions where created_at < $1`, [new Date(now.getTime() - TOLD_RETENTION_DAYS * 86_400_000)]);
  await db.query(`update news.stories set hidden = null, snoozed_until = null where hidden = 'snoozed' and snoozed_until < $1`, [now]);
  await db.query(`update news.topics set muted_until = null where muted_until < $1`, [now]);
  return rowCount ?? 0;
}

/* ------------------------------------------------------------------ *
 * Told and feedback
 * ------------------------------------------------------------------ */

/**
 * Record that these stories were told in an edition (and their twins with
 * them): one `editions` row, one `told` row per story with its counts now,
 * an update when it had been told before. Answers what was marked.
 */
export async function markTold(
  db: Db, storyIds: string[], edition: { kind: string; agentId?: string; language?: string; text?: string }, now: Date,
): Promise<{ editionId: string; marked: Array<{ id: string; wasUpdate: boolean }> }> {
  return db.transaction(async (tx) => {
    const ids = await withTwins(tx, storyIds);
    const editionId = newId('e');
    await tx.query(
      `insert into news.editions (id, kind, agent_id, language, created_at, text, story_ids) values ($1, $2, $3, $4, $5, $6, $7)`,
      [editionId, edition.kind, edition.agentId ?? null, edition.language ?? null, now, edition.text ?? null, storyIds],
    );
    const { rows } = await tx.query<{ id: string; was_update: boolean }>(
      `insert into news.told (edition_id, story_id, told_at, article_count, outlet_count, was_update)
       select $1, s.id, $3, s.article_count, s.outlet_count, s.last_told_at is not null
         from news.stories s where s.id = any($2)
       returning story_id as id, was_update`,
      [editionId, ids, now],
    );
    await tx.query(`update news.stories set last_told_at = $2 where id = any($1)`, [ids, now]);
    return { editionId, marked: rows.filter((r) => storyIds.includes(r.id)).map((r) => ({ id: r.id, wasUpdate: r.was_update })) };
  });
}

/** Not interested in a story, snooze it until a time, or take either back; its twins with it. */
export async function hideStory(db: Query, id: string, hidden: 'not_interested' | 'snoozed' | null, until: Date | null): Promise<boolean> {
  const ids = await withTwins(db, [id]);
  if (ids.length === 0) return false;
  await db.query(`update news.stories set hidden = $2, snoozed_until = $3 where id = any($1)`, [ids, hidden, hidden === 'snoozed' ? until : null]);
  return true;
}

/** Mute a topic until a time (null takes it back; 'infinity' is for good). */
export async function muteTopic(db: Query, id: string, until: Date | 'infinity' | null): Promise<void> {
  await db.query(`update news.topics set muted_until = $2::timestamptz where id = $1`, [id, until === 'infinity' ? 'infinity' : until]);
}

/** An outlet by its domain or its name. */
export async function findOutlet(db: Query, outlet: string): Promise<{ id: string; name: string } | undefined> {
  const given = outlet.trim().toLowerCase().replace(/^https?:\/\//, '').replace(/\/.*$/, '').replace(/^www\./, '');
  const { rows } = await db.query<{ id: string; name: string }>(
    `select id, name from news.outlets where id = $1 or lower(name) = $2 or domain = $3 order by (id = $1) desc limit 1`,
    [given, outlet.trim().toLowerCase(), outletHost(`https://${given}`)],
  );
  return rows[0];
}

export async function muteOutlet(db: Query, id: string, muted: boolean): Promise<void> {
  await db.query(`update news.outlets set muted = $2 where id = $1`, [id, muted]);
}
