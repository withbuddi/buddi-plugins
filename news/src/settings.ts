/**
 * What the owner changes, for the source manager that comes with the UI
 * (spec §6, page tools): the starter sources, their own topics and feeds,
 * muting, Try again, settings, fetching now. `ownerOnly` tools, so no model
 * is shown them. Beside them the page queries a screen will read: the
 * sources with their health, and an outlet's logo as an image — the one
 * served route for a logo until the host has an assets area.
 */
import { z } from 'zod';
import type { HttpArea, PageQuery, ToolDefinition, ToolContext } from '@buddi/core/plugin';
import { decodeBytes, parseFeed } from './feed.js';
import { politeGet, FetchError } from './fetch.js';
import { declareRuntimeHosts, fetchMissingLogos, refresh, type RefreshReport } from './poller.js';
import { sourceHealth, type SourceHealth } from './reads.js';
import { addSourceRow, enableStarter, ensureOutlet, ensureTopic, findTopic, hideStory, muteTopic, retrySource, slug } from './store.js';
import { gnewsUrl, STARTER_TOPICS, type Language } from './starter.js';
import { outletHost } from './canonical.js';
import { MEANING_MODEL, meaningFor, megabytes, modelBytes, type MeaningState } from './meaning.js';

const languageField = z.enum(['en', 'fr']);

const starterInput = z
  .object({ topics: z.array(z.enum(STARTER_TOPICS.map((t) => t.id) as [string, ...string[]])).max(STARTER_TOPICS.length).optional() })
  .strict();

export const enableStarterTool: ToolDefinition<z.infer<typeof starterInput>, { topics: string[]; sources: number; note: string }> = {
  name: 'news.enable_starter',
  description: 'Turn on the starter topics (all, or those named) with their checked English and French sources.',
  tier: 'auto',
  ownerOnly: true,
  input: starterInput,
  async execute(input, ctx) {
    const buddi = ctx.buddi!;
    const result = await enableStarter(buddi.db, buddi.clock.now(), input.topics);
    return { ...result, note: `Reading ${result.sources} sources for ${result.topics.join(', ')}. The first stories appear in a minute.` };
  },
};

/** Find the feed behind an address: the address itself when it is one, else the page's `<link rel="alternate">`. */
export async function discoverFeed(http: HttpArea, url: string, depth = 0): Promise<{ url: string; kind: 'rss' | 'atom'; title: string; site?: string; items: number; language?: string }> {
  const { response, url: at } = await politeGet(http, url);
  if (!response.ok) throw new FetchError(`${url} answered ${response.status}`);
  const text = decodeBytes(new Uint8Array(await response.arrayBuffer()), response.headers.get('content-type'));
  try {
    const feed = parseFeed(text, at);
    return {
      url: at, kind: feed.format === 'atom' ? 'atom' : 'rss', title: feed.title, items: feed.items.length,
      ...(feed.link ? { site: new URL(feed.link).origin } : {}), ...(feed.language ? { language: feed.language } : {}),
    };
  } catch {
    const alt = [...text.matchAll(/<link\b[^>]*>/gi)]
      .map((m) => m[0])
      .find((tag) => /rel\s*=\s*["']?alternate/i.test(tag) && /application\/(rss|atom)\+xml/i.test(tag));
    const href = alt ? /href\s*=\s*["']([^"']+)["']/i.exec(alt)?.[1] : undefined;
    if (!href || depth > 0) throw new FetchError(`${url} is not a feed, and the page names none`);
    const found = await discoverFeed(http, new URL(href, at).toString(), depth + 1);
    return { ...found, site: found.site ?? new URL(at).origin };
  }
}

const topicLinks = z.array(z.object({ topic: z.string().trim().min(1).max(80), filter: z.enum(['none', 'keywords']).optional() }).strict()).min(1).max(10);

const addSourceInput = z
  .object({
    url: z.string().trim().url().max(500).describe('A feed, or a page that names one.'),
    topics: topicLinks,
    name: z.string().trim().min(1).max(80).optional(),
    language: languageField.optional(),
  })
  .strict();

export interface AddedSource {
  id: string;
  name: string;
  url: string;
  outlet: string;
  language: Language;
  items: number;
  logo: boolean;
  note: string;
}

async function addSource(ctx: ToolContext, input: z.infer<typeof addSourceInput>): Promise<AddedSource> {
  const buddi = ctx.buddi!;
  const http = buddi.http!;
  const topics: Array<{ topic: string; filter?: 'keywords' }> = [];
  for (const t of input.topics) {
    const topic = await findTopic(buddi.db, t.topic);
    if (!topic) throw new Error(`No topic called "${t.topic}".`);
    topics.push({ topic: topic.id, ...(t.filter === 'keywords' ? { filter: 'keywords' as const } : {}) });
  }
  // The owner named this address: declare its host before the first request, so it is listed with what leaves the machine.
  buddi.network.declare([{ host: new URL(input.url).hostname, why: 'A feed you added: the address is asked for its latest items.' }]);
  const feed = await discoverFeed(http, input.url);
  buddi.network.declare([{ host: new URL(feed.url).hostname, why: 'A feed you added: the address is asked for its latest items.' }]);
  const domain = outletHost(feed.site ?? feed.url);
  const name = input.name ?? (feed.title || domain);
  const language: Language = input.language ?? (feed.language?.toLowerCase().startsWith('fr') ? 'fr' : 'en');
  const outletId = await ensureOutlet(buddi.db, domain, name, { language });
  const id = slug(name).slice(0, 60);
  const added = await addSourceRow(buddi.db, { id, name, kind: feed.kind, url: feed.url, language, outletId, addedBy: 'owner' }, topics, buddi.clock.now());
  if (!added) throw new Error(`${feed.url} is already a source (or one is called ${name}).`);
  await declareRuntimeHosts(buddi);
  const logo = outletId ? (await fetchMissingLogos(buddi, 1, undefined, outletId)) > 0 : false;
  return { id, name, url: feed.url, outlet: domain, language, items: feed.items, logo, note: `Added ${name} (${language === 'fr' ? 'French' : 'English'}), ${feed.items} articles.` };
}

export const addSourceTool: ToolDefinition<z.infer<typeof addSourceInput>, AddedSource> = {
  name: 'news.add_source',
  description: 'Add a feed to topics: the address is checked to answer a feed (or a page naming one), its outlet made and its logo fetched once.',
  tier: 'auto',
  ownerOnly: true,
  input: addSourceInput,
  execute: (input, ctx) => addSource(ctx, input),
};

const setSourceInput = z
  .object({ id: z.string().trim().min(1).max(80), muted: z.boolean().optional(), topics: topicLinks.optional(), name: z.string().trim().min(1).max(80).optional() })
  .strict();

export const setSourceTool: ToolDefinition<z.infer<typeof setSourceInput>, { id: string }> = {
  name: 'news.set_source',
  description: 'Change a source: mute it or turn it back on, rename it, or set the topics it feeds (with a keywords filter).',
  tier: 'auto',
  ownerOnly: true,
  input: setSourceInput,
  async execute(input, ctx) {
    const db = ctx.buddi!.db;
    return db.transaction(async (tx) => {
      const { rowCount } = await tx.query(
        `update news.sources set muted = coalesce($2, muted), name = coalesce($3, name), next_at = case when $2 = false then now() else next_at end where id = $1`,
        [input.id, input.muted ?? null, input.name ?? null],
      );
      if (!rowCount) throw new Error(`No source ${input.id}.`);
      if (input.topics) {
        await tx.query(`delete from news.topic_sources where source_id = $1`, [input.id]);
        for (const t of input.topics) {
          const topic = await findTopic(tx, t.topic);
          if (!topic) throw new Error(`No topic called "${t.topic}".`);
          await tx.query(`insert into news.topic_sources (topic_id, source_id, filter) values ($1, $2, $3)`, [topic.id, input.id, t.filter ?? 'none']);
        }
      }
      return { id: input.id };
    });
  },
};

const idInput = z.object({ id: z.string().trim().min(1).max(80) }).strict();
const removeInput = z
  .object({ id: z.string().trim().min(1).max(80), topic: z.string().trim().min(1).max(80).optional().describe('Only from this topic; the source goes when it feeds no other.') })
  .strict();

export const removeSourceTool: ToolDefinition<z.infer<typeof removeInput>, { removed: boolean }> = {
  name: 'news.remove_source',
  description: 'Remove a source (from one topic, or altogether) and the articles only it brought.',
  tier: 'auto',
  ownerOnly: true,
  input: removeInput,
  async execute(input, ctx) {
    const buddi = ctx.buddi!;
    if (input.topic) {
      await buddi.db.query(`delete from news.topic_sources where source_id = $1 and topic_id = $2`, [input.id, input.topic]);
      await buddi.db.query(
        `delete from news.article_topics at using news.articles a where a.id = at.article_id and a.source_id = $1 and at.topic_id = $2`,
        [input.id, input.topic],
      );
      const { rows: left } = await buddi.db.query<{ n: number }>(`select count(*)::int as n from news.topic_sources where source_id = $1`, [input.id]);
      if ((left[0]?.n ?? 0) > 0) {
        await buddi.db.query(`delete from news.stories s where not exists (select 1 from news.article_topics at where at.story_id = s.id)`);
        return { removed: true };
      }
    }
    const { rows } = await buddi.db.query<{ url: string; final_url: string | null; added_by: string }>(`delete from news.sources where id = $1 returning url, final_url, added_by`, [input.id]);
    await buddi.db.query(`delete from news.stories s where not exists (select 1 from news.article_topics at where at.story_id = s.id)`);
    const removed = rows[0];
    if (removed?.added_by === 'owner') {
      const hosts = [removed.url, removed.final_url].filter((u): u is string => !!u).map((u) => new URL(u).hostname);
      const { rows: still } = await buddi.db.query<{ n: number }>(`select count(*)::int as n from news.sources where added_by = 'owner' and (url like any($1) or final_url like any($1))`, [hosts.map((h) => `%://${h}/%`)]);
      if ((still[0]?.n ?? 0) === 0) buddi.network.undeclare(hosts);
    }
    return { removed: removed !== undefined };
  },
};

export const retrySourceTool: ToolDefinition<z.infer<typeof idInput>, { id: string; retried: boolean }> = {
  name: 'news.retry_source',
  description: 'Try a failing or paused source again now.',
  tier: 'auto',
  ownerOnly: true,
  input: idInput,
  async execute(input, ctx) {
    return { id: input.id, retried: await retrySource(ctx.buddi!.db, input.id, ctx.buddi!.clock.now()) };
  },
};

const addTopicInput = z
  .object({
    name: z.string().trim().min(2).max(60),
    keywords: z.union([z.array(z.string().trim().min(1).max(60)).min(1).max(20), z.string().trim().min(1).max(600)])
      .transform((k) => (Array.isArray(k) ? k : k.split(',').map((w) => w.trim()).filter(Boolean).slice(0, 20)))
      .describe('What Google News is searched for, and the words the topic is about (a list, or words separated by commas).'),
    languages: z.array(languageField).min(1).max(2).optional(),
    feeds: z.union([z.array(z.string().trim().url().max(500)).max(20), z.string().trim().max(500)])
      .transform((f) => (Array.isArray(f) ? f : f === '' ? [] : [/^https?:\/\//i.test(f) ? f : `https://${f}`]))
      .optional()
      .describe('Feeds or pages that name one. With none, the topic follows a Google News search for its keywords.'),
  })
  .strict();

export const addTopicTool: ToolDefinition<z.infer<typeof addTopicInput>, { id: string; sources: number; problems: string[]; note: string }> = {
  name: 'news.add_topic',
  description: 'Add a topic of the owner\'s own: a name, keywords, and feeds; with no feed, a Google News search in each language.',
  tier: 'auto',
  ownerOnly: true,
  input: addTopicInput as unknown as z.ZodType<z.infer<typeof addTopicInput>>,
  async execute(input, ctx) {
    const buddi = ctx.buddi!;
    const now = buddi.clock.now();
    if (await findTopic(buddi.db, input.name)) throw new Error(`There is already a topic called ${input.name}.`);
    const id = slug(input.name);
    const languages = (input.languages ?? ['en', 'fr']) as Language[];
    await ensureTopic(buddi.db, { id, name: input.name, keywords: input.keywords, builtin: false, languages });
    let sources = 0;
    const problems: string[] = [];
    for (const feed of input.feeds ?? []) {
      try {
        await addSource(ctx, { url: feed, topics: [{ topic: id }] });
        sources += 1;
      } catch (err) {
        problems.push(err instanceof Error ? err.message : String(err));
      }
    }
    if (sources === 0) {
      const query = input.keywords.map((k) => (/\s/.test(k) ? `"${k}"` : k)).join(' OR ');
      for (const language of languages) {
        const added = await addSourceRow(
          buddi.db,
          { id: `${id}-google-news-${language}`, name: `Google News · ${input.name}`, kind: 'gnews', url: gnewsUrl(`${query} when:2d`, language), language, outletId: null, addedBy: 'owner' },
          [{ topic: id }], now,
        );
        if (added) sources += 1;
      }
    }
    return { id, sources, problems, note: `Added ${input.name}, reading ${sources} ${sources === 1 ? 'source' : 'sources'}.${problems.length ? ` ${problems[0]}` : ''}` };
  },
};

const setTopicInput = z
  .object({
    topic: z.string().trim().min(1).max(80),
    name: z.string().trim().min(2).max(60).optional(),
    keywords: z.array(z.string().trim().min(1).max(60)).min(1).max(20).optional(),
    mutedForHours: z.number().int().min(0).max(24 * 365).optional().describe('0 takes a mute back.'),
    muted: z.boolean().optional().describe('Mute for good (true), or take any mute back (false).'),
  })
  .strict();

export const setTopicTool: ToolDefinition<z.infer<typeof setTopicInput>, { id: string }> = {
  name: 'news.set_topic',
  description: 'Change a topic: its name, its keywords, or mute it for some hours.',
  tier: 'auto',
  ownerOnly: true,
  input: setTopicInput,
  async execute(input, ctx) {
    const buddi = ctx.buddi!;
    const topic = await findTopic(buddi.db, input.topic);
    if (!topic) throw new Error(`No topic called "${input.topic}".`);
    await buddi.db.query(`update news.topics set name = coalesce($2, name), keywords = coalesce($3, keywords) where id = $1`, [topic.id, input.name ?? null, input.keywords ?? null]);
    if (input.muted !== undefined) await muteTopic(buddi.db, topic.id, input.muted ? 'infinity' : null);
    else if (input.mutedForHours !== undefined) {
      await muteTopic(buddi.db, topic.id, input.mutedForHours === 0 ? null : new Date(buddi.clock.now().getTime() + input.mutedForHours * 3600_000));
    }
    return { id: topic.id };
  },
};

const topicInput = z.object({ topic: z.string().trim().min(1).max(80) }).strict();

export const removeTopicTool: ToolDefinition<z.infer<typeof topicInput>, { removed: string }> = {
  name: 'news.remove_topic',
  description: 'Remove a topic with its stories; sources that fed only it go too.',
  tier: 'auto',
  ownerOnly: true,
  input: topicInput,
  async execute(input, ctx) {
    const db = ctx.buddi!.db;
    const topic = await findTopic(db, input.topic);
    if (!topic) throw new Error(`No topic called "${input.topic}".`);
    await db.transaction(async (tx) => {
      const { rows } = await tx.query<{ source_id: string }>(`select source_id from news.topic_sources where topic_id = $1`, [topic.id]);
      await tx.query(`delete from news.topics where id = $1`, [topic.id]);
      await tx.query(`delete from news.sources s where s.id = any($1) and not exists (select 1 from news.topic_sources ts where ts.source_id = s.id)`, [rows.map((r) => r.source_id)]);
    });
    return { removed: topic.name };
  },
};

const hideInput = z.object({ id: z.string().trim().min(1).max(40), action: z.enum(['not_interested', 'snooze', 'undo']), hours: z.number().int().min(1).max(24 * 30).optional() }).strict();

export const hideStoryTool: ToolDefinition<z.infer<typeof hideInput>, { id: string; hidden: string | null }> = {
  name: 'news.hide_story',
  description: 'Not interested in a story, snooze it until tomorrow (back sooner if it has news), or Undo.',
  tier: 'auto',
  ownerOnly: true,
  input: hideInput,
  async execute(input, ctx) {
    const buddi = ctx.buddi!;
    const hidden = input.action === 'undo' ? null : input.action === 'snooze' ? 'snoozed' : 'not_interested';
    const until = hidden === 'snoozed' ? new Date(buddi.clock.now().getTime() + (input.hours ?? 24) * 3600_000) : null;
    if (!(await hideStory(buddi.db, input.id, hidden, until))) throw new Error(`No story ${input.id}.`);
    return { id: input.id, hidden };
  },
};

const settingsInput = z
  .object({
    retentionDays: z.number().int().min(7).max(90).optional(),
    windowHours: z.number().int().min(12).max(168).optional(),
    voiceEditions: z.array(z.enum(['morning', 'midday', 'evening'])).max(3).optional(),
    forgetTold: z.boolean().optional().describe('Forget every edition and told-mark.'),
  })
  .strict();

export const setSettingsTool: ToolDefinition<z.infer<typeof settingsInput>, { retentionDays: number; windowHours: number; voiceEditions: string[] }> = {
  name: 'news.set_settings',
  description: 'How long news is kept, which editions are read aloud, and Forget what was told.',
  tier: 'auto',
  ownerOnly: true,
  input: settingsInput,
  async execute(input, ctx) {
    const db = ctx.buddi!.db;
    if (input.forgetTold) {
      await db.query(`delete from news.editions`);
      await db.query(`update news.stories set last_told_at = null`);
    }
    const { rows } = await db.query<{ retention_days: number; window_hours: number; voice_editions: string[] }>(
      `update news.settings set retention_days = coalesce($1, retention_days), window_hours = coalesce($2, window_hours), voice_editions = coalesce($3, voice_editions)
       returning retention_days, window_hours, voice_editions`,
      [input.retentionDays ?? null, input.windowHours ?? null, input.voiceEditions ?? null],
    );
    const r = rows[0]!;
    return { retentionDays: r.retention_days, windowHours: r.window_hours, voiceEditions: r.voice_editions };
  },
};

const refreshInput = z.object({ topic: z.string().trim().min(1).max(80).optional() }).strict();

export const refreshTool: ToolDefinition<z.infer<typeof refreshInput>, RefreshReport> = {
  name: 'news.refresh',
  description: 'Fetch now: every source of a topic, or whatever is due.',
  tier: 'auto',
  ownerOnly: true,
  input: refreshInput,
  async execute(input, ctx) {
    const buddi = ctx.buddi!;
    let topicId: string | undefined;
    if (input.topic) {
      const topic = await findTopic(buddi.db, input.topic);
      if (!topic) throw new Error(`No topic called "${input.topic}".`);
      topicId = topic.id;
    }
    return refresh(buddi, topicId ? { topicId } : {});
  },
};

const addFeedInput = z
  .object({
    address: z.string().trim().min(2).max(500).describe('A feed or a site address, or words to follow as a Google News search.'),
    topic: z.string().trim().min(1).max(80),
  })
  .strict();

/** Whether what the owner typed is an address rather than words to search for. */
export function looksLikeAddress(text: string): boolean {
  return /^https?:\/\//i.test(text) || (!/\s/.test(text) && /^[\w-]+(\.[\w-]+)+(\/.*)?$/.test(text));
}

/**
 * The source manager's Add a source (the kit's sheet): an address is fetched
 * and parsed before anything is saved — the feed itself, or the one the page
 * names — and words become a Google News search, checked to answer items in
 * the topic's languages. Says what was added and how much it carries now.
 */
export const addFeedTool: ToolDefinition<z.infer<typeof addFeedInput>, { id: string; note: string; items: number }> = {
  name: 'news.add_feed',
  description: 'Add a source to a topic from what the owner typed: a feed, a site that names one, or words for a Google News search; checked before it is saved.',
  tier: 'auto',
  ownerOnly: true,
  input: addFeedInput,
  async execute(input, ctx) {
    const buddi = ctx.buddi!;
    const topic = await findTopic(buddi.db, input.topic);
    if (!topic) throw new Error(`No topic called "${input.topic}".`);
    if (looksLikeAddress(input.address)) {
      const url = new URL(/^https?:\/\//i.test(input.address) ? input.address : `https://${input.address}`).toString();
      const added = await addSource(ctx, { url, topics: [{ topic: topic.id }] });
      return { id: added.id, note: added.note, items: added.items };
    }
    const { rows } = await buddi.db.query<{ languages: string[] }>(`select languages from news.topics where id = $1`, [topic.id]);
    const languages = ((rows[0]?.languages ?? ['en']).filter((l) => l === 'en' || l === 'fr') as Language[]);
    const query = input.address.replace(/\s+/g, ' ');
    let items = 0;
    let first = '';
    let answered = 0;
    let problem = '';
    for (const language of languages.length ? languages : (['en'] as Language[])) {
      const url = gnewsUrl(`${query} when:2d`, language);
      // Checked before it is saved: a search Google News does not answer is not added.
      const found = await discoverFeed(buddi.http!, url).catch((err: unknown) => {
        problem = err instanceof Error ? err.message : String(err);
        return null;
      });
      if (!found) continue;
      answered += 1;
      const id = `${topic.id}-${slug(query)}-${language}`.slice(0, 80);
      if (await addSourceRow(buddi.db, { id, name: `Google News · ${query}`, kind: 'gnews', url, language, outletId: null, addedBy: 'owner' }, [{ topic: topic.id }], buddi.clock.now())) {
        items += found.items;
        first ||= id;
      }
    }
    if (answered === 0) throw new Error(`Google News did not answer that search: ${problem}`);
    if (!first) throw new Error(`${topic.name} already follows that search.`);
    return { id: first, items, note: `Added the Google News search “${query}” to ${topic.name}, ${items} articles now.` };
  },
};

/* ------------------------------------------------------------------ *
 * The meaning model: its line on Settings → News, and Download
 * ------------------------------------------------------------------ */

export const MEANING_NOTE =
  'Once it is ready, stories are grouped by what they say, in English and French alike, and not only by the words they share. ' +
  'It runs on this computer: nothing is sent anywhere.';

export interface MeaningRow {
  id: 'meaning';
  /** The model's state, or `waiting` while the owner's download card is open. */
  state: MeaningState['state'] | 'waiting';
  line: string;
  heading: string;
  /** Bytes so far and in all, for the bar. */
  bytes: number;
  total: number;
  done: string;
  /** "Download (249 MB)", or "Try again". */
  action: string;
}

/** The meaning model's one line for the settings page. */
export function meaningRow(state: MeaningState): MeaningRow {
  const model = megabytes(state.state === 'absent' || state.state === 'failed' ? MODEL_BYTES : state.bytes);
  const size = megabytes(state.state === 'downloading' ? state.total : state.bytes);
  const base = {
    id: 'meaning' as const, state: state.state, heading: `${MEANING_MODEL.label} · ${model}`, bytes: 0, total: state.bytes, done: '',
    action: `Download (${size})`,
  };
  switch (state.state) {
    case 'absent':
      if (state.pending) return { ...base, state: 'waiting', line: 'Waiting for your answer on the download card. Stories are grouped by the words they share meanwhile.' };
      return {
        ...base,
        line: state.bytes > MODEL_BYTES
          ? `Not downloaded. Stories are grouped by the words they share until it is: ${size} with the engine buddi runs it on, downloaded once you approve.`
          : `Not downloaded. Stories are grouped by the words they share until it is; a ${size} download once you approve.`,
      };
    case 'downloading':
      return { ...base, heading: `${MEANING_MODEL.label} · ${size}`, line: `Downloading: ${Math.round(state.bytes / 1_000_000)} of ${size}.`, bytes: state.bytes, total: state.total };
    case 'ready':
      return { ...base, line: 'Ready: stories cluster by meaning.', bytes: state.bytes, total: state.bytes, done: `Ready, ${model}: stories cluster by meaning` };
    case 'failed':
      return { ...base, line: `${state.reason} Stories are grouped by their words meanwhile.`, action: 'Try again' };
  }
}

const MODEL_BYTES = modelBytes();

export const meaningQuery: PageQuery = {
  name: 'meaning',
  params: z.object({}).strict(),
  async produce(_params, ctx): Promise<{ busy: boolean; rows: MeaningRow[] }> {
    const row = meaningRow(await meaningFor().state(ctx.buddi!));
    // Polled while buddi downloads, and while the card waits, so the line follows the owner's answer.
    return { busy: row.state === 'downloading' || row.state === 'waiting', rows: [row] };
  },
};

export const downloadMeaningTool: ToolDefinition<Record<string, never>, { note: string }> = {
  name: 'news.download_meaning',
  description: "Ask buddi to download the meaning model that groups stories by what they say, and the engine it runs on, to this computer. The owner approves one card first. The owner's own.",
  tier: 'auto',
  ownerOnly: true,
  input: z.object({}).strict(),
  async execute(_input, ctx) {
    const state = await meaningFor().start(ctx.buddi!);
    if (state.state === 'ready') return { note: 'The meaning model is ready: stories cluster by meaning from the next round.' };
    if (state.state === 'failed') return { note: state.reason };
    if (state.state === 'downloading') return { note: `Downloading the meaning model (${megabytes(state.total)}). You can leave this page; it carries on.` };
    return { note: `Approve the download card (${megabytes(state.bytes)}) and buddi fetches it; you can leave this page.` };
  },
};

export const ownerTools = [
  enableStarterTool, addSourceTool, setSourceTool, removeSourceTool, retrySourceTool, addTopicTool, setTopicTool, removeTopicTool,
  hideStoryTool, setSettingsTool, refreshTool, addFeedTool, downloadMeaningTool,
];

/* ------------------------------------------------------------------ */

export const newsQueries: PageQuery[] = [
  {
    name: 'sources',
    params: z.object({ topic: z.string().max(80).optional() }).strict(),
    async produce(params, ctx): Promise<{ sources: SourceHealth[] }> {
      const { topic } = params as { topic?: string };
      return { sources: await sourceHealth(ctx.buddi!.db, topic) };
    },
  },
  meaningQuery,
];
