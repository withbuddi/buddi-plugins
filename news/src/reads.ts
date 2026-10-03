/**
 * The reads: topics, headlines, one story, a search, the sources' health.
 * Select only, so the same functions serve a tool, an export (on the
 * read-only pool) and a page query or a widget when they come. The owner's
 * word applies everywhere: a muted topic, outlet or source and a story not
 * wanted are left out, a snoozed one until its time.
 */
import type { BuddiHost } from '@buddi/core/plugin';
import { normalise } from './text.js';
import type { SourceKind } from './starter.js';

type Db = BuddiHost['db'];

/** Age halves the score's weight about every 5.5 hours (spec §4.5: e^(−age_h / 8)). */
export const AGE_SCALE_HOURS = 8;

export interface StorySummary {
  id: string;
  topic: string;
  topicId: string;
  title: string;
  /** The title article's lead, plain text. */
  lead: string;
  /** The best article to open: the owner's language first, an outlet's own page before a Google redirect. */
  url: string;
  outlet: string;
  outlets: string[];
  languages: string[];
  firstSeen: string;
  updatedAt: string;
  articles: number;
  /** `new`: never told; `update`: told, and a material update since; `told`: told, nothing that matters since. */
  status: 'new' | 'update' | 'told';
  lastToldAt: string | null;
  /** Every article is opinion. */
  opinion: boolean;
  score: number;
}

export interface StoryArticle {
  id: string;
  outlet: string;
  outletId: string | null;
  /** The outlet's logo, when there is one: GET /api/pages/news/logo?outlet=<id>. */
  logo: boolean;
  title: string;
  lead: string;
  url: string;
  language: string;
  publishedAt: string;
  opinion: boolean;
  paywall: boolean;
}

export interface StoryDetail extends StorySummary {
  sources: StoryArticle[];
  timeline: Array<{ at: string; outlet: string; title: string }>;
  told: Array<{ edition: string; at: string; wasUpdate: boolean }>;
}

export interface TopicSummary {
  id: string;
  name: string;
  builtin: boolean;
  keywords: string[];
  languages: string[];
  mutedUntil: string | null;
  sources: number;
  failing: number;
  stories24h: number;
  lastStoryAt: string | null;
}

const iso = (d: Date | string): string => (d instanceof Date ? d.toISOString() : new Date(d).toISOString());

export async function listTopics(db: Db, now: Date): Promise<TopicSummary[]> {
  const { rows } = await db.query<{
    id: string; name: string; builtin: boolean; keywords: string[]; languages: string[]; muted_until: Date | null;
    sources: number; failing: number; stories24h: number; last_story_at: Date | null;
  }>(
    `select t.id, t.name, t.builtin, t.keywords, t.languages, case when t.muted_until > $1 then t.muted_until end as muted_until,
            (select count(*)::int from news.topic_sources ts join news.sources s on s.id = ts.source_id where ts.topic_id = t.id and not s.muted) as sources,
            (select count(*)::int from news.topic_sources ts join news.sources s on s.id = ts.source_id where ts.topic_id = t.id and not s.muted and s.state <> 'ok') as failing,
            (select count(*)::int from news.stories s where s.topic_id = t.id and s.updated_at > $1::timestamptz - interval '24 hours') as "stories24h",
            (select max(updated_at) from news.stories s where s.topic_id = t.id) as last_story_at
       from news.topics t order by t.position, t.name`,
    [now],
  );
  return rows.map((r) => ({
    id: r.id, name: r.name, builtin: r.builtin, keywords: r.keywords, languages: r.languages,
    mutedUntil: r.muted_until ? (Number.isFinite(r.muted_until.getTime()) ? iso(r.muted_until) : 'infinity') : null,
    sources: r.sources, failing: r.failing, stories24h: r.stories24h, lastStoryAt: r.last_story_at ? iso(r.last_story_at) : null,
  }));
}

interface CandidateRow {
  id: string; topic_id: string; topic: string; title: string; lead: string; first_seen: Date; updated_at: Date;
  last_told_at: Date | null; twin_of: string | null; title_article_id: string | null;
}

interface ArticleRow {
  story_id: string; id: string; title: string; lead: string; url: string; language: string; published_at: Date; fetched_at: Date;
  opinion: boolean; outlet_id: string | null; outlet: string; outlet_kind: string | null; paywall: boolean; logo: boolean;
  source_id: string; source_kind: SourceKind;
}

/** The visible articles of these stories: sources and outlets not muted. */
async function visibleArticles(db: Db, storyIds: string[]): Promise<Map<string, ArticleRow[]>> {
  const out = new Map<string, ArticleRow[]>();
  if (storyIds.length === 0) return out;
  const { rows } = await db.query<ArticleRow>(
    `select at.story_id, a.id, a.title, a.lead, a.url, a.language, a.published_at, a.fetched_at, a.opinion, a.outlet_id,
            coalesce(o.name, src.name) as outlet, o.kind as outlet_kind, coalesce(o.paywall, false) as paywall,
            (o.logo_key is not null) as logo, a.source_id, src.kind as source_kind
       from news.article_topics at
       join news.stories s on s.id = at.story_id and s.topic_id = at.topic_id
       join news.articles a on a.id = at.article_id
       join news.sources src on src.id = a.source_id and not src.muted
       left join news.outlets o on o.id = a.outlet_id
      where at.story_id = any($1) and not coalesce(o.muted, false)
      order by a.published_at`,
    [storyIds],
  );
  for (const r of rows) out.set(r.story_id, [...(out.get(r.story_id) ?? []), r]);
  return out;
}

/** Word bigrams of a title, normalised. */
export function titleBigrams(title: string): Set<string> {
  const words = normalise(title).split(' ').filter((w) => w.length > 1);
  const out = new Set<string>();
  for (let i = 0; i + 1 < words.length; i++) out.add(`${words[i]} ${words[i + 1]}`);
  return out;
}

/**
 * Whether a told story has news worth telling again (spec §4.6): two or more
 * outlets since it was told, or a new article whose title shares less than
 * half its bigrams with every article told.
 */
export function materialUpdate(articles: Array<{ title: string; fetchedAt: Date; outlet: string }>, toldAt: Date, outletsWhenTold: number): boolean {
  const told = articles.filter((a) => a.fetchedAt <= toldAt);
  const since = articles.filter((a) => a.fetchedAt > toldAt);
  if (since.length === 0) return false;
  const outletsNow = new Set(articles.map((a) => a.outlet)).size;
  if (outletsNow - outletsWhenTold >= 2) return true;
  const toldBigrams = told.map((a) => titleBigrams(a.title));
  return since.some((a) => {
    const mine = titleBigrams(a.title);
    if (mine.size === 0) return false;
    return toldBigrams.every((t) => {
      let shared = 0;
      for (const b of mine) if (t.has(b)) shared += 1;
      return shared / mine.size < 0.5;
    });
  });
}

function summarise(c: CandidateRow, articles: ArticleRow[], lastTold: { outlets: number } | undefined, ownerLanguage: string | undefined, now: Date): StorySummary {
  const outletKey = (a: ArticleRow): string => a.outlet_id ?? a.source_id;
  const lang = ownerLanguage?.slice(0, 2);
  const best = [...articles].sort((x, y) =>
    Number(y.language === lang) - Number(x.language === lang) ||
    Number(y.source_kind !== 'gnews') - Number(x.source_kind !== 'gnews') ||
    Number(y.id === c.title_article_id) - Number(x.id === c.title_article_id))[0];
  const outlets = [...new Map(articles.map((a) => [outletKey(a), a.outlet])).values()];
  const languages = [...new Set(articles.map((a) => a.language))].sort();
  const kinds = new Set(articles.map((a) => a.outlet_kind).filter(Boolean)).size;
  const allOpinion = articles.every((a) => a.opinion);
  const gdeltOnly = outlets.length === 1 && articles.every((a) => a.source_kind === 'gdelt');
  const ageHours = Math.max(0, (now.getTime() - c.updated_at.getTime()) / 3600_000);
  const score = (2 * Math.log2(1 + outlets.length) + (languages.length >= 2 ? 0.5 : 0) + (kinds >= 2 ? 0.5 : 0)) *
    Math.exp(-ageHours / AGE_SCALE_HOURS) * (allOpinion ? 0.5 : gdeltOnly ? 0.6 : 1);
  const status: StorySummary['status'] = c.last_told_at === null ? 'new'
    : materialUpdate(articles.map((a) => ({ title: a.title, fetchedAt: a.fetched_at, outlet: outletKey(a) })), c.last_told_at, lastTold?.outlets ?? outlets.length) ? 'update' : 'told';
  return {
    id: c.id,
    topic: c.topic,
    topicId: c.topic_id,
    title: c.title,
    lead: c.lead,
    url: best?.url ?? '',
    outlet: best?.outlet ?? '',
    outlets,
    languages,
    firstSeen: iso(c.first_seen),
    updatedAt: iso(c.updated_at),
    articles: articles.length,
    status,
    lastToldAt: c.last_told_at ? iso(c.last_told_at) : null,
    opinion: allOpinion,
    score: Math.round(score * 1000) / 1000,
  };
}

/** The candidates' last told counts. */
async function lastToldCounts(db: Db, storyIds: string[]): Promise<Map<string, { outlets: number }>> {
  const out = new Map<string, { outlets: number }>();
  if (storyIds.length === 0) return out;
  const { rows } = await db.query<{ story_id: string; outlet_count: number }>(
    `select distinct on (story_id) story_id, outlet_count from news.told where story_id = any($1) order by story_id, told_at desc`,
    [storyIds],
  );
  for (const r of rows) out.set(r.story_id, { outlets: r.outlet_count });
  return out;
}

export interface HeadlinesQuery {
  topicId?: string;
  n: number;
  since?: Date;
  untold?: boolean;
  ownerLanguage?: string;
}

const CANDIDATES = `
  select s.id, s.topic_id, t.name as topic, s.title, s.lead, s.first_seen, s.updated_at, s.last_told_at, s.twin_of, s.title_article_id
    from news.stories s join news.topics t on t.id = s.topic_id
   where not (t.muted_until is not null and t.muted_until > $1)
     and (s.hidden is null or (s.hidden = 'snoozed' and s.snoozed_until <= $1))`;

/**
 * The stories that matter now, in rank order (spec §4.5): outlets, two
 * languages, two kinds of outlet, aged by e^(−hours / 8), opinion-only and a
 * lone GDELT find damped. `since` defaults to the last 24 hours; `untold`
 * keeps new stories and material updates. Across all topics a story shows
 * once even when it has a twin in another topic.
 */
export async function headlines(db: Db, now: Date, q: HeadlinesQuery): Promise<StorySummary[]> {
  const since = q.since ?? new Date(now.getTime() - 24 * 3600_000);
  const { rows } = await db.query<CandidateRow>(
    `${CANDIDATES} and s.updated_at >= $2 and ($3::text is null or s.topic_id = $3) order by s.score desc, s.updated_at desc limit 300`,
    [now, since, q.topicId ?? null],
  );
  const ids = rows.map((r) => r.id);
  const [articles, told] = await Promise.all([visibleArticles(db, ids), lastToldCounts(db, ids)]);
  const shown = new Set<string>();
  const out: StorySummary[] = [];
  const all = rows
    .filter((r) => (articles.get(r.id)?.length ?? 0) > 0)
    .map((r) => ({ r, s: summarise(r, articles.get(r.id)!, told.get(r.id), q.ownerLanguage, now) }))
    .filter(({ s }) => !q.untold || s.status !== 'told')
    .sort((a, b) => b.s.score - a.s.score || b.s.updatedAt.localeCompare(a.s.updatedAt));
  for (const { r, s } of all) {
    const family = r.twin_of ?? r.id;
    if (!q.topicId && shown.has(family)) continue;
    shown.add(family);
    out.push(s);
    if (out.length >= q.n) break;
  }
  return out;
}

/** One story with its articles, its timeline and when it was told. Undefined when there is none, or the owner turned it away. */
export async function story(db: Db, now: Date, id: string, ownerLanguage?: string): Promise<StoryDetail | undefined> {
  const { rows } = await db.query<CandidateRow>(`${CANDIDATES} and s.id = $2`, [now, id]);
  const row = rows[0];
  if (!row) return undefined;
  const [articles, toldCounts] = await Promise.all([visibleArticles(db, [id]), lastToldCounts(db, [id])]);
  const list = articles.get(id) ?? [];
  if (list.length === 0) return undefined;
  const { rows: told } = await db.query<{ kind: string; told_at: Date; was_update: boolean }>(
    `select e.kind, t.told_at, t.was_update from news.told t join news.editions e on e.id = t.edition_id where t.story_id = $1 order by t.told_at`,
    [id],
  );
  return {
    ...summarise(row, list, toldCounts.get(id), ownerLanguage, now),
    sources: list.map((a) => ({
      id: a.id, outlet: a.outlet, outletId: a.outlet_id, logo: a.logo, title: a.title, lead: a.lead, url: a.url, language: a.language,
      publishedAt: iso(a.published_at), opinion: a.opinion, paywall: a.paywall,
    })),
    timeline: list.map((a) => ({ at: iso(a.published_at), outlet: a.outlet, title: a.title })),
    told: told.map((t) => ({ edition: t.kind, at: iso(t.told_at), wasUpdate: t.was_update })),
  };
}

export interface SearchHit {
  articleId: string;
  storyId: string | null;
  topic: string | null;
  title: string;
  lead: string;
  outlet: string;
  url: string;
  language: string;
  publishedAt: string;
  opinion: boolean;
}

/** Articles whose title or lead holds every word of the query (case and accents aside), newest first. */
export async function search(db: Db, now: Date, q: { text: string; topicId?: string; days: number; n: number }): Promise<SearchHit[]> {
  const words = normalise(q.text).split(' ').filter((w) => w.length >= 2).slice(0, 8);
  if (words.length === 0) return [];
  const patterns = words.map((w) => `%${w.replace(/[\\%_]/g, (c) => `\\${c}`)}%`);
  const { rows } = await db.query<{
    id: string; story_id: string | null; topic: string | null; title: string; lead: string; outlet: string; url: string; language: string; published_at: Date; opinion: boolean;
  }>(
    `select distinct on (a.published_at, a.id) a.id, at.story_id, t.name as topic, a.title, a.lead, coalesce(o.name, src.name) as outlet, a.url, a.language, a.published_at, a.opinion
       from news.articles a
       join news.sources src on src.id = a.source_id and not src.muted
       left join news.outlets o on o.id = a.outlet_id
       left join news.article_topics at on at.article_id = a.id
       left join news.topics t on t.id = at.topic_id
       left join news.stories s on s.id = at.story_id
      where a.search like all ($1::text[]) and a.published_at >= $2
        and not coalesce(o.muted, false)
        and ($3::text is null or at.topic_id = $3)
        and (s.id is null or s.hidden is null or (s.hidden = 'snoozed' and s.snoozed_until <= $5))
      order by a.published_at desc, a.id
      limit $4`,
    [patterns, new Date(now.getTime() - q.days * 86_400_000), q.topicId ?? null, q.n, now],
  );
  return rows.map((r) => ({
    articleId: r.id, storyId: r.story_id, topic: r.topic, title: r.title, lead: r.lead, outlet: r.outlet, url: r.url, language: r.language,
    publishedAt: iso(r.published_at), opinion: r.opinion,
  }));
}

export interface SourceHealth {
  id: string;
  name: string;
  outlet: string | null;
  topics: string[];
  url: string;
  kind: string;
  language: string;
  addedBy: string;
  muted: boolean;
  paywall: boolean;
  logo: boolean;
  state: 'ok' | 'failing' | 'paused';
  lastOkAt: string | null;
  lastError: string | null;
  failingSince: string | null;
  failures: number;
  nextAt: string;
}

/** Every source with its health, for the source manager and `news.topics`. */
export async function sourceHealth(db: Db, topicId?: string): Promise<SourceHealth[]> {
  const { rows } = await db.query<{
    id: string; name: string; outlet: string | null; topics: string[]; url: string; final_url: string | null; kind: string; language: string; added_by: string;
    muted: boolean; paywall: boolean; logo: boolean; state: 'ok' | 'failing' | 'paused'; last_ok_at: Date | null; last_error: string | null;
    failing_since: Date | null; failures: number; next_at: Date;
  }>(
    `select s.id, s.name, o.name as outlet, coalesce(array_agg(ts.topic_id order by ts.topic_id) filter (where ts.topic_id is not null), '{}') as topics,
            s.url, s.final_url, s.kind, s.language, s.added_by, s.muted, coalesce(o.paywall, false) as paywall, (o.logo_key is not null) as logo,
            s.state, s.last_ok_at, s.last_error, s.failing_since, s.failures, s.next_at
       from news.sources s
       left join news.outlets o on o.id = s.outlet_id
       left join news.topic_sources ts on ts.source_id = s.id
      where ($1::text is null or exists (select 1 from news.topic_sources x where x.source_id = s.id and x.topic_id = $1))
      group by s.id, o.name, o.paywall, o.logo_key
      order by s.name`,
    [topicId ?? null],
  );
  return rows.map((r) => ({
    id: r.id, name: r.name, outlet: r.outlet, topics: r.topics, url: r.final_url ?? r.url, kind: r.kind, language: r.language, addedBy: r.added_by,
    muted: r.muted, paywall: r.paywall, logo: r.logo, state: r.state, lastOkAt: r.last_ok_at ? iso(r.last_ok_at) : null, lastError: r.last_error,
    failingSince: r.failing_since ? iso(r.failing_since) : null, failures: r.failures, nextAt: iso(r.next_at),
  }));
}
