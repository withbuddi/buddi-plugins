/**
 * A saved edition as the chat draws it: the kit's edition card (topics, each
 * story with its headline, Anchor's line, the outlet's logo, "and N more" and
 * the link, UPDATE and OPINION marks), read back from what `news.edition_save`
 * stored — the text as sent and the stories it told.
 *
 * The words are Anchor's, so they come from the text: the edition is parsed,
 * in the Markdown shape Anchor writes from 1.0.1 (`### Topic`, `**Headline**`,
 * the lead, `*Outlet and N more* · [domain](link)`) and in the plain shape
 * before it (a topic in capitals, then headline, lead, `Outlet · link` lines).
 * The logos come from the stories: a parsed story is matched to one the
 * edition told by its link, and that story's outlets give the logos (keys of
 * this plugin's assets). A story that matches none keeps its words and draws
 * its outlet's letter. Nothing here invents a story, a line or a link.
 *
 * A matched story also carries its ⋯ menu as declared page actions (the
 * page grammar's tool, label, args, done and undo — the News page's ways out,
 * resolved for this story), so the card runs whatever it is handed and knows
 * no tool of this plugin's by name.
 */
import type { BuddiHost } from '@buddi/core/plugin';
import { clock, weekHence } from './format.js';
import { visibleArticles, type ArticleRow } from './reads.js';
import { editionLink } from './edition.js';

type Db = BuddiHost['db'];

export interface EditionStoryView {
  /** The told story it matched, when its link is one of that story's articles. */
  storyId?: string;
  mark?: 'update' | 'opinion';
  /** The mark as Anchor wrote it ("UPDATE", "MISE À JOUR"). */
  markLabel?: string;
  title: string;
  lead: string;
  /** The first outlet as written ("RFI Afrique (fr)"). */
  outlet: string;
  /** "and N more". */
  more: number;
  link?: { url: string; label: string };
  /** Up to three outlets, the named one first; `logo` is an asset key. */
  logos: Array<{ name: string; logo?: string }>;
  /** The matched story's topic, for the card's ways out (Quiet / Mute the topic). */
  topicId?: string;
  topicName?: string;
  /** The matched story's outlets that can be muted (up to four, the named one first). */
  mutable?: Array<{ id: string; name: string }>;
  /** The story's ⋯ menu, in order: Not interested · Mute an outlet · Quiet and Mute the topic. */
  actions?: EditionAction[];
}

/** A literal argument, in the page grammar's `{ const }` form. */
type Const = { const: unknown };

/**
 * One item of a story's ⋯ menu, as a page action: the tool it runs and its
 * arguments, the line under it (`hint`), the heading above its group
 * (`group`), what the card says once it worked (`done`) and the call that
 * takes it back (`undo`). An item without `group` is grouped with the items
 * of the same tool.
 */
export interface EditionAction {
  tool: string;
  label: string;
  hint?: string;
  group?: string;
  args: Record<string, Const>;
  done: string;
  confirm?: string;
  undo?: { tool: string; label: string; args: Record<string, Const> };
}

const lit = (args: Record<string, unknown>): Record<string, Const> =>
  Object.fromEntries(Object.entries(args).map(([key, value]) => [key, { const: value }]));

/** The ways out of a told story: the News page's, with its ids written in. */
export function storyActions(
  story: { storyId: string; topicId?: string; topicName?: string; mutable?: Array<{ id: string; name: string }> },
  ctx: { now: Date; zone: string },
): EditionAction[] {
  const actions: EditionAction[] = [{
    tool: 'news.hide_story', label: 'Not interested', hint: 'Hides it and shows fewer like it',
    args: lit({ id: story.storyId, action: 'not_interested' }), done: 'Hidden. It won’t come back.',
    undo: { tool: 'news.hide_story', label: 'Undo', args: lit({ id: story.storyId, action: 'undo' }) },
  }];
  for (const o of story.mutable ?? []) {
    actions.push({
      tool: 'news.mute_outlet', label: `Mute ${o.name}`, group: 'Mute an outlet',
      args: lit({ outlet: o.id, muted: true }), done: `Muted ${o.name}. Its stories are hidden.`,
      undo: { tool: 'news.mute_outlet', label: 'Undo', args: lit({ outlet: o.id, muted: false }) },
    });
  }
  if (story.topicId) {
    const t = story.topicName ?? story.topicId;
    actions.push({
      tool: 'news.set_topic', label: `Quiet ${t} for a week`, hint: weekHence(ctx.now, ctx.zone).hint,
      args: lit({ topic: story.topicId, mutedForHours: 168 }), done: `${t} is quiet for a week.`,
      undo: { tool: 'news.set_topic', label: 'Undo', args: lit({ topic: story.topicId, mutedForHours: 0 }) },
    });
    actions.push({
      tool: 'news.set_topic', label: `Mute ${t}`, hint: 'Undo it in Sources',
      args: lit({ topic: story.topicId, muted: true }), done: `Muted ${t}. Anchor leaves it out too.`,
      undo: { tool: 'news.set_topic', label: 'Undo', args: lit({ topic: story.topicId, muted: false }) },
    });
  }
  return actions;
}

export interface EditionView {
  id: string;
  kind: string;
  /** "Morning edition". */
  name: string;
  /** "Sat 3 Oct · 07:30". */
  when: string;
  lede: string;
  groups: Array<{ topic: string; stories: EditionStoryView[] }>;
  /** The edition's own plain lines before the signature ("Voice was off today: …"). */
  notes: string[];
  /** The next edition's time, from "— Anchor · next at 12:30". */
  next?: string;
  /** The card's closing line, in News's words (buddi's `digest`, host API 1.33). */
  foot: string;
  /** The link the edition's report was sent under: buddi plays its recording from it (1.33). */
  report: string;
  /** The text as sent. */
  text: string;
  at: string;
}

/* ------------------------------------------------------------------ *
 * Parsing the text
 * ------------------------------------------------------------------ */

export interface ParsedStory {
  mark?: 'update' | 'opinion';
  markLabel?: string;
  title: string;
  lead: string;
  outlet: string;
  more: number;
  link?: { url: string; label: string };
}

export interface ParsedEdition {
  name: string;
  date: string;
  lede: string;
  groups: Array<{ topic: string; stories: ParsedStory[] }>;
  notes: string[];
  next?: string;
}

const HEADING = /^\s{0,3}#{1,6}\s+(.+?)\s*#*\s*$/;
const MD_LINK = /\[([^\]\n]+)\]\(\s*<?(https?:\/\/[^\s)>]+)>?\s*\)/;
const RAW_URL = /(https?:\/\/[^\s<>)\]]+[^\s<>)\].,;:!?'"])/;
const SIGNATURE = /^[—–-]\s*\S.*$/;
const NEXT = /(\d{1,2}[:h.]\d{2})\s*$/;
const MARK = /^([\p{Lu}][\p{Lu} ]*[\p{Lu}])\s*·\s+/u;
const MORE = /\s+(?:and|et|y|und|e)\s+(\d+)\s+(?:more|autres?|más|weitere|altri)\s*$/i;

/** A topic in capitals, the plain shape's: letters, all upper case, no sentence punctuation. */
function isCapsTopic(line: string): boolean {
  const letters = line.replace(/[^\p{L}]/gu, '');
  return letters.length >= 2 && letters === letters.toUpperCase() && letters !== letters.toLowerCase()
    && !/[.!?:]$/.test(line) && !line.includes(' · ') && !/https?:\/\//.test(line);
}

/** `**text**` (or `__text__`) wrapping the whole line. */
function boldLine(line: string): string | null {
  const m = /^\*\*(.+)\*\*$/.exec(line) ?? /^__(.+)__$/.exec(line);
  return m ? m[1]!.trim() : null;
}

const unwrap = (text: string): string => text.replace(/^\*+|\*+$/g, '').replace(/^_+|_+$/g, '').trim();

/** "*NPR and 5 more* · [npr.org](https://…)" or "NPR and 5 more · https://…". */
function sourceLine(line: string): { outlet: string; more: number; link: { url: string; label: string } } | null {
  const md = MD_LINK.exec(line);
  const raw = md ? null : RAW_URL.exec(line);
  if (!md && !raw) return null;
  const at = (md ?? raw)!.index;
  const before = line.slice(0, at).replace(/\s*·\s*$/, '').trim();
  if (before === '' || !line.slice(0, at).includes('·')) return null;
  const words = unwrap(before);
  const more = MORE.exec(words);
  const outlet = (more ? words.slice(0, more.index) : words).trim();
  const url = md ? md[2]! : raw![1]!;
  let label = md ? md[1]!.trim() : url;
  if (!md) {
    try { label = new URL(url).hostname.replace(/^www\./, ''); } catch { /* keep the address */ }
  }
  return { outlet, more: more ? Number(more[1]) : 0, link: { url, label } };
}

function titleOf(line: string): Pick<ParsedStory, 'title' | 'mark' | 'markLabel'> {
  let title = boldLine(line) ?? line;
  const m = MARK.exec(title);
  if (!m) return { title: unwrap(title) };
  title = title.slice(m[0].length);
  const label = m[1]!;
  const mark = /OPINION|TRIBUNE|ÉDITORIAL|EDITORIAL/i.test(label) ? 'opinion' : 'update';
  return { title: unwrap(title), mark, markLabel: label };
}

/** The edition's text as its parts. Never throws; an unrecognised text gives no groups. */
export function parseEdition(text: string): ParsedEdition {
  const lines = text.replace(/\r\n/g, '\n').split('\n').map((l) => l.trim());
  let i = 0;
  while (i < lines.length && lines[i] === '') i += 1;
  const first = boldLine(lines[i] ?? '') ?? lines[i] ?? '';
  const dot = first.indexOf(' · ');
  const name = (dot === -1 ? first : first.slice(0, dot)).trim();
  const date = dot === -1 ? '' : first.slice(dot + 3).trim();
  i += 1;

  const groups: ParsedEdition['groups'] = [];
  const notes: string[] = [];
  const lede: string[] = [];
  let next: string | undefined;
  let story: (ParsedStory & { done: boolean }) | null = null;
  let blank = true;

  const group = (): ParsedEdition['groups'][number] => {
    if (groups.length === 0) groups.push({ topic: '', stories: [] });
    return groups[groups.length - 1]!;
  };
  const close = (): void => {
    if (story && story.title !== '') {
      const { done: _done, ...rest } = story;
      group().stories.push({ ...rest, lead: rest.lead.trim() });
    }
    story = null;
  };

  for (; i < lines.length; i += 1) {
    const line = lines[i]!;
    if (line === '') { blank = true; continue; }
    const wasBlank = blank;
    blank = false;

    if (SIGNATURE.test(line) && /anchor|—/i.test(line) && !sourceLine(line)) {
      const m = NEXT.exec(line);
      if (m) next = m[1]!.replace(/[h.]/, ':');
      continue;
    }
    const heading = HEADING.exec(line);
    if (heading || (wasBlank && isCapsTopic(line) && (!story || story.done || story.title === ''))) {
      close();
      groups.push({ topic: unwrap(heading ? heading[1]! : line), stories: [] });
      continue;
    }
    const source = sourceLine(line);
    if (story && !story.done && source) {
      Object.assign(story, source, { done: true });
      continue;
    }
    if (groups.length === 0 && !boldLine(line)) {
      // Before the first topic: the lede, or a note.
      (lede.length === 0 || !wasBlank ? lede : notes).push(line);
      continue;
    }
    if (!story || story.done) {
      close();
      // A note after the last story ("Voice was off today: …") is not a story.
      if (!boldLine(line) && !MARK.test(line) && lines.slice(i + 1).every((l) => l === '' || SIGNATURE.test(l))) {
        notes.push(line);
        continue;
      }
      story = { lead: '', outlet: '', more: 0, done: false, ...titleOf(line) };
      continue;
    }
    story.lead = story.lead === '' ? line : `${story.lead} ${line}`;
  }
  close();
  return { name, date, lede: lede.join(' '), groups: groups.filter((g) => g.stories.length > 0), notes, ...(next ? { next } : {}) };
}

/* ------------------------------------------------------------------ *
 * The stored edition
 * ------------------------------------------------------------------ */

/** An address without its fragment, query or trailing slash, for matching. */
function bare(url: string): string {
  try {
    const u = new URL(url);
    return `${u.hostname.replace(/^www\./, '')}${u.pathname.replace(/\/+$/, '')}`.toLowerCase();
  } catch {
    return url.trim().toLowerCase();
  }
}

const outletName = (name: string): string => name.replace(/\s*\([^)]*\)\s*$/, '').trim().toLowerCase();

/** A story's distinct outlets, the one Anchor named first. */
function outletsOf(articles: ArticleRow[], named: string): Array<{ id: string | null; name: string; logo?: string }> {
  const seen = new Set<string>();
  const outlets: Array<{ id: string | null; name: string; logo?: string }> = [];
  for (const a of articles) {
    const key = a.outlet_id ?? a.source_id;
    if (seen.has(key)) continue;
    seen.add(key);
    outlets.push({ id: a.outlet_id, name: a.outlet, ...(a.logo ? { logo: a.logo } : {}) });
  }
  const want = outletName(named);
  const lead = outlets.findIndex((o) => o.name.toLowerCase() === want || o.name.toLowerCase().startsWith(want));
  if (lead > 0) outlets.unshift(...outlets.splice(lead, 1));
  return outlets;
}

/** One saved edition, as the chat's card draws it; undefined when there is no such edition. */
export async function editionView(buddi: BuddiHost, id: string): Promise<EditionView | undefined> {
  const db: Db = buddi.db;
  const { rows } = await db.query<{ id: string; kind: string; created_at: Date; text: string | null; story_ids: string[] }>(
    id === 'latest'
      ? `select id, kind, created_at, text, story_ids from news.editions where text is not null and text <> '' order by created_at desc, id desc limit 1`
      : `select id, kind, created_at, text, story_ids from news.editions where id = $1`,
    id === 'latest' ? [] : [id],
  );
  const row = rows[0];
  if (!row || !row.text) return undefined;
  const parsed = parseEdition(row.text);
  const articles = await visibleArticles(db, row.story_ids);
  const byUrl = new Map<string, string>();
  for (const [storyId, list] of articles) for (const a of list) byUrl.set(bare(a.url), storyId);
  const { rows: topicRows } = row.story_ids.length === 0 ? { rows: [] } : await db.query<{ id: string; topic_id: string; name: string }>(
    `select s.id, s.topic_id, t.name from news.stories s join news.topics t on t.id = s.topic_id where s.id = any($1)`,
    [row.story_ids],
  );
  const topicOf = new Map(topicRows.map((t) => [t.id, t]));
  const format = (await buddi.owner.formats?.().catch(() => null))?.time ?? null;
  const at = clock(row.created_at, buddi.owner.timezone, format);
  const now = buddi.clock.now();
  return {
    id: row.id,
    kind: row.kind,
    name: parsed.name || `${row.kind[0]!.toUpperCase()}${row.kind.slice(1)} edition`,
    when: parsed.date ? `${parsed.date} · ${at}` : at,
    lede: parsed.lede,
    groups: parsed.groups.map((g) => ({
      topic: g.topic,
      stories: g.stories.map((s) => {
        const storyId = s.link ? byUrl.get(bare(s.link.url)) : undefined;
        const list = storyId ? articles.get(storyId) ?? [] : [];
        const outlets = outletsOf(list, s.outlet);
        const logos = outlets.length > 0 ? outlets.slice(0, 3).map(({ name, logo }) => ({ name, ...(logo ? { logo } : {}) })) : s.outlet ? [{ name: s.outlet }] : [];
        const topic = storyId ? topicOf.get(storyId) : undefined;
        const mutable = outlets.filter((o) => o.id !== null).slice(0, 4).map((o) => ({ id: o.id!, name: o.name }));
        const ways = {
          ...(topic ? { topicId: topic.topic_id, topicName: topic.name } : {}),
          ...(storyId && mutable.length > 0 ? { mutable } : {}),
        };
        return {
          ...s,
          ...(storyId ? { storyId } : {}),
          logos,
          ...ways,
          ...(storyId ? { actions: storyActions({ storyId, ...ways }, { now, zone: buddi.owner.timezone }) } : {}),
        };
      }),
    })),
    notes: parsed.notes,
    ...(parsed.next ? { next: parsed.next } : {}),
    foot: `${parsed.next ? `Next edition at ${parsed.next}. ` : ''}Tell me what to leave out, or mute anything from News.`,
    report: editionLink(row.id),
    text: row.text,
    at: row.created_at.toISOString(),
  };
}
