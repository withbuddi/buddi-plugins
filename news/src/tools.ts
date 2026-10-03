/**
 * The tools a model sees. Four read (`news.topics`, `news.headlines`,
 * `news.story`, `news.search`); two keep the plugin's own bookkeeping
 * (`news.mark_told`, for Anchor or a brief once it has told stories, and
 * `news.feedback`, the owner's "not interested", mute and snooze, said in
 * chat). All `auto`: nothing here leaves the machine or changes anything but
 * this plugin's own rows. What outlets wrote is someone else's text, so the
 * reads are marked `untrusted: 'web'`.
 *
 * With no topic yet, a read answers `{ setUp: false, message }` rather than
 * an empty list that would read as "no news".
 */
import { z } from 'zod';
import type { BuddiHost, ToolDefinition } from '@buddi/core/plugin';
import { ToolRefusal } from '@buddi/core/plugin';
import { headlines, listTopics, search, sourceHealth, story, type SearchHit, type StoryDetail, type StorySummary, type TopicSummary } from './reads.js';
import { findOutlet, findTopic, hideStory, markTold, muteOutlet, muteTopic } from './store.js';

export const NOT_SET_UP = 'No news topic yet. Add a topic or turn on the starter sources on Settings → News.';
export const MAX_HEADLINES = 10;
export const MAX_SEARCH_DAYS = 14;

export interface NotSetUp {
  setUp: false;
  message: string;
}

/** `6h`, `2d`, `90m`, or an ISO date; undefined when it is neither. */
export function parseSince(text: string | undefined, now: Date): Date | undefined {
  if (!text) return undefined;
  const rel = /^\s*(\d{1,4})\s*(m|min|h|d)\s*$/i.exec(text);
  if (rel) {
    const unit = rel[2]!.toLowerCase();
    const ms = Number(rel[1]) * (unit === 'd' ? 86_400_000 : unit === 'h' ? 3_600_000 : 60_000);
    return new Date(now.getTime() - ms);
  }
  const at = Date.parse(text);
  return Number.isNaN(at) ? undefined : new Date(at);
}

async function hasTopics(buddi: BuddiHost): Promise<boolean> {
  const { rows } = await buddi.db.query<{ n: number }>(`select count(*)::int as n from news.topics`);
  return (rows[0]?.n ?? 0) > 0;
}

async function resolveTopic(buddi: BuddiHost, name: string | undefined): Promise<{ id: string; name: string } | undefined> {
  if (!name) return undefined;
  const topic = await findTopic(buddi.db, name);
  if (!topic) throw new Error(`No topic called "${name}". news.topics lists them.`);
  return topic;
}

const ownerLanguage = (buddi: BuddiHost): Promise<string | undefined> => buddi.owner.language().catch(() => undefined);

/* ------------------------------------------------------------------ */

const empty = z.object({}).strict() as unknown as z.ZodType<Record<string, never>>;

export interface TopicsOutput {
  topics: Array<TopicSummary & { sourcesFailing: string[] }>;
}

export const topicsTool: ToolDefinition<Record<string, never>, TopicsOutput | NotSetUp> = {
  name: 'news.topics',
  description:
    'The news topics the owner follows: each one\'s id, name, keywords, how many sources feed it and which are failing, ' +
    'whether the owner muted it, and how many stories it had in the last 24 hours.',
  tier: 'auto',
  input: empty,
  async execute(_input, ctx) {
    const buddi = ctx.buddi!;
    const topics = await listTopics(buddi.db, buddi.clock.now());
    if (topics.length === 0) return { setUp: false, message: NOT_SET_UP };
    const health = await sourceHealth(buddi.db);
    return {
      topics: topics.map((t) => ({
        ...t,
        sourcesFailing: health.filter((h) => h.topics.includes(t.id) && !h.muted && h.state !== 'ok').map((h) => `${h.name}: ${h.lastError ?? h.state}`),
      })),
    };
  },
};

export const headlinesInput = z
  .object({
    topic: z.string().trim().min(1).max(80).optional().describe('A topic id or name (see news.topics). Every topic when left out.'),
    n: z.coerce.number().int().min(1).max(MAX_HEADLINES).optional().describe('How many stories, 5 when left out, at most 10.'),
    since: z.string().trim().max(40).optional().describe('Only stories with an article since: "6h", "2d", or an ISO date. The last 24 hours when left out.'),
    untold: z.boolean().optional().describe('Only stories not told yet (status new) or told with a material update since (status update).'),
  })
  .strict();

export interface HeadlinesOutput {
  topic: string;
  since: string;
  stories: StorySummary[];
}

/** Shared by the tool and the export: the read, with the topic resolved. */
export async function readHeadlines(buddi: BuddiHost, input: z.infer<typeof headlinesInput>): Promise<HeadlinesOutput | NotSetUp> {
  if (!(await hasTopics(buddi))) return { setUp: false, message: NOT_SET_UP };
  const now = buddi.clock.now();
  const topic = await resolveTopic(buddi, input.topic);
  const since = parseSince(input.since, now) ?? new Date(now.getTime() - 24 * 3600_000);
  const language = await ownerLanguage(buddi);
  const stories = await headlines(buddi.db, now, {
    ...(topic ? { topicId: topic.id } : {}), n: input.n ?? 5, since, untold: input.untold ?? false, ...(language ? { ownerLanguage: language } : {}),
  });
  return { topic: topic?.name ?? 'All topics', since: since.toISOString(), stories };
}

export const headlinesTool: ToolDefinition<z.infer<typeof headlinesInput>, HeadlinesOutput | NotSetUp> = {
  name: 'news.headlines',
  description:
    'The top news stories for a topic (or every topic) in rank order, each grouped from several outlets: title, lead, ' +
    'link, outlets, languages, times, and whether it was told already (new, update, told). Use it for "what\'s the news", ' +
    'a brief, or before telling the owner about a topic; untold: true for what has not been told.',
  tier: 'auto',
  untrusted: 'web',
  input: headlinesInput,
  execute: (input, ctx) => readHeadlines(ctx.buddi!, input),
};

export const storyInput = z.object({ id: z.string().trim().min(1).max(40).describe('A story id from news.headlines or news.search.') }).strict();

export async function readStory(buddi: BuddiHost, id: string): Promise<StoryDetail | undefined> {
  return story(buddi.db, buddi.clock.now(), id, await ownerLanguage(buddi));
}

export const storyTool: ToolDefinition<z.infer<typeof storyInput>, StoryDetail | { found: false; message: string }> = {
  name: 'news.story',
  description:
    'One news story in full: every article on it with its outlet, language, title, lead, link and time (the timeline), ' +
    'which are opinion or paywalled, and when it was told. Use it before saying more about a story than its title.',
  tier: 'auto',
  untrusted: 'web',
  input: storyInput,
  async execute(input, ctx) {
    return (await readStory(ctx.buddi!, input.id)) ?? { found: false, message: `No story ${input.id}: it may be past the retention, or the owner turned it away.` };
  },
};

const searchInput = z
  .object({
    query: z.string().trim().min(2).max(200).describe('Words every matching article contains, in English or French; case and accents do not matter.'),
    topic: z.string().trim().min(1).max(80).optional(),
    days: z.coerce.number().int().min(1).max(MAX_SEARCH_DAYS).optional().describe('How far back, 7 days when left out, at most 14.'),
    n: z.coerce.number().int().min(1).max(MAX_HEADLINES).optional(),
  })
  .strict();

export const searchTool: ToolDefinition<z.infer<typeof searchInput>, { query: string; articles: SearchHit[] } | NotSetUp> = {
  name: 'news.search',
  description:
    'Search the articles kept on this machine from the owner\'s sources for every word of the query, newest first, each ' +
    'with its story id, outlet, link and language. Answer questions about the news from these, never from memory.',
  tier: 'auto',
  untrusted: 'web',
  input: searchInput,
  async execute(input, ctx) {
    const buddi = ctx.buddi!;
    if (!(await hasTopics(buddi))) return { setUp: false, message: NOT_SET_UP };
    const topic = await resolveTopic(buddi, input.topic);
    const articles = await search(buddi.db, buddi.clock.now(), { text: input.query, ...(topic ? { topicId: topic.id } : {}), days: input.days ?? 7, n: input.n ?? MAX_HEADLINES });
    return { query: input.query, articles };
  },
};

const markToldInput = z
  .object({
    storyIds: z.array(z.string().trim().min(1).max(40)).min(1).max(50),
    edition: z.string().trim().regex(/^[a-z0-9][a-z0-9_-]{0,39}$/, 'a short name in lower case: morning, midday, evening, brief').describe('Which telling: "morning", "midday", "evening", "brief", …'),
  })
  .strict();

export const markToldTool: ToolDefinition<z.infer<typeof markToldInput>, { edition: string; marked: Array<{ id: string; wasUpdate: boolean }>; unknown: string[] }> = {
  name: 'news.mark_told',
  description:
    'Record that these stories were told to the owner (by Anchor, in a brief), so news.headlines with untold: true leaves ' +
    'them out until there is a material update. Call it once the stories have actually been told.',
  tier: 'auto',
  input: markToldInput,
  async execute(input, ctx) {
    const buddi = ctx.buddi!;
    const ids = [...new Set(input.storyIds)];
    const language = await ownerLanguage(buddi);
    const { editionId, marked } = await markTold(buddi.db, ids, { kind: input.edition, ...(ctx.agentId ? { agentId: ctx.agentId } : {}), ...(language ? { language } : {}) }, buddi.clock.now());
    const seen = new Set(marked.map((m) => m.id));
    return { edition: editionId, marked, unknown: ids.filter((id) => !seen.has(id)) };
  },
};

const feedbackInput = z
  .object({
    storyId: z.string().trim().min(1).max(40).optional(),
    outlet: z.string().trim().min(1).max(120).optional().describe('An outlet by name ("Le Monde") or site ("lemonde.fr").'),
    topic: z.string().trim().min(1).max(80).optional(),
    action: z.enum(['not_interested', 'mute', 'snooze', 'clear']).describe(
      'not_interested: never this story again; mute: this topic for a week (an outlet is muted with news.mute_outlet, which asks the owner); snooze: not until tomorrow (or hours); clear: take one of these back.'),
    hours: z.coerce.number().int().min(1).max(24 * 30).optional().describe('How long a snooze or a topic mute lasts.'),
  })
  .strict();

export interface FeedbackOutput {
  kind: 'story' | 'outlet' | 'topic';
  subject: string;
  action: 'not_interested' | 'mute' | 'snooze' | 'clear';
  until: string | null;
  note: string;
}

export const feedbackTool: ToolDefinition<z.infer<typeof feedbackInput>, FeedbackOutput> = {
  name: 'news.feedback',
  description:
    'The owner\'s word on the news: not interested in a story, mute an outlet or a topic, snooze a story or a topic, or ' +
    'clear one of these. Use it when the owner says so ("stop showing me this", "not today"), never on your own. Name exactly one of storyId, outlet or topic.',
  tier: 'auto',
  input: feedbackInput,
  async execute(input, ctx) {
    const named = [input.storyId, input.outlet, input.topic].filter(Boolean).length;
    if (named !== 1) throw new Error('Name exactly one of storyId, outlet or topic.');
    const buddi = ctx.buddi!;
    const now = buddi.clock.now();
    const hoursFrom = (h: number): Date => new Date(now.getTime() + h * 3600_000);
    if (input.storyId) {
      const { rows } = await buddi.db.query<{ title: string }>(`select title from news.stories where id = $1`, [input.storyId]);
      if (!rows[0]) throw new Error(`No story ${input.storyId}.`);
      const label = `“${rows[0].title}”`;
      if (input.action === 'clear') {
        await hideStory(buddi.db, input.storyId, null, null);
        return { kind: 'story', subject: input.storyId, action: 'clear', until: null, note: `${label} is back.` };
      }
      if (input.action === 'snooze') {
        const until = hoursFrom(input.hours ?? 24);
        await hideStory(buddi.db, input.storyId, 'snoozed', until);
        return { kind: 'story', subject: input.storyId, action: 'snooze', until: until.toISOString(), note: `${label} is snoozed until ${until.toISOString()}, or until it has news.` };
      }
      await hideStory(buddi.db, input.storyId, 'not_interested', null);
      return { kind: 'story', subject: input.storyId, action: 'not_interested', until: null, note: `${label} will not come up again.` };
    }
    if (input.topic) {
      const topic = await findTopic(buddi.db, input.topic);
      if (!topic) throw new Error(`No topic called "${input.topic}".`);
      if (input.action === 'clear') {
        await muteTopic(buddi.db, topic.id, null);
        return { kind: 'topic', subject: topic.id, action: 'clear', until: null, note: `${topic.name} is back.` };
      }
      const until = hoursFrom(input.hours ?? (input.action === 'snooze' ? 24 : 24 * 7));
      await muteTopic(buddi.db, topic.id, until);
      const action = input.action === 'snooze' ? 'snooze' : 'mute';
      return { kind: 'topic', subject: topic.id, action, until: until.toISOString(), note: `${topic.name} is quiet until ${until.toISOString()}.` };
    }
    const outlet = await findOutlet(buddi.db, input.outlet!);
    if (!outlet) throw new Error(`No outlet called "${input.outlet}" in the news kept here.`);
    if (input.action === 'snooze') throw new Error('An outlet is muted or not; snooze a story or a topic instead.');
    // Muting an outlet asks the owner first (news.mute_outlet); taking a mute back does not.
    if (input.action !== 'clear') throw new ToolRefusal(`Muting ${outlet.name} asks the owner first: call news.mute_outlet.`);
    const muted = false;
    await muteOutlet(buddi.db, outlet.id, muted);
    return { kind: 'outlet', subject: outlet.id, action: muted ? 'mute' : 'clear', until: null, note: muted ? `${outlet.name} is muted.` : `${outlet.name} is back.` };
  },
};

export const modelTools = [topicsTool, headlinesTool, storyTool, searchTool, markToldTool, feedbackTool];
