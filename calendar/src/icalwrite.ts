/**
 * Writing iCalendar: a new event as a whole VCALENDAR, and a change to an
 * existing one made line by line, so whatever buddi does not touch — alarms,
 * a rule's exceptions, a client's own properties — stays exactly as it was.
 *
 * A timed event is written in its zone (`DTSTART;TZID=America/New_York:…`)
 * with a VTIMEZONE built from the zone's real transitions around the event,
 * so a client shows it at the same wall-clock time across a DST change; a
 * zone of `UTC` is written as UTC. An all-day event is dates (`VALUE=DATE`),
 * its end the day after its last, as iCalendar has it.
 */
import ical, { type VEvent } from 'node-ical';
import { addDays, dateIn, timeIn, zonedTime } from './time.js';

/** The product id buddi writes into what it creates. */
export const PRODID = '-//withbuddi//buddi calendar//EN';

/* ------------------------------------------------------------------ *
 * Lines
 * ------------------------------------------------------------------ */

/** TEXT escaping (RFC 5545 §3.3.11). */
export function escapeText(text: string): string {
  return text.replace(/\\/g, '\\\\').replace(/;/g, '\\;').replace(/,/g, '\\,').replace(/\r\n|\r|\n/g, '\\n');
}

/** Fold a content line at 75 octets, never inside a character. */
export function foldLine(line: string): string {
  const out: string[] = [];
  let current = '';
  let bytes = 0;
  for (const ch of line) {
    const size = Buffer.byteLength(ch);
    const limit = out.length === 0 ? 75 : 74;
    if (bytes + size > limit) {
      out.push(current);
      current = '';
      bytes = 0;
    }
    current += ch;
    bytes += size;
  }
  out.push(current);
  return out.join('\r\n ');
}

/** The text as unfolded content lines. */
export function unfold(text: string): string[] {
  return text.replace(/\r?\n[ \t]/g, '').split(/\r?\n/).filter((l) => l.length > 0);
}

/** A line's property name, upper case: `DTSTART` of `DTSTART;TZID=…:…`. */
export function propName(line: string): string {
  const m = /^([A-Za-z0-9-]+)[;:]/.exec(line);
  return m ? m[1]!.toUpperCase() : '';
}

const join = (lines: string[]): string => `${lines.map(foldLine).join('\r\n')}\r\n`;

/* ------------------------------------------------------------------ *
 * Times
 * ------------------------------------------------------------------ */

/** Whether a zone name is one this runtime knows. */
export function knownZone(tz: string): boolean {
  try {
    new Intl.DateTimeFormat('en-US', { timeZone: tz });
    return true;
  } catch {
    return false;
  }
}

const LOCAL = /^(\d{4}-\d{2}-\d{2})[T ](\d{1,2}):(\d{2})(?::(\d{2}))?(Z|[+-]\d{2}:?\d{2})?$/i;
const DATE = /^\d{4}-\d{2}-\d{2}$/;

/** A real calendar date, `YYYY-MM-DD`. */
export function validDate(text: string): boolean {
  if (!DATE.test(text)) return false;
  const [y, m, d] = text.split('-').map(Number) as [number, number, number];
  return new Date(Date.UTC(y, m - 1, d)).toISOString().slice(0, 10) === text;
}

/**
 * A time the model gave, as an instant: `2026-10-08T14:00` is wall-clock time
 * in `tz`; one with `Z` or an offset is that instant. A wall-clock time the
 * zone skips (the hour the clocks go forward) is refused, saying so; one it
 * repeats (the hour they go back) is its first occurrence.
 */
export function parseWhen(text: string, tz: string): Date {
  const m = LOCAL.exec(text.trim());
  if (!m || !validDate(m[1]!)) throw new Error(`“${text}” is not a time. Give it as YYYY-MM-DDTHH:MM, in the owner's time.`);
  const [, date, hh, mm, ss, offset] = m as unknown as [string, string, string, string, string | undefined, string | undefined];
  if (Number(hh) > 23 || Number(mm) > 59 || Number(ss ?? 0) > 59) throw new Error(`“${text}” is not a time of day.`);
  const clock = `${hh.padStart(2, '0')}:${mm}`;
  if (offset) {
    const iso = `${date}T${clock}:${ss ?? '00'}${offset.toUpperCase() === 'Z' ? 'Z' : offset.length === 5 ? `${offset.slice(0, 3)}:${offset.slice(3)}` : offset}`;
    const at = new Date(iso);
    if (Number.isNaN(at.getTime())) throw new Error(`“${text}” is not a time.`);
    return at;
  }
  const first = earliestAt(date, clock, tz);
  if (!first) {
    throw new Error(`${clock} on ${date} does not exist in ${tz}: the clocks go forward that night. Pick another time.`);
  }
  return new Date(first.getTime() + Number(ss ?? 0) * 1000);
}

/** The earliest instant that reads `date clock` in the zone, or null when none does. */
function earliestAt(date: string, clock: string, tz: string): Date | null {
  const guess = zonedTime(date, clock, tz);
  const candidates = [-3, -2, -1, 0, 1, 2, 3].map((h) => new Date(guess.getTime() + h * 3_600_000));
  const hits = candidates.filter((c) => dateIn(c, tz) === date && timeIn(c, tz) === clock);
  return hits.length === 0 ? null : hits.reduce((a, b) => (a.getTime() <= b.getTime() ? a : b));
}

const pad = (n: number, w = 2): string => String(n).padStart(w, '0');

/** `20261008T140000` as the wall-clock time in the zone. */
export function localStamp(d: Date, tz: string): string {
  const p = Object.fromEntries(
    new Intl.DateTimeFormat('en-GB', { timeZone: tz, year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit', hourCycle: 'h23' })
      .formatToParts(d)
      .map((x) => [x.type, x.value]),
  );
  return `${p.year}${p.month}${p.day}T${p.hour}${p.minute}${p.second}`;
}

/** `20261008T180000Z`. */
export function utcStamp(d: Date): string {
  return d.toISOString().replace(/[-:]/g, '').replace(/\.\d{3}/, '');
}

const dateStamp = (date: string): string => date.replace(/-/g, '');

/** The zone's offset from UTC at an instant, in minutes. */
export function offsetMinutes(d: Date, tz: string): number {
  const local = localStamp(d, tz);
  const asUtc = Date.UTC(
    Number(local.slice(0, 4)), Number(local.slice(4, 6)) - 1, Number(local.slice(6, 8)),
    Number(local.slice(9, 11)), Number(local.slice(11, 13)), Number(local.slice(13, 15)),
  );
  return Math.round((asUtc - Math.floor(d.getTime() / 1000) * 1000) / 60_000);
}

const offsetText = (minutes: number): string => `${minutes < 0 ? '-' : '+'}${pad(Math.floor(Math.abs(minutes) / 60))}${pad(Math.abs(minutes) % 60)}`;

/**
 * A VTIMEZONE for the zone, from its real transitions in the year before the
 * event to the year after — each observance written once with its own
 * DTSTART, which every client reads; a zone without DST is one STANDARD.
 */
export function vtimezone(tz: string, around: Date): string[] {
  const year = around.getUTCFullYear();
  const from = Date.UTC(year - 1, 0, 1);
  const to = Date.UTC(year + 2, 0, 1);
  const transitions: Array<{ at: number; before: number; after: number }> = [];
  const DAY = 86_400_000;
  let prev = offsetMinutes(new Date(from), tz);
  for (let t = from + DAY; t <= to; t += DAY) {
    const now = offsetMinutes(new Date(t), tz);
    if (now !== prev) {
      // Narrow the day down to the minute it changed.
      let lo = t - DAY;
      let hi = t;
      while (hi - lo > 60_000) {
        const mid = lo + Math.floor((hi - lo) / 120_000) * 60_000;
        if (offsetMinutes(new Date(mid), tz) === prev) lo = mid;
        else hi = mid;
      }
      transitions.push({ at: hi, before: prev, after: now });
      prev = now;
    }
  }
  const lines = ['BEGIN:VTIMEZONE', `TZID:${tz}`];
  if (transitions.length === 0) {
    const off = offsetText(prev);
    lines.push('BEGIN:STANDARD', 'DTSTART:19700101T000000', `TZOFFSETFROM:${off}`, `TZOFFSETTO:${off}`, 'END:STANDARD');
  } else {
    for (const tr of transitions) {
      const kind = tr.after > tr.before ? 'DAYLIGHT' : 'STANDARD';
      // Its DTSTART is the wall-clock time just before the change, in the old offset.
      const wall = new Date(tr.at + tr.before * 60_000).toISOString().replace(/[-:]/g, '').replace(/\.\d{3}Z$/, '');
      lines.push(`BEGIN:${kind}`, `DTSTART:${wall}`, `TZOFFSETFROM:${offsetText(tr.before)}`, `TZOFFSETTO:${offsetText(tr.after)}`, `END:${kind}`);
    }
  }
  lines.push('END:VTIMEZONE');
  return lines;
}

/* ------------------------------------------------------------------ *
 * What an event is
 * ------------------------------------------------------------------ */

/** When an event happens, as buddi writes it. */
export type EventTime =
  | { allDay: false; start: Date; end: Date; tz: string }
  | { allDay: true; startDate: string; endDate: string };

function timeLines(time: EventTime): string[] {
  if (time.allDay) return [`DTSTART;VALUE=DATE:${dateStamp(time.startDate)}`, `DTEND;VALUE=DATE:${dateStamp(time.endDate)}`];
  if (time.tz === 'UTC' || time.tz === 'Etc/UTC') return [`DTSTART:${utcStamp(time.start)}`, `DTEND:${utcStamp(time.end)}`];
  return [`DTSTART;TZID=${time.tz}:${localStamp(time.start, time.tz)}`, `DTEND;TZID=${time.tz}:${localStamp(time.end, time.tz)}`];
}

const needsZone = (time: EventTime): time is Extract<EventTime, { allDay: false }> =>
  !time.allDay && time.tz !== 'UTC' && time.tz !== 'Etc/UTC';

export interface NewEvent {
  uid: string;
  title: string;
  time: EventTime;
  location?: string;
  notes?: string;
  now: Date;
}

/** A new event as a whole calendar object. */
export function buildEvent(event: NewEvent): string {
  const lines = ['BEGIN:VCALENDAR', 'VERSION:2.0', `PRODID:${PRODID}`, 'CALSCALE:GREGORIAN'];
  if (needsZone(event.time)) lines.push(...vtimezone(event.time.tz, event.time.start));
  lines.push(
    'BEGIN:VEVENT',
    `UID:${event.uid}`,
    `DTSTAMP:${utcStamp(event.now)}`,
    `CREATED:${utcStamp(event.now)}`,
    `LAST-MODIFIED:${utcStamp(event.now)}`,
    'SEQUENCE:0',
    ...timeLines(event.time),
    `SUMMARY:${escapeText(event.title)}`,
  );
  if (event.location) lines.push(`LOCATION:${escapeText(event.location)}`);
  if (event.notes) lines.push(`DESCRIPTION:${escapeText(event.notes)}`);
  lines.push('END:VEVENT', 'END:VCALENDAR');
  return join(lines);
}

/** What buddi changes on an event; a `null` place or note takes it away. */
export interface EventChanges {
  title?: string;
  location?: string | null;
  notes?: string | null;
  time?: EventTime;
}

interface Block {
  begin: number;
  end: number;
}

/** The VEVENT blocks of an object: the series (or the one event) and its moved occurrences. */
function veventBlocks(lines: string[], uid: string): { master: Block | undefined; overrides: Block[] } {
  const blocks: Array<Block & { uid: string; override: boolean }> = [];
  let begin = -1;
  let depth = 0;
  lines.forEach((line, i) => {
    const upper = line.toUpperCase();
    if (upper === 'BEGIN:VEVENT') {
      begin = i;
      depth = 1;
    } else if (begin >= 0 && upper.startsWith('BEGIN:')) depth++;
    else if (begin >= 0 && upper.startsWith('END:')) {
      depth--;
      if (upper === 'END:VEVENT' && depth === 0) {
        const inner = lines.slice(begin + 1, i);
        const own = topLevel(inner);
        const u = own.find((l) => propName(l) === 'UID')?.replace(/^UID[^:]*:/i, '').trim() ?? '';
        blocks.push({ begin, end: i, uid: u, override: own.some((l) => propName(l) === 'RECURRENCE-ID') });
        begin = -1;
      }
    }
  });
  const mine = blocks.filter((b) => b.uid === uid);
  return { master: mine.find((b) => !b.override), overrides: mine.filter((b) => b.override) };
}

/** A block's own lines, leaving out those of components inside it (alarms). */
function topLevel(inner: string[]): string[] {
  const out: string[] = [];
  let depth = 0;
  for (const line of inner) {
    const upper = line.toUpperCase();
    if (upper.startsWith('BEGIN:')) depth++;
    else if (upper.startsWith('END:')) depth--;
    else if (depth === 0) out.push(line);
  }
  return out;
}

/**
 * The object with the changes made to the event's series (or the one event):
 * the named properties replaced, DTSTAMP, LAST-MODIFIED and SEQUENCE moved
 * on, a VTIMEZONE added for a zone the object did not carry, and every other
 * line as it was.
 */
export function editEvent(data: string, uid: string, changes: EventChanges, now: Date): string {
  const lines = unfold(data);
  const { master } = veventBlocks(lines, uid);
  if (!master) throw new Error('that event is not in the object the calendar returned.');
  const replace = new Map<string, string[] | null>();
  if (changes.title !== undefined) replace.set('SUMMARY', [`SUMMARY:${escapeText(changes.title)}`]);
  if (changes.location !== undefined) replace.set('LOCATION', changes.location ? [`LOCATION:${escapeText(changes.location)}`] : null);
  if (changes.notes !== undefined) replace.set('DESCRIPTION', changes.notes ? [`DESCRIPTION:${escapeText(changes.notes)}`] : null);
  if (changes.time) {
    const [start, end] = timeLines(changes.time) as [string, string];
    replace.set('DTSTART', [start]);
    replace.set('DTEND', [end]);
    replace.set('DURATION', null);
  }
  const inner = lines.slice(master.begin + 1, master.end);
  const kept: string[] = [];
  let depth = 0;
  const seen = new Set<string>();
  let sequence = -1;
  for (const line of inner) {
    const upper = line.toUpperCase();
    if (upper.startsWith('BEGIN:')) depth++;
    if (depth > 0) {
      kept.push(line);
      if (upper.startsWith('END:')) depth--;
      continue;
    }
    const name = propName(line);
    if (name === 'SEQUENCE') {
      sequence = Number(line.slice(line.indexOf(':') + 1)) || 0;
      continue;
    }
    if (name === 'DTSTAMP' || name === 'LAST-MODIFIED') continue;
    if (replace.has(name)) {
      if (!seen.has(name)) kept.push(...(replace.get(name) ?? []));
      seen.add(name);
      continue;
    }
    kept.push(line);
  }
  // A property buddi sets that the event did not have yet goes after its UID.
  const extra: string[] = [];
  for (const [name, value] of replace) if (!seen.has(name) && value) extra.push(...value);
  const uidAt = Math.max(0, kept.findIndex((l) => propName(l) === 'UID'));
  kept.splice(uidAt + 1, 0, `DTSTAMP:${utcStamp(now)}`, `LAST-MODIFIED:${utcStamp(now)}`, `SEQUENCE:${sequence + 1}`, ...extra);
  const out = [...lines.slice(0, master.begin + 1), ...kept, ...lines.slice(master.end)];
  if (changes.time && needsZone(changes.time)) {
    const tz = changes.time.tz;
    const has = out.some((l) => l.toUpperCase() === 'BEGIN:VTIMEZONE') && out.some((l) => propName(l) === 'TZID' && l.slice(l.indexOf(':') + 1).trim() === tz);
    if (!has) {
      const at = out.findIndex((l) => l.toUpperCase() === 'BEGIN:VEVENT');
      out.splice(at, 0, ...vtimezone(tz, changes.time.start));
    }
  }
  return join(out);
}

/* ------------------------------------------------------------------ *
 * Reading one event
 * ------------------------------------------------------------------ */

/** What buddi needs to know about an event before it changes it. */
export interface EventFacts {
  uid: string;
  summary: string;
  location?: string;
  description?: string;
  allDay: boolean;
  /** For a timed event; for an all-day one, midnight of its dates in the owner's zone. */
  start: Date;
  end: Date;
  startDate?: string;
  endDate?: string;
  /** The zone its start is written in, when it names an IANA zone. */
  tz?: string;
  /** It repeats: changes and cancelling are the whole series. */
  rule?: string;
  /** Occurrences moved or changed on their own (RECURRENCE-ID). */
  overrides: boolean;
  /** Occurrences skipped (EXDATE). */
  skips: boolean;
  /** It has invitees: buddi does not touch it. */
  invitees: boolean;
}

const plain = (value: unknown): string | undefined => {
  const v = typeof value === 'string' ? value : value && typeof value === 'object' && 'val' in value ? (value as { val: unknown }).val : undefined;
  return typeof v === 'string' && v.trim() ? v.trim() : undefined;
};

/** A date-only value is local midnight in this process's zone: its local parts are the date. */
function localDate(d: Date): string {
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

/** The facts of the event with this UID in an object. */
export function eventFacts(data: string, uid: string, ownerTz: string): EventFacts {
  const lines = unfold(data);
  const { master, overrides } = veventBlocks(lines, uid);
  if (!master) throw new Error('that event is not in the object the calendar returned.');
  const own = topLevel(lines.slice(master.begin + 1, master.end));
  const parsed = Object.values(ical.sync.parseICS(data)).find(
    (c): c is VEvent => (c as { type?: string }).type === 'VEVENT' && (c as VEvent).uid === uid && !(c as { recurrenceid?: unknown }).recurrenceid,
  );
  if (!parsed || !(parsed.start instanceof Date)) throw new Error('buddi could not read that event’s time.');
  const allDay = (parsed as { datetype?: string }).datetype === 'date';
  const ruleLine = own.find((l) => propName(l) === 'RRULE');
  const tzid = /;TZID=("?)([^;:"]+)\1/i.exec(own.find((l) => propName(l) === 'DTSTART') ?? '')?.[2];
  let start = parsed.start;
  let end = parsed.end instanceof Date ? parsed.end : start;
  let startDate: string | undefined;
  let endDate: string | undefined;
  if (allDay) {
    startDate = localDate(parsed.start);
    endDate = parsed.end instanceof Date ? localDate(parsed.end) : addDays(startDate, 1);
    if (endDate <= startDate) endDate = addDays(startDate, 1);
    start = zonedTime(startDate, '00:00', ownerTz);
    end = zonedTime(endDate, '00:00', ownerTz);
  }
  const location = plain(parsed.location);
  const description = plain(parsed.description);
  return {
    uid,
    summary: plain(parsed.summary) ?? '(no title)',
    ...(location ? { location } : {}),
    ...(description ? { description } : {}),
    allDay,
    start,
    end,
    ...(startDate ? { startDate, endDate } : {}),
    ...(tzid && knownZone(tzid) ? { tz: tzid } : {}),
    ...(ruleLine ? { rule: ruleLine.slice(ruleLine.indexOf(':') + 1).trim() } : {}),
    overrides: overrides.length > 0,
    skips: own.some((l) => propName(l) === 'EXDATE'),
    invitees: own.some((l) => propName(l) === 'ATTENDEE'),
  };
}
