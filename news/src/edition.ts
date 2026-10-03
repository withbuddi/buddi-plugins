/**
 * What Anchor needs to tell the news (spec §6, §8): the material for an
 * edition, the one write that records it, an article's text read on demand,
 * the owner's "Quiet news today", and muting an outlet from chat, which asks
 * the owner first.
 *
 * `news.edition_material` is also an export, so a mission's `context` (host
 * API 1.27) can hand it to the run before the model starts: one model call
 * per edition. It reads only.
 */
import { z } from 'zod';
import type { BuddiHost, PluginExport, ToolContext, ToolDefinition } from '@buddi/core/plugin';
import { ToolRefusal } from '@buddi/core/plugin';
import { plainText } from './feed.js';
import { FetchError, hostDeclared, politeGet } from './fetch.js';
import { decodeEntities } from './xml.js';
import { endOfDay, startOfDay, shortDate } from './format.js';
import { rankedStories, type ArticleRow, type RankedStory } from './reads.js';
import { resolveNow } from './resolve.js';
import { findOutlet, markTold, muteOutlet } from './store.js';
import { NOT_SET_UP, type NotSetUp } from './tools.js';

export const EDITIONS = ['morning', 'midday', 'evening'] as const;
export type EditionKind = (typeof EDITIONS)[number];

/** Candidates an edition is offered by default, and at most. */
export const MATERIAL_DEFAULT = 12;
export const MATERIAL_MAX = 20;
/** The editions' usual times (Anchor's missions, spec §8), and which follows which. */
export const USUAL_TIMES: Record<EditionKind, string> = { morning: '07:00', midday: '12:30', evening: '19:00' };
const NEXT_EDITION: Record<EditionKind, EditionKind> = { morning: 'midday', midday: 'evening', evening: 'morning' };

/** Articles shown per story in the material. */
const ARTICLES_PER_STORY = 4;

type Db = BuddiHost['db'];

/* ------------------------------------------------------------------ *
 * The material
 * ------------------------------------------------------------------ */

export const editionMaterialInput = z
  .object({
    edition: z.enum(EDITIONS).describe('Which edition: morning, midday or evening.'),
    maxStories: z.coerce.number().int().min(3).max(MATERIAL_MAX).optional().describe(`How many candidates, ${MATERIAL_DEFAULT} when left out.`),
    next: z.string().trim().regex(/^([01]\d|2[0-3]):[0-5]\d$/, 'a time, HH:MM').optional().describe('The next edition\'s time when you know it ("12:30"); the usual times otherwise.'),
  })
  .strict();

export interface MaterialArticle {
  articleId: string;
  outlet: string;
  title: string;
  lead?: string;
  url: string;
  language: string;
  publishedAt: string;
  opinion: boolean;
  paywall: boolean;
}

export interface MaterialStory {
  id: string;
  title: string;
  lead: string;
  /** `new`: never told; `update`: told before, with news since (in `update`). */
  status: 'new' | 'update';
  /** What came since it was told: the articles that are new. */
  update?: { toldAt: string; articles: Array<{ outlet: string; title: string; url: string }> };
  link: string;
  languages: string[];
  /** Every article is opinion: label it ("Opinion, in National Review: …"). */
  opinion: boolean;
  outlets: Array<{ name: string; language: string | null; kind: string | null; lean?: string }>;
  articles: MaterialArticle[];
}

export interface EditionMaterial {
  edition: EditionKind;
  at: string;
  /** The owner's language: write in it, and note an outlet's when it differs. */
  language: string;
  /** Read this edition aloud too (Speech is there and the owner asked for it). */
  voice: boolean;
  /** Why there is no voice when the owner asked for one. */
  voiceOff?: string;
  /** The owner said "Quiet news today": tell nothing, report nothing. */
  quietToday: boolean;
  lastEdition: { kind: string; at: string } | null;
  /** The next edition, for the edition's last line ("— Anchor · next at 12:30"): the time given, or the usual one. */
  next: { edition: EditionKind; at: string };
  /** Untold first: stories grouped by topic, the topics in the owner's order, best first within each. */
  topics: Array<{ topic: string; topicId: string; stories: MaterialStory[] }>;
  /** Told already, nothing material since: never tell again, only so that no two lines are about one event. */
  alreadyTold: Array<{ id: string; title: string; topic: string }>;
  note: string;
}

const iso = (d: Date): string => d.toISOString();

function materialArticle(a: ArticleRow): MaterialArticle {
  return {
    articleId: a.id, outlet: a.outlet, title: a.title, ...(a.lead ? { lead: a.lead.slice(0, 280) } : {}), url: a.url, language: a.language,
    publishedAt: iso(a.published_at), opinion: a.opinion, paywall: a.paywall,
  };
}

/** The articles worth handing over: one per outlet, the owner's language and a publisher's own page first, newest last. */
function pickArticles(articles: ArticleRow[], language: string): ArticleRow[] {
  const seen = new Set<string>();
  const ranked = [...articles].sort((x, y) =>
    Number(y.language === language) - Number(x.language === language) ||
    Number(y.source_kind !== 'gnews') - Number(x.source_kind !== 'gnews') ||
    x.published_at.getTime() - y.published_at.getTime());
  const out: ArticleRow[] = [];
  for (const a of ranked) {
    const key = a.outlet_id ?? a.source_id;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(a);
    if (out.length >= ARTICLES_PER_STORY) break;
  }
  return out;
}

function materialStory(r: RankedStory, language: string): MaterialStory {
  const s = r.summary;
  const toldAt = s.lastToldAt ? new Date(s.lastToldAt) : null;
  const since = toldAt ? r.articles.filter((a) => a.fetched_at > toldAt) : [];
  const outlets = new Map<string, MaterialStory['outlets'][number]>();
  for (const a of r.articles) {
    const key = a.outlet_id ?? a.source_id;
    if (!outlets.has(key)) outlets.set(key, { name: a.outlet, language: a.language, kind: a.outlet_kind, ...(a.lean ? { lean: a.lean } : {}) });
  }
  return {
    id: s.id,
    title: s.title,
    lead: s.lead.slice(0, 300),
    status: s.status === 'update' ? 'update' : 'new',
    ...(s.status === 'update' && toldAt
      ? { update: { toldAt: iso(toldAt), articles: since.slice(-4).map((a) => ({ outlet: a.outlet, title: a.title, url: a.url })) } }
      : {}),
    link: s.url,
    languages: s.languages,
    opinion: s.opinion,
    outlets: [...outlets.values()],
    articles: pickArticles(r.articles, language).map(materialArticle),
  };
}

/**
 * Untold first (spec §8, Editions): the best untold story of every topic that
 * has one, then the rest by rank, up to `max`; grouped by topic in the
 * owner's order. Told stories with nothing material since are named apart.
 */
export function chooseMaterial(
  ranked: RankedStory[],
  topicOrder: string[],
  max: number,
): { picked: RankedStory[]; told: RankedStory[] } {
  const untold = ranked.filter((r) => r.summary.status !== 'told');
  const told = ranked.filter((r) => r.summary.status === 'told');
  const picked: RankedStory[] = [];
  for (const topic of topicOrder) {
    const best = untold.find((r) => r.summary.topicId === topic);
    if (best && picked.length < max) picked.push(best);
  }
  for (const r of untold) {
    if (picked.length >= max) break;
    if (!picked.includes(r)) picked.push(r);
  }
  const position = new Map(topicOrder.map((t, i) => [t, i]));
  picked.sort((a, b) =>
    (position.get(a.summary.topicId) ?? 999) - (position.get(b.summary.topicId) ?? 999) || b.summary.score - a.summary.score);
  return { picked, told };
}

async function settingsRow(db: Db): Promise<{ voice_editions: string[]; quiet_until: Date | null }> {
  const { rows } = await db.query<{ voice_editions: string[]; quiet_until: Date | null }>(`select voice_editions, quiet_until from news.settings`);
  return rows[0] ?? { voice_editions: [], quiet_until: null };
}

export async function editionMaterial(buddi: BuddiHost, input: z.infer<typeof editionMaterialInput>): Promise<EditionMaterial | NotSetUp> {
  const db = buddi.db;
  const { rows: topics } = await db.query<{ id: string; name: string }>(
    `select id, name from news.topics where not (muted_until is not null and muted_until > $1) order by position, name`,
    [buddi.clock.now()],
  );
  const { rows: any } = await db.query<{ n: number }>(`select count(*)::int as n from news.topics`);
  if ((any[0]?.n ?? 0) === 0) return { setUp: false, message: NOT_SET_UP };
  const now = buddi.clock.now();
  const language = ((await buddi.owner.language().catch(() => undefined)) ?? 'en').slice(0, 2);
  const settings = await settingsRow(db);
  const quietToday = settings.quiet_until !== null && settings.quiet_until > now;
  const asked = settings.voice_editions.includes(input.edition);
  const speech = buddi.plugins?.has?.('speech') ?? false;
  const { rows: last } = await db.query<{ kind: string; created_at: Date }>(`select kind, created_at from news.editions order by created_at desc limit 1`);
  const max = input.maxStories ?? MATERIAL_DEFAULT;
  const ranked = await rankedStories(db, now, { n: 300, since: new Date(now.getTime() - 24 * 3600_000), ownerLanguage: language });
  const { picked, told } = chooseMaterial(ranked, topics.map((t) => t.id), max);
  // The picks' Google News links the timer has not reached yet: the outlet's own, now.
  if (buddi.http) {
    const found = await resolveNow(db, buddi.http, picked.flatMap((r) => pickArticles(r.articles, language).map((a) => a.id)), now).catch(() => new Map<string, string>());
    for (const r of picked) {
      for (const a of r.articles) {
        const link = found.get(a.id);
        if (!link) continue;
        if (r.summary.url === a.url) r.summary.url = link;
        a.url = link;
      }
    }
  }
  const byTopic = new Map<string, MaterialStory[]>();
  for (const r of picked) byTopic.set(r.summary.topicId, [...(byTopic.get(r.summary.topicId) ?? []), materialStory(r, language)]);
  const untoldCount = picked.length;
  return {
    edition: input.edition,
    at: iso(now),
    language,
    voice: asked && speech,
    ...(asked && !speech ? { voiceOff: 'the Speech plugin is not installed' } : {}),
    quietToday,
    lastEdition: last[0] ? { kind: last[0].kind, at: iso(last[0].created_at) } : null,
    next: { edition: NEXT_EDITION[input.edition], at: input.next ?? USUAL_TIMES[NEXT_EDITION[input.edition]] },
    topics: topics.filter((t) => byTopic.has(t.id)).map((t) => ({ topic: t.name, topicId: t.id, stories: byTopic.get(t.id)! })),
    alreadyTold: told.slice(0, 10).map((r) => ({ id: r.summary.id, title: r.summary.title, topic: r.summary.topic })),
    note: quietToday
      ? 'The owner asked for quiet news today: tell nothing and report nothing until tomorrow.'
      : untoldCount < 3
        ? 'Little is new: a short edition that says so. Then news.edition_save with the stories told and the text.'
        : 'Untold first. Pick 5 to 8, one or two sentences each with their outlets and one link; label opinion; then news.edition_save with the story ids and the text.',
  };
}

export const editionMaterialTool: ToolDefinition<z.infer<typeof editionMaterialInput>, EditionMaterial | NotSetUp> = {
  name: 'news.edition_material',
  description:
    'The material for a news edition: untold stories first (new, or told with an update since), grouped by topic in the ' +
    'owner\'s order, each with its outlets (language, kind, and lean where known), 2 to 4 articles with links, whether it is ' +
    'opinion; the stories already told, the owner\'s language, whether to read it aloud, and whether the owner asked for ' +
    'quiet news today. Call it first when writing an edition (a mission may already have handed it to you).',
  tier: 'auto',
  untrusted: 'web',
  input: editionMaterialInput,
  execute: (input, ctx) => editionMaterial(ctx.buddi!, input),
};

export const editionMaterialExport: PluginExport = {
  description: 'The material for a news edition (morning, midday, evening): untold stories first, grouped by topic, with outlets, articles and links.',
  params: editionMaterialInput,
  produce: (params, ctx) => editionMaterial(ctx.buddi!, params as z.infer<typeof editionMaterialInput>),
};

/* ------------------------------------------------------------------ *
 * Saving an edition
 * ------------------------------------------------------------------ */

const editionSaveInput = z
  .object({
    edition: z.enum(EDITIONS),
    storyIds: z.array(z.string().trim().min(1).max(40)).min(1).max(MATERIAL_MAX).describe('The stories the edition told, by id.'),
    text: z.string().trim().min(1).max(6000).describe('The edition as sent.'),
  })
  .strict();

export interface EditionSaved {
  edition: string;
  told: Array<{ id: string; wasUpdate: boolean }>;
  unknown: string[];
  link: string;
}

export const editionSaveTool: ToolDefinition<z.infer<typeof editionSaveInput>, EditionSaved> = {
  name: 'news.edition_save',
  description:
    'Record a news edition once it is written: its text and the stories it told, so the next edition skips them unless ' +
    'they have a material update. The one write an edition makes; call it in the same turn as the report.',
  tier: 'auto',
  input: editionSaveInput,
  async execute(input, ctx) {
    const buddi = ctx.buddi!;
    const ids = [...new Set(input.storyIds)];
    const language = await buddi.owner.language().catch(() => undefined);
    const { editionId, marked } = await markTold(
      buddi.db, ids,
      { kind: input.edition, text: input.text, ...(ctx.agentId ? { agentId: ctx.agentId } : {}), ...(language ? { language } : {}) },
      buddi.clock.now(),
    );
    const seen = new Set(marked.map((m) => m.id));
    return { edition: editionId, told: marked, unknown: ids.filter((id) => !seen.has(id)), link: `#/p/news/stories?edition=${encodeURIComponent(editionId)}` };
  },
};

/* ------------------------------------------------------------------ *
 * Quiet news today
 * ------------------------------------------------------------------ */

const quietInput = z.object({ undo: z.boolean().optional().describe('Take it back: the next edition today goes out.') }).strict();

export const quietTodayTool: ToolDefinition<z.infer<typeof quietInput>, { quietUntil: string | null; note: string }> = {
  name: 'news.quiet_today',
  description:
    'The owner\'s "Quiet news today": the editions left today are skipped (their material says so) until midnight, then ' +
    'they resume by themselves. Call it when the owner taps Quiet news today or says so; undo: true takes it back.',
  tier: 'auto',
  input: quietInput,
  async execute(input, ctx) {
    const buddi = ctx.buddi!;
    const now = buddi.clock.now();
    const until = input.undo ? null : endOfDay(now, buddi.owner.timezone);
    await buddi.db.query(`update news.settings set quiet_until = $1`, [until]);
    return {
      quietUntil: until ? until.toISOString() : null,
      note: until ? 'No more news today. The editions come back tomorrow.' : 'The news is back on for today.',
    };
  },
};

/* ------------------------------------------------------------------ *
 * Muting an outlet: the owner's on the page, asked for from chat
 * ------------------------------------------------------------------ */

const muteOutletInput = z
  .object({
    outlet: z.string().trim().min(1).max(120).describe('An outlet by name ("Fox News") or site ("foxnews.com").'),
    muted: z.boolean().optional().describe('false turns it back on. Muting when left out.'),
  })
  .strict();

export const muteOutletTool: ToolDefinition<z.infer<typeof muteOutletInput>, { id: string; name: string; muted: boolean; note: string }> = {
  name: 'news.mute_outlet',
  description:
    'Mute a news outlet everywhere — its articles leave every story, the page and the editions — or turn it back on. ' +
    'Only when the owner asks ("stop showing me Fox News"); the owner approves it first.',
  // Asks the owner when an agent calls it; the owner's own button on the page does not ask (tierFor).
  tier: 'gated',
  async tierFor(_input, ctx) {
    return ctx.agentId === 'owner' ? { tier: 'auto' } : { tier: 'gated', reason: 'Muting an outlet changes what every edition reads from.' };
  },
  input: muteOutletInput,
  async describe(input, ctx) {
    const outlet = await findOutlet(ctx.buddi!.db, input.outlet);
    const name = outlet?.name ?? input.outlet;
    const muting = input.muted !== false;
    return {
      envelope: { outlet: outlet?.id ?? input.outlet, muted: muting },
      preview: muting
        ? `Mute ${name}: its articles leave every story, in News and in editions. Unmute it in Settings → News.`
        : `Turn ${name} back on: its articles come back to News and the editions.`,
    };
  },
  async execute(input, ctx: ToolContext) {
    const outlet = await findOutlet(ctx.buddi!.db, input.outlet);
    if (!outlet) throw new ToolRefusal(`No outlet called "${input.outlet}" in the news kept here.`);
    const muted = input.muted !== false;
    await muteOutlet(ctx.buddi!.db, outlet.id, muted);
    return { id: outlet.id, name: outlet.name, muted, note: muted ? `${outlet.name} is muted.` : `${outlet.name} is back.` };
  },
};

/* ------------------------------------------------------------------ *
 * Reading an article
 * ------------------------------------------------------------------ */

/** Reads a day, at most (spec §6): politeness to the outlets. */
export const READS_PER_DAY = 20;
/** How long a read is kept. */
const READ_KEEP_MS = 7 * 86_400_000;
/** The text handed back, at most. */
export const READ_TEXT_MAX = 12_000;

const readInput = z
  .object({
    storyId: z.string().trim().min(1).max(40).optional().describe('A story: its best article is read (the owner\'s language, an outlet\'s own page, not paywalled).'),
    articleId: z.string().trim().min(1).max(40).optional().describe('One article, from news.story or news.search.'),
  })
  .strict()
  .refine((v) => (v.storyId === undefined) !== (v.articleId === undefined), 'Name a storyId or an articleId, one of the two.');

export interface ReadResult {
  articleId: string;
  outlet: string;
  title: string;
  url: string;
  /** `ok`: the text is here; `refused`: not read (paywalled, robots.txt, the day's reads used); `failed`: the page gave no text. */
  status: 'ok' | 'refused' | 'failed';
  text?: string;
  reason?: string;
  lead?: string;
  fetchedAt?: string;
}

/** Whether robots.txt lets anyone (or buddi-news) fetch a path: the longest matching rule wins, Allow on a tie. */
export function robotsAllow(robots: string, path: string, agent = 'buddi-news'): boolean {
  const groups: Array<{ agents: string[]; rules: Array<{ allow: boolean; path: string }> }> = [];
  let current: (typeof groups)[number] | null = null;
  let lastWasAgent = false;
  for (const raw of robots.split(/\r?\n/)) {
    const line = raw.replace(/#.*/, '').trim();
    const m = /^([A-Za-z-]+)\s*:\s*(.*)$/.exec(line);
    if (!m) continue;
    const key = m[1]!.toLowerCase();
    const value = m[2]!.trim();
    if (key === 'user-agent') {
      if (!current || !lastWasAgent) {
        current = { agents: [], rules: [] };
        groups.push(current);
      }
      current.agents.push(value.toLowerCase());
      lastWasAgent = true;
    } else if ((key === 'allow' || key === 'disallow') && current) {
      lastWasAgent = false;
      if (value !== '') current.rules.push({ allow: key === 'allow', path: value });
    } else {
      lastWasAgent = false;
    }
  }
  const mine = groups.filter((g) => g.agents.some((a) => a !== '*' && agent.toLowerCase().startsWith(a)));
  const rules = (mine.length > 0 ? mine : groups.filter((g) => g.agents.includes('*'))).flatMap((g) => g.rules);
  let best: { allow: boolean; length: number } | null = null;
  for (const rule of rules) {
    const pattern = new RegExp(`^${rule.path.replace(/[.+?^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '.*').replace(/\\\$$/, '$')}`);
    if (!pattern.test(path)) continue;
    if (!best || rule.path.length > best.length || (rule.path.length === best.length && rule.allow)) best = { allow: rule.allow, length: rule.path.length };
  }
  return best ? best.allow : true;
}

/** An article page's text: the paragraphs of its `<article>` (or `<main>`, or body), without scripts, menus and asides. */
export function articleText(html: string): string {
  const cleaned = html
    .replace(/<!--[\s\S]*?-->/g, ' ')
    .replace(/<(script|style|noscript|svg|nav|header|footer|aside|form|figure|iframe|template)\b[\s\S]*?<\/\1>/gi, ' ');
  const scope = /<article\b[\s\S]*?<\/article>/i.exec(cleaned)?.[0] ?? /<main\b[\s\S]*?<\/main>/i.exec(cleaned)?.[0] ?? cleaned;
  const paragraphs = [...scope.matchAll(/<p\b[^>]*>([\s\S]*?)<\/p>/gi)]
    .map((m) => decodeEntities(m[1]!.replace(/<[^>]+>/g, ' ')).replace(/\s+/g, ' ').trim())
    .filter((p) => p.length >= 40);
  const text = paragraphs.length > 0 ? paragraphs.join('\n\n') : plainText(scope);
  return text.length > READ_TEXT_MAX ? `${text.slice(0, READ_TEXT_MAX).replace(/\s+\S*$/, '')}…` : text;
}

async function chooseArticle(db: Db, input: { storyId?: string; articleId?: string }, language: string): Promise<{
  id: string; title: string; lead: string; url: string; outlet: string; paywall: boolean; source_kind: string;
} | undefined> {
  const { rows } = await db.query<{ id: string; title: string; lead: string; url: string; outlet: string; paywall: boolean; source_kind: string; language: string }>(
    `select a.id, a.title, a.lead, a.url, coalesce(o.name, src.name) as outlet, coalesce(o.paywall, false) as paywall, src.kind as source_kind, a.language
       from news.articles a
       join news.sources src on src.id = a.source_id
       left join news.outlets o on o.id = a.outlet_id
      where ($1::text is not null and a.id = $1)
         or ($2::text is not null and a.id in (select article_id from news.article_topics where story_id = $2))`,
    [input.articleId ?? null, input.storyId ?? null],
  );
  return [...rows].sort((x, y) =>
    Number(!y.paywall) - Number(!x.paywall) ||
    Number(y.source_kind !== 'gnews') - Number(x.source_kind !== 'gnews') ||
    Number(y.language === language) - Number(x.language === language))[0];
}

export async function readArticle(ctx: ToolContext, input: { storyId?: string; articleId?: string }): Promise<ReadResult> {
  const buddi = ctx.buddi!;
  const db = buddi.db;
  const now = buddi.clock.now();
  const language = ((await buddi.owner.language().catch(() => undefined)) ?? 'en').slice(0, 2);
  const article = await chooseArticle(db, input, language);
  if (!article) throw new ToolRefusal(input.storyId ? `No story ${input.storyId} kept here.` : `No article ${input.articleId} kept here.`);
  const base = { articleId: article.id, outlet: article.outlet, title: article.title, url: article.url, ...(article.lead ? { lead: article.lead } : {}) };
  const keep = async (status: ReadResult['status'], text: string, reason?: string): Promise<void> => {
    await db.query(
      `insert into news.article_texts (article_id, status, text, reason, fetched_at) values ($1, $2, $3, $4, $5)
       on conflict (article_id) do update set status = excluded.status, text = excluded.text, reason = excluded.reason, fetched_at = excluded.fetched_at`,
      [article.id, status, text, reason ?? null, now],
    );
  };
  if (article.paywall) return { ...base, status: 'refused', reason: 'The outlet is paywalled: answer from the headline and the summary, and say so.' };
  // Fetched once: a read within the week is answered from what was kept, whatever it said.
  const { rows: kept } = await db.query<{ status: ReadResult['status']; text: string; reason: string | null; fetched_at: Date }>(
    `select status, text, reason, fetched_at from news.article_texts where article_id = $1 and fetched_at > $2`,
    [article.id, new Date(now.getTime() - READ_KEEP_MS)],
  );
  const cached = kept[0];
  if (cached) {
    return { ...base, status: cached.status, ...(cached.text ? { text: cached.text } : {}), ...(cached.reason ? { reason: cached.reason } : {}), fetchedAt: cached.fetched_at.toISOString() };
  }
  const { rows: today } = await db.query<{ n: number }>(
    `select count(*)::int as n from news.article_texts where fetched_at >= $1 and status <> 'refused'`,
    [startOfDay(now, buddi.owner.timezone)],
  );
  if ((today[0]?.n ?? 0) >= READS_PER_DAY) {
    return { ...base, status: 'refused', reason: `${READS_PER_DAY} articles were read today already; answer from the summaries until tomorrow.` };
  }
  const http = buddi.http;
  if (!http) throw new ToolRefusal('This buddi gives the news plugin no web access.');
  let target: URL;
  try {
    target = new URL(article.url);
  } catch {
    return { ...base, status: 'failed', reason: 'The article has no address that can be read.' };
  }
  const declared = buddi.network.declared().map((d) => d.host);
  if (!hostDeclared(target.hostname, declared)) {
    await keep('refused', '', `${target.hostname} is not one of the sites this plugin reads.`);
    return { ...base, status: 'refused', reason: `${target.hostname} is not one of the sites this plugin reads.` };
  }
  const allowHost = (host: string): boolean => hostDeclared(host, buddi.network.declared().map((d) => d.host));
  try {
    const robots = await politeGet(http, `${target.origin}/robots.txt`, { maxBytes: 256 * 1024, headers: { accept: 'text/plain' }, allowHost }).catch(() => null);
    if (robots && robots.response.ok) {
      const text = new TextDecoder('utf-8').decode(await robots.response.arrayBuffer());
      if (!robotsAllow(text, `${target.pathname}${target.search}`)) {
        await keep('refused', '', 'The outlet asks robots not to read this page (robots.txt).');
        return { ...base, status: 'refused', reason: 'The outlet asks robots not to read this page (robots.txt): answer from the summary.' };
      }
    }
    const { response } = await politeGet(http, article.url, { headers: { accept: 'text/html' }, allowHost });
    if (!response.ok) throw new FetchError(`the page answered ${response.status}`, response.status);
    const text = articleText(new TextDecoder('utf-8').decode(await response.arrayBuffer()));
    if (text.length < 200) {
      await keep('failed', '', 'The page has no article text this plugin could read.');
      return { ...base, status: 'failed', reason: 'The page has no article text this plugin could read: answer from the summary.' };
    }
    await keep('ok', text);
    return { ...base, status: 'ok', text, fetchedAt: now.toISOString() };
  } catch (err) {
    const reason = `The page could not be read: ${err instanceof Error ? err.message : String(err)}.`;
    await keep('failed', '', reason);
    return { ...base, status: 'failed', reason };
  }
}

export const readTool: ToolDefinition<z.infer<typeof readInput>, ReadResult> = {
  name: 'news.read',
  description:
    'The text of a news article, fetched once from the outlet when the summary is not enough to answer, and kept a week: ' +
    'a story\'s best article, or one article. Refused for a paywalled outlet, a page its robots.txt closes, and past 20 ' +
    'reads a day; then answer from the headline and summary and say so.',
  tier: 'auto',
  untrusted: 'web',
  input: readInput as unknown as z.ZodType<z.infer<typeof readInput>>,
  execute: (input, ctx) => readArticle(ctx, input),
};

/** "Quiet until Sat 10 Oct" for the settings page. */
export function quietWords(until: Date | null, now: Date, zone: string): string | null {
  return until && until > now ? `Quiet until ${shortDate(until, zone)}` : null;
}

export const editionTools = [editionMaterialTool, editionSaveTool, quietTodayTool, readTool, muteOutletTool];
