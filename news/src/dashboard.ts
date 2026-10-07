/**
 * The dashboard (spec §7, the kit's News.jsx): the News page on the rail,
 * the source manager on Settings → News, and the reads both draw from. Every
 * value is text written here in the owner's words and zone; logos are keys of
 * this plugin's assets, which buddi serves (host API 1.27). Queries only
 * read: the page's writes are the owner-only tools in `settings.ts` and the
 * ways out the stories component calls.
 */
import { z } from 'zod';
import { editionView } from './edition-view.js';
import type { BuddiHost, PageDescriptor, PageQuery } from '@buddi/core/plugin';
import { ago, clock, languageMark, languageName, shortDate, stamp, startOfDay, weekHence, whenWords } from './format.js';
import { rankedStories, sourceHealth, type ArticleRow, type RankedStory } from './reads.js';
import { STARTER_TOPICS, starterSources } from './starter.js';
import { meaningFor, megabytes } from './meaning.js';
import { meaningRow, MEANING_NOTE } from './settings.js';

type Db = BuddiHost['db'];

/** Stories each topic shows under All; See all shows up to `TOPIC_MAX`. */
export const PER_TOPIC_ALL = 3;
export const TOPIC_MAX = 40;
/** The id Anchor is installed under, when it is. */
export const ANCHOR_ID = 'anchor';

/** A mute for good is stored as 'infinity', which pg hands back as a string. */
export function mutedForGood(until: Date | string | null): boolean {
  return until !== null && (!(until instanceof Date) || !Number.isFinite(until.getTime()) || until.getFullYear() >= 9000);
}
const asDate = (until: Date | string | null): Date | null => (until instanceof Date && Number.isFinite(until.getTime()) ? until : null);

const anchorOf = (buddi: BuddiHost): string | null => (buddi.owner.hasAgent(ANCHOR_ID) ? ANCHOR_ID : null);
const timeFormat = async (buddi: BuddiHost): Promise<'12h' | '24h' | null> => (await buddi.owner.formats?.().catch(() => null))?.time ?? null;

/* ------------------------------------------------------------------ *
 * The page's own read: the quiet line, the failed fetch, who tells
 * ------------------------------------------------------------------ */

export interface Overview {
  /** "Your sources, grouped into stories. …": the page's lede. */
  lede: string;
  /** Anchor's id when it is installed: Latest edition and Ask Anchor go to its chat. */
  anchor: string | null;
  /** "Fetched at 10:00 from 31 sources · next at 10:15"; null before the first answer. */
  fetched: string | null;
  /** "2 aren't answering", linked to Sources; null when every source answers. */
  failing: string | null;
  /** The last round reached nothing: the warning instead of the quiet line. */
  failed: boolean;
  failedTitle: string | null;
  failedText: string | null;
}

export async function overview(buddi: BuddiHost): Promise<Overview> {
  const db = buddi.db;
  const now = buddi.clock.now();
  const zone = buddi.owner.timezone;
  const format = await timeFormat(buddi);
  const { rows } = await db.query<{ active: number; answered: number; failing: number; last_ok: Date | null; last_tried: Date | null; next_at: Date | null }>(
    `select count(*) filter (where s.state <> 'paused')::int as active,
            count(*) filter (where s.last_ok_at is not null and s.state <> 'paused')::int as answered,
            count(*) filter (where s.state <> 'ok')::int as failing,
            max(s.last_ok_at) as last_ok, max(s.last_tried_at) as last_tried,
            min(s.next_at) filter (where s.state <> 'paused') as next_at
       from news.sources s
      where not s.muted and exists (select 1 from news.topic_sources ts join news.topics t on t.id = ts.topic_id
                                     where ts.source_id = s.id and not (t.muted_until is not null and t.muted_until > $1))`,
    [now],
  );
  const r = rows[0] ?? { active: 0, answered: 0, failing: 0, last_ok: null, last_tried: null, next_at: null };
  const anchor = anchorOf(buddi);
  const lede = anchor
    ? 'Your sources, grouped into stories. Anchor tells you the best of it in its editions.'
    : 'Your sources, grouped into stories, in English and French.';
  // Nothing answered for 40 minutes while sources were asked: this machine was offline, or the network was.
  const failed = r.active > 0 && r.last_tried !== null && (r.last_ok === null || r.last_ok.getTime() < now.getTime() - 40 * 60_000) &&
    r.last_tried.getTime() > (r.last_ok?.getTime() ?? 0);
  // The timer runs every minute: a source already due is fetched on the next one.
  const nextAt = r.next_at ? new Date(Math.max(r.next_at.getTime(), Math.ceil((now.getTime() + 1) / 60_000) * 60_000)) : null;
  const next = nextAt ? clock(nextAt, zone, format) : null;
  return {
    lede,
    anchor,
    fetched: r.last_ok && !failed
      ? `Fetched at ${clock(r.last_ok, zone, format)} from ${r.answered} ${r.answered === 1 ? 'source' : 'sources'}${next ? ` · next at ${next}` : ''}`
      : null,
    failing: r.failing > 0 && !failed ? (r.failing === 1 ? '1 isn’t answering' : `${r.failing} aren’t answering`) : null,
    failed,
    failedTitle: failed ? `Couldn’t fetch at ${clock(r.last_tried!, zone, format)}.` : null,
    failedText: failed
      ? `No source answered.${r.last_ok ? ` These are the stories from ${stamp(r.last_ok, now, zone, format)};` : ''} buddi tries again every 15 minutes.`
      : null,
  };
}

/* ------------------------------------------------------------------ *
 * The chips: All and the topics
 * ------------------------------------------------------------------ */

export async function topicChips(db: Db, now: Date): Promise<{ topics: Array<{ id: string; name: string }> }> {
  const { rows } = await db.query<{ id: string; name: string }>(
    `select id, name from news.topics where not (muted_until is not null and muted_until = 'infinity') order by position, name`,
  );
  void now;
  return { topics: [{ id: 'all', name: 'All' }, ...rows] };
}

/* ------------------------------------------------------------------ *
 * The stories
 * ------------------------------------------------------------------ */

export const FILTERS = ['all', 'untold', 'today', 'deals'] as const;
export type Filter = (typeof FILTERS)[number];

/** What the page is handed for a story: the kit's card and sheet, in words. */
export interface StoryCardRow {
  image?: import('./reads.js').StoryImage;
  id: string;
  title: string;
  /** Source labels supplied by the plugin for the text actually displayed. */
  titleAttribution?: string;
  summaryAttribution?: string;
  updateAttribution?: string;
  lead?: string;
  summary?: string;
  update?: string;
  url?: string;
  ago: string;
  opinion?: boolean;
  languages?: string;
  mark?: { kind: 'told' | 'new'; text: string };
  quiet?: boolean;
  outlets: Array<{ id?: string; name: string; logo?: string }>;
  /** The outlets that can be muted (an aggregator's own row has none). */
  mutable: Array<{ id: string; name: string }>;
  group: { id: string; name: string };
  topicId: string;
  kicker: string;
  meta: string;
  told: boolean;
  editionId?: string;
  anchor: string | null;
  chatContext: string;
  quietHint: string;
  quietDone: string;
  sources: Array<{ title: string; url: string; outlet: string; logo?: string; meta: string }>;
  timeline: Array<{ at: string; text: string; told?: boolean }>;
}

export interface StoriesAnswer {
  stories: StoryCardRow[];
  /** Why there is nothing: none (no topic), first (no source answered yet), nosources, told, quiet. */
  state: 'ok' | 'none' | 'first' | 'nosources' | 'told' | 'quiet';
  emptyTitle?: string;
  note?: string;
}

const outletKey = (a: ArticleRow): string => a.outlet_id ?? a.source_id;

/** One per outlet, in the order they first carried it. */
function outletsOf(articles: ArticleRow[]): ArticleRow[] {
  const seen = new Set<string>();
  return articles.filter((a) => {
    const key = outletKey(a);
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

async function toldEvents(db: Db, ids: string[]): Promise<Map<string, Array<{ kind: string; at: Date; editionId?: string }>>> {
  const out = new Map<string, Array<{ kind: string; at: Date; editionId?: string }>>();
  if (ids.length === 0) return out;
  const { rows } = await db.query<{ story_id: string; kind: string; told_at: Date; edition_id: string }>(
    `select t.story_id, e.kind, t.told_at, t.edition_id from news.told t join news.editions e on e.id = t.edition_id where t.story_id = any($1) order by t.told_at`,
    [ids],
  );
  for (const r of rows) out.set(r.story_id, [...(out.get(r.story_id) ?? []), { kind: r.kind, at: r.told_at, editionId: r.edition_id }]);
  return out;
}

export function storyCard(
  r: RankedStory, told: Array<{ kind: string; at: Date; editionId?: string }>, ctx: { now: Date; zone: string; format: '12h' | '24h' | null; anchor: string | null },
): StoryCardRow {
  const s = r.summary;
  const { now, zone, format } = ctx;
  const toldAt = s.lastToldAt ? new Date(s.lastToldAt) : null;
  const when = toldAt ? whenWords(toldAt, now, zone) : null;
  const since = toldAt ? r.articles.filter((a) => a.fetched_at > toldAt) : [];
  const newest = since[since.length - 1];
  const candidateUpdate = s.status === 'update' && newest ? (newest.lead || newest.title) : undefined;
  const sameText = (a: string, b: string) => a.replace(/\s+/g, ' ').trim().toLocaleLowerCase() === b.replace(/\s+/g, ' ').trim().toLocaleLowerCase();
  const update = candidateUpdate && !sameText(candidateUpdate, s.lead) && !sameText(candidateUpdate, s.title) ? candidateUpdate.slice(0, 280) : undefined;
  const distinct = outletsOf(r.articles);
  // The outlet whose article names the story first: the card's "Reuters and 3 more".
  const lead = distinct.find((a) => a.outlet === s.outlet) ?? distinct[0];
  const ordered = lead ? [lead, ...distinct.filter((a) => a !== lead)] : distinct;
  const first = r.articles[0];
  const week = weekHence(now, zone);
  const timeline: StoryCardRow['timeline'] = [];
  if (first) timeline.push({ at: stamp(first.published_at, now, zone, format), text: `Earliest collected coverage: ${first.outlet}.` });
  const events: Array<{ at: Date; text: string; told?: boolean }> = [
    ...distinct.slice(1).map((a) => ({ at: a.published_at, text: `${a.outlet}: ${a.title}` })),
    ...told.map((t) => ({ at: t.at, text: `Told you in the ${t.kind} edition.`, told: true })),
  ].sort((x, y) => x.at.getTime() - y.at.getTime());
  for (const e of events.slice(-5)) timeline.push({ at: stamp(e.at, now, zone, format), text: e.text, ...(e.told ? { told: true } : {}) });
  const count = distinct.length;
  return {
    id: s.id,
    ...(s.image ? { image: s.image } : {}),
    title: s.title,
    titleAttribution: s.titleOutlet ? `Headline from ${s.titleOutlet}` : 'Source headline',
    summaryAttribution: s.lead
      ? s.leadOutlet ? `Feed excerpt from ${s.leadOutlet}` : 'Feed excerpt'
      : update && newest ? `${newest.lead ? 'Feed excerpt' : 'Headline'} from ${newest.outlet}` : undefined,
    ...(update && newest ? { updateAttribution: `${newest.lead ? 'Feed excerpt' : 'Headline'} from ${newest.outlet}` } : {}),
    ...(update ? { lead: update, summary: s.lead || undefined } : s.lead ? { lead: s.lead } : {}),
    ...(update ? { update } : {}),
    ...(s.url ? { url: s.url } : {}),
    ago: ago(new Date(s.updatedAt), now),
    ...(s.opinion ? { opinion: true } : {}),
    ...(languageMark(s.languages) ? { languages: languageMark(s.languages)! } : {}),
    ...(s.status === 'update' && when ? { mark: { kind: 'new' as const, text: `New since ${when}` } } : s.status === 'told' && when ? { mark: { kind: 'told' as const, text: `Told you · ${when}` } } : {}),
    ...(s.status === 'told' ? { quiet: true } : {}),
    outlets: ordered.map((a) => ({ ...(a.outlet_id ? { id: a.outlet_id } : {}), name: a.outlet, ...(a.logo ? { logo: a.logo } : {}) })),
    mutable: ordered.filter((a) => a.outlet_id).slice(0, 4).map((a) => ({ id: a.outlet_id!, name: a.outlet })),
    group: { id: s.topicId, name: s.topic },
    topicId: s.topicId,
    kicker: s.topic,
    meta: [
      `First seen ${stamp(first && first.published_at < new Date(s.firstSeen) ? first.published_at : new Date(s.firstSeen), now, zone, format)}`,
      count === 1 ? '1 source' : `${count} sources`,
      ...(when ? [`told you ${when}`] : []),
    ].join(' · '),
    told: toldAt !== null,
    ...(told.at(-1)?.editionId ? { editionId: told.at(-1)!.editionId } : {}),
    anchor: ctx.anchor,
    chatContext: `News story ID: ${s.id}. Retrieve its collected articles with news.story using this ID before answering.`,
    quietHint: week.hint,
    quietDone: `${s.topic} is quiet until ${week.until}.`,
    sources: ordered.map((a) => ({
      title: a.title,
      url: a.url,
      outlet: a.outlet,
      ...(a.logo ? { logo: a.logo } : {}),
      meta: [a.outlet, languageName(a.language), stamp(a.published_at, now, zone, format), ...(a.opinion ? ['Opinion'] : []), ...(a.paywall ? ['Paywalled'] : [])].join(' · '),
    })),
    timeline,
  };
}

export async function storiesFor(buddi: BuddiHost, params: { topic?: string; filter?: string }): Promise<StoriesAnswer> {
  const db = buddi.db;
  const now = buddi.clock.now();
  const zone = buddi.owner.timezone;
  const filter: Filter = (FILTERS as readonly string[]).includes(params.filter ?? '') ? (params.filter as Filter) : 'all';
  const topicId = params.topic && params.topic !== 'all' ? params.topic : undefined;
  const { rows: topics } = await db.query<{ id: string; name: string; position: number; muted_until: Date | null }>(
    `select id, name, position, muted_until from news.topics order by position, name`,
  );
  if (topics.length === 0) return { stories: [], state: 'none' };
  const topic = topicId ? topics.find((t) => t.id === topicId) : undefined;
  const { rows: health } = await db.query<{ sources: number; answered: number }>(
    `select count(*)::int as sources, count(*) filter (where s.last_ok_at is not null)::int as answered
       from news.sources s where not s.muted and ($1::text is null or exists (select 1 from news.topic_sources ts where ts.source_id = s.id and ts.topic_id = $1))`,
    [topic?.id ?? null],
  );
  const h = health[0] ?? { sources: 0, answered: 0 };
  if (topic && h.sources === 0) {
    return { stories: [], state: 'nosources', emptyTitle: `No sources for ${topic.name} yet`, note: 'This topic reads nothing until it has a source: add a feed or a Google News search on Sources.' };
  }
  if (h.sources > 0 && h.answered === 0) {
    return { stories: [], state: 'first', note: 'Stories show here in a minute or two, grouped by topic.' };
  }
  const window = await db.query<{ window_hours: number }>(`select window_hours from news.settings`);
  const since = filter === 'today' ? startOfDay(now, zone) : new Date(now.getTime() - (window.rows[0]?.window_hours ?? 48) * 3600_000);
  const language = ((await buddi.owner.language().catch(() => undefined)) ?? 'en').slice(0, 2);
  const ranked = await rankedStories(db, now, {
    ...(topic ? { topicId: topic.id } : {}), n: topic ? TOPIC_MAX : 200, since, untold: filter === 'untold', ownerLanguage: language,
    ...(topic ? {} : { perTopic: PER_TOPIC_ALL }), ...(filter === 'deals' ? { kind: 'deal' as const } : {}),
  });
  const position = new Map(topics.map((t) => [t.id, t.position]));
  // Grouped by topic in the owner's order; within a topic, rank order.
  const ordered = topic ? ranked : [...ranked].sort((a, b) => (position.get(a.summary.topicId) ?? 999) - (position.get(b.summary.topicId) ?? 999));
  const told = await toldEvents(db, ordered.map((r) => r.summary.id));
  const ctx = { now, zone, format: await timeFormat(buddi), anchor: anchorOf(buddi) };
  const stories = ordered.map((r) => storyCard(r, told.get(r.summary.id) ?? [], ctx));
  if (stories.length > 0) return { stories, state: 'ok' };
  if (filter === 'untold') {
    return { stories, state: 'told', emptyTitle: ctx.anchor ? 'Anchor has told you all of this' : 'You’re up to date', note: 'Anything new lands here first.' };
  }
  if (filter === 'deals') {
    return { stories, state: 'quiet', emptyTitle: 'No deals right now', note: 'Deals and buying guides land here, and never in an edition or the widget.' };
  }
  return { stories, state: 'quiet', emptyTitle: filter === 'today' ? 'Nothing here today' : `Nothing new${topic ? ` in ${topic.name}` : ''}`, note: 'Try another topic, or show everything.' };
}

/* ------------------------------------------------------------------ *
 * The source manager's reads
 * ------------------------------------------------------------------ */

export interface SourceRow {
  /** `<topic>:<source>`: a source in two topics is a row under each. */
  key: string;
  id: string;
  topicId: string;
  topic: string;
  topicAside: string;
  name: string;
  lang: string;
  line: string;
  logo: string | null;
  problem: string | null;
  tone: 'warning' | null;
  failing: boolean;
  muted: boolean;
}

export async function sourceRows(buddi: BuddiHost): Promise<{ sources: SourceRow[] }> {
  const db = buddi.db;
  const now = buddi.clock.now();
  const zone = buddi.owner.timezone;
  const format = await timeFormat(buddi);
  const [health, topicsRes, weekRes] = await Promise.all([
    sourceHealth(db),
    db.query<{ id: string; name: string; builtin: boolean; muted_until: Date | string | null }>(`select id, name, builtin, muted_until from news.topics order by position, name`),
    db.query<{ source_id: string; topic_id: string; n: number }>(
      `select a.source_id, at.topic_id, count(distinct at.story_id)::int as n
         from news.articles a join news.article_topics at on at.article_id = a.id
        where a.fetched_at > $1 and at.story_id is not null group by a.source_id, at.topic_id`,
      [new Date(now.getTime() - 7 * 86_400_000)],
    ),
  ]);
  const week = new Map(weekRes.rows.map((r) => [`${r.topic_id}:${r.source_id}`, r.n]));
  const out: SourceRow[] = [];
  for (const topic of topicsRes.rows) {
    const inTopic = health.filter((h) => h.topics.includes(topic.id));
    const until = asDate(topic.muted_until);
    const quiet = mutedForGood(topic.muted_until)
      ? 'Muted · left out of editions'
      : until && until > now ? `Quiet until ${shortDate(until, zone)} · left out of editions` : null;
    const aside = quiet ?? `${inTopic.length} ${inTopic.length === 1 ? 'source' : 'sources'}${topic.builtin ? '' : ' · your topic'}`;
    for (const h of inTopic) {
      // The outlet's own domain, as the kit's rows say it; an aggregator's feed host otherwise.
      const host = h.outletId ?? (() => {
        try {
          return new URL(h.url).hostname.replace(/^www\./, '');
        } catch {
          return '';
        }
      })();
      const stories = week.get(`${topic.id}:${h.id}`) ?? 0;
      const since = h.failingSince ? stamp(new Date(h.failingSince), now, zone, format) : null;
      const problem = h.muted
        ? 'Muted · its stories are hidden, in News and in editions.'
        : h.state === 'paused'
          ? `Paused: it hadn’t answered for a week${h.lastError ? ` (${h.lastError})` : ''}. Try it again when it’s back.`
          : h.state === 'failing'
            ? `Failing since ${since ?? 'yesterday'}: ${h.lastError ?? 'no answer'}.`
            : null;
      out.push({
        key: `${topic.id}:${h.id}`,
        id: h.id,
        topicId: topic.id,
        topic: topic.name,
        topicAside: aside,
        name: h.name,
        lang: `${h.language.toUpperCase()}${h.kind === 'gnews' ? ' · Google News' : h.kind === 'hn' || h.kind === 'gdelt' ? ' · API' : ''}`,
        line: [host, ...(h.paywall ? ['Paywalled'] : []), ...(h.muted ? [] : [stories === 1 ? '1 story this week' : `${stories} stories this week`])].join(' · '),
        logo: h.logo,
        problem,
        tone: h.state !== 'ok' && !h.muted ? 'warning' : null,
        failing: h.state !== 'ok' && !h.muted,
        muted: h.muted,
      });
    }
  }
  return { sources: out };
}

export interface TopicRow {
  id: string;
  name: string;
  line: string;
  quiet: boolean;
  muted: boolean;
  builtin: boolean;
}

export async function topicRows(buddi: BuddiHost): Promise<{ topics: TopicRow[] }> {
  const db = buddi.db;
  const now = buddi.clock.now();
  const zone = buddi.owner.timezone;
  const { rows } = await db.query<{ id: string; name: string; builtin: boolean; keywords: string[]; languages: string[]; muted_until: Date | string | null; sources: number }>(
    `select t.id, t.name, t.builtin, t.keywords, t.languages, t.muted_until,
            (select count(*)::int from news.topic_sources ts where ts.topic_id = t.id) as sources
       from news.topics t order by t.position, t.name`,
  );
  return {
    topics: rows.map((t) => {
      const forGood = mutedForGood(t.muted_until);
      const until = asDate(t.muted_until);
      const quiet = !forGood && until !== null && until > now;
      const state = forGood ? 'Muted' : quiet ? `Quiet until ${shortDate(until!, zone)}` : null;
      return {
        id: t.id,
        name: t.name,
        line: [
          t.sources === 1 ? '1 source' : `${t.sources} sources`,
          t.languages.length > 1 ? 'English and French' : languageName(t.languages[0] ?? 'en'),
          ...(t.builtin ? [] : ['your topic']),
          ...(state ? [state] : []),
        ].join(' · '),
        quiet,
        muted: forGood,
        builtin: t.builtin,
      };
    }),
  };
}

export interface NewsSettingsView {
  voiceEditions: string[];
  speech: boolean;
  starterOff: boolean;
  starterLine: string;
  retentionDays: number;
}

export async function settingsView(buddi: BuddiHost): Promise<NewsSettingsView> {
  const db = buddi.db;
  const { rows } = await db.query<{ voice_editions: string[]; retention_days: number }>(`select voice_editions, retention_days from news.settings`);
  const { rows: on } = await db.query<{ id: string }>(`select id from news.sources where added_by = 'starter'`);
  const have = new Set(on.map((r) => r.id));
  const missing = starterSources().filter((s) => !have.has(s.id)).length;
  return {
    voiceEditions: rows[0]?.voice_editions ?? [],
    speech: buddi.plugins?.has?.('speech') ?? false,
    starterOff: have.size === 0,
    starterLine: have.size === 0
      ? `The starter sources are off: ${starterSources().length} checked feeds over ${STARTER_TOPICS.length} topics, a mix of wire services, public broadcasters and local outlets in English and French.`
      : missing > 0
        ? `${missing} starter ${missing === 1 ? 'source is' : 'sources are'} not on.`
        : '',
    retentionDays: rows[0]?.retention_days ?? 30,
  };
}

/** One polled row keeps the first-run gate and its download state in sync. */
export async function setupView(buddi: BuddiHost) {
  const [settings, choice, state] = await Promise.all([
    settingsView(buddi),
    buddi.db.query<{ done: boolean; has_sources: boolean; custom_source_setup: boolean }>(`select meaning_setup_done or exists (select 1 from news.sources) as done, exists (select 1 from news.sources) as has_sources, custom_source_setup from news.settings`),
    meaningFor().state(buddi),
  ]);
  const row = meaningRow(state);
  const gate = !choice.rows[0]?.done;
  return { busy: gate && (row.state === 'waiting' || row.state === 'downloading'), rows: [{ ...settings, ...row, gate, sourcesGate: !gate && !choice.rows[0]?.has_sources, settingsReady: !gate && !!choice.rows[0]?.has_sources, customSources: choice.rows[0]?.custom_source_setup ?? false, setupDownload: `Download · ${megabytes(state.bytes)}. Includes the model and shared engine. Download once.` }] };
}

/* ------------------------------------------------------------------ *
 * Queries
 * ------------------------------------------------------------------ */

const none = z.object({}).strict();

export const dashboardQueries: PageQuery[] = [
  { name: 'overview', params: none, produce: async (_p, ctx) => overview(ctx.buddi!) },
  { name: 'topics', params: none, produce: async (_p, ctx) => topicChips(ctx.buddi!.db, ctx.buddi!.clock.now()) },
  {
    name: 'stories',
    params: z.object({ topic: z.string().max(80).optional(), filter: z.enum(FILTERS).optional() }).strict(),
    produce: async (params, ctx) => storiesFor(ctx.buddi!, params as { topic?: string; filter?: string }),
  },
  { name: 'source_rows', params: none, produce: async (_p, ctx) => sourceRows(ctx.buddi!) },
  { name: 'topic_rows', params: none, produce: async (_p, ctx) => topicRows(ctx.buddi!) },
  { name: 'starter_review', params: none, produce: async () => ({ sources: starterSources().flatMap((source) => source.topics.map((topic) => ({
    id: `${topic.topic}:${source.id}`, name: source.name, language: languageName(source.language), url: source.url,
    topic: STARTER_TOPICS.find((t) => t.id === topic.topic)?.name ?? topic.topic,
  }))) }) },
  { name: 'news_setup', params: none, produce: async (_p, ctx) => setupView(ctx.buddi!) },
  { name: 'news_settings', params: none, produce: async (_p, ctx) => settingsView(ctx.buddi!) },
  /** One saved edition, parsed for the chat's edition card; `edition: null` when it is gone. */
  {
    name: 'edition',
    params: z.object({ id: z.string().trim().min(1).max(40) }).strict(),
    produce: async (params, ctx) => ({ edition: (await editionView(ctx.buddi!, (params as { id: string }).id)) ?? null }),
  },
];

/* ------------------------------------------------------------------ *
 * The pages
 * ------------------------------------------------------------------ */

const STORIES = (filter: Filter) => ({
  kind: 'stories' as const,
  query: { query: 'stories', params: { topic: { param: 'topic' }, filter: { const: filter } } },
  rows: 'stories',
  groups: { param: 'topic' },
  param: 'story',
  ways: [
    {
      tool: 'news.hide_story', label: 'Not interested', hint: 'Hides this story for good', hides: true as const,
      args: { id: { row: 'id' }, action: { const: 'not_interested' } }, done: 'Hidden. It won’t come back.',
      undo: { tool: 'news.hide_story', label: 'Undo', args: { id: { row: 'id' }, action: { const: 'undo' } } },
    },
    {
      tool: 'news.mute_outlet', label: 'Mute {name}', group: 'Mute an outlet', each: 'mutable', hides: true as const,
      args: { outlet: { item: 'id' }, muted: { const: true } }, done: 'Muted {name}. Its stories are hidden.',
      undo: { tool: 'news.mute_outlet', label: 'Undo', args: { outlet: { item: 'id' }, muted: { const: false } } },
    },
    {
      tool: 'news.set_topic', label: 'Quiet {kicker} for a week', hint: '{quietHint}', hides: true as const,
      args: { topic: { row: 'topicId' }, mutedForHours: { const: 168 } }, done: '{quietDone}',
      undo: { tool: 'news.set_topic', label: 'Undo', args: { topic: { row: 'topicId' }, mutedForHours: { const: 0 } } },
    },
    {
      tool: 'news.set_topic', label: 'Mute {kicker}', hint: 'Undo it in Sources', hides: true as const,
      args: { topic: { row: 'topicId' }, muted: { const: true } }, done: 'Muted {kicker}. Anchor leaves it out too.',
      undo: { tool: 'news.set_topic', label: 'Undo', args: { topic: { row: 'topicId' }, muted: { const: false } } },
    },
  ],
  ask: { label: 'Ask Anchor', to: { chat: { path: 'anchor' } }, context: { title: { path: 'title' }, text: { path: 'chatContext' }, suggestions: ['Explain this story', 'Compare the sources'] } },
  edition: { label: 'Read the edition', to: { page: 'stories', params: { edition: { path: 'editionId' } } }, when: { path: 'editionId', not: true, equals: null } },
  emptyStates: [
    {
      when: { path: 'state', equals: 'none' }, warm: true as const, title: 'No news yet',
      text: 'Turn on the starter sources — wire services, public broadcasters and local outlets, in English and French — or add your own.',
      actions: [{ label: 'Choose sources', to: { page: 'sources' } }],
    },
    { when: { path: 'state', equals: 'first' }, warm: true as const, title: 'The first fetch is running', text: { path: 'note' } },
    {
      when: { path: 'state', equals: 'nosources' }, warm: true as const, title: { path: 'emptyTitle' }, text: { path: 'note' },
      actions: [{ label: 'Show all', set: { topic: 'all' } }, { label: 'Add a source', to: { page: 'sources' } }],
    },
    { when: { path: 'state', equals: 'told' }, title: { path: 'emptyTitle' }, text: { path: 'note' }, actions: [{ label: 'Show all', set: { filter: 'all' } }] },
    { when: { path: 'state', equals: 'quiet' }, title: { path: 'emptyTitle' }, text: { path: 'note' }, actions: [{ label: 'Show all', set: { filter: 'all', topic: 'all' } }] },
  ],
});

const FETCH_LINE = [
  {
    kind: 'notice' as const, look: 'quiet' as const, icon: 'globe' as const, text: { path: 'fetched' },
    link: { label: { path: 'failing' }, to: { page: 'sources' }, when: { path: 'failing', not: true as const, equals: null } },
    when: { path: 'failed', equals: false },
  },
  {
    kind: 'notice' as const, tone: 'warning' as const, title: 'Couldn’t fetch the news.', text: { path: 'failedText' },
    action: { tool: 'news.refresh', label: 'Try now', busy: 'Fetching…' },
    when: { path: 'failed', equals: true },
  },
];

export const storiesPage: PageDescriptor = {
  id: 'stories',
  title: 'News',
  place: 'rail',
  icon: 'news',
  order: 40,
  data: { query: 'overview' },
  actions: [
    { kind: 'link', label: 'Sources', to: { page: 'sources' } },
    { kind: 'link', label: 'Latest edition', tone: 'accent', to: { page: 'stories', params: { edition: { const: 'latest' } } } },
  ],
  body: [
    { kind: 'edition', param: 'edition', query: { query: 'edition', params: { id: { param: 'edition' } } } },
    { kind: 'notice', text: { path: 'lede' } },
    ...FETCH_LINE,
    {
      kind: 'tabs',
      title: 'Show',
      param: 'filter',
      pick: {
        param: 'topic', label: 'Topic', look: 'chips', add: { label: 'Topic', to: { page: 'sources' } },
        optionsFrom: { query: { query: 'topics' }, rows: 'topics', value: 'id', label: 'name' },
      },
      tabs: FILTERS.map((filter) => ({
        id: filter,
        label: filter === 'all' ? 'All' : filter === 'untold' ? 'Not yet told' : filter === 'today' ? 'Today' : 'Deals',
        body: [STORIES(filter)],
      })),
    },
  ],
} as PageDescriptor;

const TOPIC_OPTIONS = { query: { query: 'topics' }, rows: 'topics', value: 'id', label: 'name' };

export const sourcesPage: PageDescriptor = {
  id: 'sources',
  title: 'News',
  place: 'settings',
  icon: 'news',
  data: { query: 'news_settings' },
  body: [{
    kind: 'repeat', query: { query: 'news_setup' }, rows: 'rows', key: 'id',
    poll: { seconds: 2, while: { path: 'busy', equals: true } },
    body: [
      {
        kind: 'section', look: 'setup', title: 'Set up News',
        when: { path: 'gate', equals: true },
        note: 'Step 1 of 2 · Story grouping',
        body: [
          { kind: 'section', title: 'One story, even when headlines differ', body: [
            { kind: 'notice', look: 'quiet', text: 'Group reporting about the same event across English and French sources. Everything runs on your computer.' },
          ] },
          { kind: 'notice', when: { path: 'state', equals: 'absent' }, text: { path: 'setupDownload' } },
          { kind: 'notice', when: { path: 'state', equals: 'waiting' }, text: 'Confirm the download below. Setup continues here once it is ready.' },
          { kind: 'notice', tone: 'warning', when: { path: 'state', equals: 'failed' }, text: { path: 'line' } },
          { kind: 'approval', path: 'approvalId', when: { path: 'state', equals: 'waiting' } },
          { kind: 'progress', when: { path: 'state', in: ['downloading', 'ready'] }, value: { path: 'bytes' }, total: { path: 'total' }, label: { path: 'heading' }, done: 'Ready. Your stories can now be grouped by meaning.' },
          { kind: 'button', when: { path: 'state', equals: 'absent' }, action: { tool: 'news.download_meaning', tone: 'accent', label: 'Review download', busy: 'Preparing download…' } },
          { kind: 'button', when: { path: 'state', equals: 'failed' }, action: { tool: 'news.download_meaning', tone: 'accent', label: 'Try again', busy: 'Preparing download…' } },
          { kind: 'button', when: { path: 'state', equals: 'ready' }, action: { tool: 'news.finish_meaning_setup', tone: 'accent', label: 'Choose sources', args: { skip: { const: false } } } },
          { kind: 'button', when: { path: 'state', not: true, equals: 'ready' }, action: { tool: 'news.finish_meaning_setup', label: 'Set up without downloading', args: { skip: { const: true } } } },
          { kind: 'notice', look: 'quiet', when: { path: 'state', in: ['absent', 'failed'] }, text: 'Without the download, similar headlines are grouped using shared words.' },
          { kind: 'notice', look: 'quiet', when: { path: 'state', in: ['waiting', 'downloading'] }, text: 'You can leave this page; the download will continue once approved.' },
          { kind: 'notice', look: 'quiet', text: 'Next: choose your US and International sources.' },
        ],
      },

      {
        kind: 'section', look: 'setup', title: 'Choose your sources',
        note: 'Step 2 of 2 · Sources', when: { path: 'sourcesGate', equals: true },
        body: [
          { kind: 'section', title: 'US and International', body: [
            { kind: 'notice', look: 'quiet', text: 'Start with 28 feeds in English and French, from wire services, public broadcasters and other news outlets. You can change them at any time.' },
          ] },
          { kind: 'expand', label: 'Review the 28 starter feeds', body: [
            { kind: 'list', query: { query: 'starter_review' }, rows: 'sources', key: 'id',
              groupBy: { key: 'topic', label: 'topic' },
              item: { title: { path: 'name' }, tag: { path: 'language' }, sub: { path: 'url' } },
            },
          ] },
          { kind: 'form', title: 'Add your first topic', when: { path: 'customSources', equals: true },
            fields: [
              { name: 'name', label: 'Topic name', type: 'text', required: true },
              { name: 'keywords', label: 'Keywords', type: 'text', required: true, hint: 'Separate words or phrases with commas.' },
              { name: 'feeds', label: 'Feed or website (optional)', type: 'text', hint: 'Without a feed, News searches Google News for these keywords in English and French.' },
            ],
            submit: { tool: 'news.add_topic', label: 'Add topic and sources', tone: 'accent', busy: 'Adding…', done: { path: 'note' }, args: { name: { field: 'name' }, keywords: { field: 'keywords' }, feeds: { field: 'feeds' } } },
          },
          { kind: 'notice', look: 'quiet', text: 'Once added, News starts reading your sources. The first stories may take a minute or two.' },
          { kind: 'button', when: { path: 'customSources', equals: false }, action: { tool: 'news.choose_custom_sources', label: 'Add my own sources' } },
          { kind: 'button', action: { tool: 'news.enable_starter', label: 'Use starter sources', tone: 'accent', busy: 'Adding sources…', done: { path: 'note' } } },
        ],
      },

    {
      kind: 'section',
      when: { path: 'settingsReady', equals: true },
      title: 'Sources',
      note: 'What each topic reads. It started with a mix of wire services, public broadcasters and local outlets, in English and French; change any of it.',
      body: [
        {
          kind: 'notice', tone: 'accent', text: { path: 'starterLine' },
          action: { tool: 'news.enable_starter', label: 'Turn on the starter sources', busy: 'Turning on…', done: { path: 'note' } },
          when: { path: 'starterLine', not: true, equals: '' },
        },
        {
          kind: 'list',
          query: { query: 'source_rows' },
          rows: 'sources',
          key: 'key',
          empty: 'No source yet. Add a feed, a site, or a Google News search.',
          groupBy: { key: 'topicId', label: 'topic', aside: 'topicAside' },
          item: {
            title: { path: 'name' },
            tag: { path: 'lang' },
            sub: { path: 'line' },
            logo: { asset: { path: 'logo' }, label: { path: 'name' } },
            status: { text: { path: 'problem' }, tone: { path: 'tone' } },
          },
          actions: [
            { tool: 'news.retry_source', label: 'Try again', args: { id: { row: 'id' } }, when: { path: 'failing', equals: true }, busy: 'Trying…', done: 'Asked again: it is fetched on the next round.' },
            { tool: 'news.set_source', label: 'Unmute', args: { id: { row: 'id' }, muted: { const: false } }, when: { path: 'muted', equals: true } },
            { tool: 'news.set_source', label: 'Mute {name}', menu: true, hint: 'Everywhere, not only here', args: { id: { row: 'id' }, muted: { const: true } }, when: { path: 'muted', equals: false } },
            {
              tool: 'news.remove_source', label: 'Remove from {topic}', menu: true, tone: 'danger', confirm: 'Remove {name} from {topic}?',
              args: { id: { row: 'id' }, topic: { row: 'topicId' } },
            },
          ],
        },
        {
          kind: 'form',
          drawer: { title: 'Add a topic', button: 'Add a topic' },
          fields: [
            { name: 'name', label: 'Name', type: 'text', required: true },
            { name: 'keywords', label: 'Keywords', type: 'text', required: true, hint: 'Separated by commas: Lyon, Villeurbanne, TCL. Without a feed, they are what Google News is searched for, so they leave this Mac as the search.' },
            { name: 'feeds', label: 'A feed or a site (optional)', type: 'text', hint: 'Without one, the topic follows a Google News search for its keywords, in English and French.' },
          ],
          submit: { tool: 'news.add_topic', label: 'Add the topic', busy: 'Adding…', done: { path: 'note' }, args: { name: { field: 'name' }, keywords: { field: 'keywords' }, feeds: { field: 'feeds' } }, then: 'close' },
        },
        {
          kind: 'form',
          drawer: { title: 'Add a source', button: 'Add a source' },
          fields: [
            { name: 'address', label: 'A feed, a site, or a Google News search', type: 'text', required: true, hint: 'Paste an address — buddi finds the site’s feed and reads only that — or type words to follow a Google News search. Its logo is fetched once and kept on this Mac; nothing about you is sent.' },
            { name: 'topic', label: 'Topic', type: 'select', required: true, optionsFrom: { ...TOPIC_OPTIONS, query: { query: 'topic_rows' }, rows: 'topics' } },
          ],
          submit: { tool: 'news.add_feed', label: 'Add the source', busy: 'Checking the feed…', done: { path: 'note' }, args: { address: { field: 'address' }, topic: { field: 'topic' } }, then: 'close' },
        },
      ],
    },
    {
      kind: 'section',
      when: { path: 'settingsReady', equals: true },
      title: 'Topics',
      body: [
        {
          kind: 'list',
          query: { query: 'topic_rows' },
          rows: 'topics',
          key: 'id',
          item: { title: { path: 'name' }, sub: { path: 'line' } },
          actions: [
            { tool: 'news.set_topic', label: 'Bring back now', args: { topic: { row: 'id' }, mutedForHours: { const: 0 } }, when: { path: 'quiet', equals: true } },
            { tool: 'news.set_topic', label: 'Unmute', args: { topic: { row: 'id' }, muted: { const: false } }, when: { path: 'muted', equals: true } },
            { tool: 'news.set_topic', label: 'Quiet for a week', menu: true, hint: 'Back on its own in a week', args: { topic: { row: 'id' }, mutedForHours: { const: 168 } }, when: { path: 'quiet', equals: false } },
            { tool: 'news.set_topic', label: 'Mute', menu: true, hint: 'Hidden in News, left out of editions', args: { topic: { row: 'id' }, muted: { const: true } }, when: { path: 'muted', equals: false } },
            { tool: 'news.remove_topic', label: 'Remove topic', menu: true, tone: 'danger', confirm: 'Remove {name} with its stories? Its own feeds go too.', args: { topic: { row: 'id' } } },
          ],
        },
      ],
    },
    {
      kind: 'section',
      when: { path: 'settingsReady', equals: true },
      title: 'Story grouping',
      note: MEANING_NOTE,
      body: [
        {
          kind: 'repeat',
          query: { query: 'meaning' },
          rows: 'rows',
          key: 'id',
          poll: { seconds: 2, while: { path: 'busy', equals: true } },
          body: [
            { kind: 'notice', text: { path: 'line' }, when: { path: 'state', in: ['absent', 'waiting', 'failed'] } },
            { kind: 'approval', path: 'approvalId', when: { path: 'state', equals: 'waiting' } },
            {
              kind: 'progress',
              when: { path: 'state', in: ['downloading', 'ready'] },
              value: { path: 'bytes' },
              total: { path: 'total' },
              label: { path: 'heading' },
              done: { path: 'done' },
            },
            {
              kind: 'button',
              when: { path: 'state', in: ['absent', 'failed'] },
              action: { tool: 'news.download_meaning', tone: 'accent', label: '{action}', busy: 'Asking…', done: { path: 'note' } },
            },
          ],
        },
      ],
    },
    {
      kind: 'section',
      when: { path: 'settingsReady', equals: true },
      title: 'Read aloud',
      body: [
        { kind: 'notice', text: 'Needs the Speech plugin and a voice: without them, editions arrive as text.', when: { path: 'speech', equals: false } },
        {
          kind: 'form',
          initial: { query: 'news_settings' },
          fields: [
            {
              name: 'voiceEditions', label: 'Editions Anchor also sends as a voice message', hint: 'Enabling an edition authorizes its narration using your Speech settings, without another approval each run.', type: 'select', multiple: true, from: 'voiceEditions',
              options: [{ value: 'morning', label: 'Morning' }, { value: 'midday', label: 'Midday' }, { value: 'evening', label: 'Evening' }],
            },
          ],
          submit: { tool: 'news.set_settings', label: 'Save', done: 'Saved.', args: { voiceEditions: { field: 'voiceEditions' } } },
        },
      ],
    },
    {
      kind: 'section',
      when: { path: 'settingsReady', equals: true },
      title: 'History',
      note: 'Anchor remembers which stories it told, so nothing is told twice. Stories are kept 30 days.',
      body: [
        { kind: 'notice', look: 'quiet', text: 'Clear the record of what was told. Your topics, sources and saved stories are kept.' },
        { kind: 'button', action: { tool: 'news.set_settings', label: 'Forget what was told', confirm: 'Forget every edition and what it told? The next edition may repeat stories.', args: { forgetTold: { const: true } }, done: 'Forgotten.' } },
      ],
    },
      ],
  }],
} as PageDescriptor;

export const newsPages: PageDescriptor[] = [storiesPage, sourcesPage];
