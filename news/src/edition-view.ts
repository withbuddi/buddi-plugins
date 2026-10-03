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
 */
import type { BuddiHost } from '@buddi/core/plugin';
import { clock } from './format.js';
import { visibleArticles, type ArticleRow } from './reads.js';

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

function logosOf(articles: ArticleRow[], named: string): Array<{ name: string; logo?: string }> {
  const seen = new Set<string>();
  const outlets: Array<{ name: string; logo?: string }> = [];
  for (const a of articles) {
    const key = a.outlet_id ?? a.source_id;
    if (seen.has(key)) continue;
    seen.add(key);
    outlets.push({ name: a.outlet, ...(a.logo ? { logo: a.logo } : {}) });
  }
  const want = outletName(named);
  const lead = outlets.findIndex((o) => o.name.toLowerCase() === want || o.name.toLowerCase().startsWith(want));
  if (lead > 0) outlets.unshift(...outlets.splice(lead, 1));
  return outlets.slice(0, 3);
}

/** One saved edition, as the chat's card draws it; undefined when there is no such edition. */
export async function editionView(buddi: BuddiHost, id: string): Promise<EditionView | undefined> {
  const db: Db = buddi.db;
  const { rows } = await db.query<{ id: string; kind: string; created_at: Date; text: string | null; story_ids: string[] }>(
    `select id, kind, created_at, text, story_ids from news.editions where id = $1`,
    [id],
  );
  const row = rows[0];
  if (!row || !row.text) return undefined;
  const parsed = parseEdition(row.text);
  const articles = await visibleArticles(db, row.story_ids);
  const byUrl = new Map<string, string>();
  for (const [storyId, list] of articles) for (const a of list) byUrl.set(bare(a.url), storyId);
  const format = (await buddi.owner.formats?.().catch(() => null))?.time ?? null;
  const at = clock(row.created_at, buddi.owner.timezone, format);
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
        const logos = list.length > 0 ? logosOf(list, s.outlet) : s.outlet ? [{ name: s.outlet }] : [];
        return { ...s, ...(storyId ? { storyId } : {}), logos };
      }),
    })),
    notes: parsed.notes,
    ...(parsed.next ? { next: parsed.next } : {}),
    text: row.text,
    at: row.created_at.toISOString(),
  };
}
