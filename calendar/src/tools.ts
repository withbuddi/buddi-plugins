/**
 * The four reading tools a model sees, all `auto`: today, the coming days, a
 * search, and the free time in a day. An event in a calendar the owner lets
 * agents change comes with its id under `forAgent` (never drawn), for the
 * write tools in `write.ts`. Times are the owner's; answers
 * are short plain lines. A calendar that cannot be read is named in
 * `problems` and the rest still answer. Today and the coming days also carry
 * `tiles`, the same events as data the canvas draws (`views.ts`).
 *
 * With no calendar linked a tool is not set up rather than broken: it answers
 * `{ linked: false, message }`, which the canvas draws as one card linking to
 * Settings → Calendar, and a model reads as a sentence to pass on.
 */
import { z } from 'zod';
import type { BuddiHost, ToolDefinition } from '@buddi/core/plugin';
import { occurrences, type Occurrence } from './ics.js';
import { eventsOf, googleOccurrencesOf, listAccounts, listCalendars } from './store.js';
import { addDays, dateIn, dayLabel, duration, parseDay, timeIn, zonedTime } from './time.js';

export const NO_CALENDAR = 'No calendar is linked yet. Add one on Settings → Calendar.';

/** Home's limit on a glance's text (core's `HOME_GLANCE_MAX`), kept here so no core value is imported. */
export const HOME_GLANCE_MAX_TEXT = 60;

type Host = Pick<BuddiHost, 'http' | 'network' | 'db' | 'clock' | 'owner'>;

/** What a tool answers when no calendar is linked. */
export interface NotLinked {
  linked: false;
  message: string;
}

export const NOT_LINKED: NotLinked = { linked: false, message: NO_CALENDAR };

/** One card on the canvas: the time, the title, and the day or the place under it. */
export interface EventTile {
  time: string;
  title: string;
  day?: string;
  where?: string;
}

export function eventTile(o: Occurrence, timezone: string, withDay = false): EventTile {
  const day = o.allDay ? o.startDate! : dateIn(o.start, timezone);
  return {
    time: o.allDay ? 'All day' : timeIn(o.start, timezone),
    title: o.summary,
    ...(withDay ? { day: dayLabel(day) } : {}),
    ...(o.location ? { where: o.location } : {}),
  };
}

/**
 * Every occurrence in the window across the linked calendars (or only the
 * ones named), and what could not be read; null when no calendar is linked.
 */
export async function gather(
  buddi: Host,
  from: Date,
  to: Date,
  only?: ReadonlySet<string>,
): Promise<{ items: Occurrence[]; problems: string[] } | null> {
  const linked = await listCalendars(buddi.db);
  if (linked.length === 0) return null;
  // `only`: the ids the Calendar page's filter chose; every calendar without it.
  const calendars = only ? linked.filter((row) => only.has(row.id)) : linked;
  const items: Occurrence[] = [];
  const problems: string[] = [];
  const google = new Map((await listAccounts(buddi.db)).filter((a) => a.kind === 'google').map((a) => [a.id, a]));
  for (const row of calendars) {
    try {
      const account = row.accountId ? google.get(row.accountId) : undefined;
      const found = account
        ? await googleOccurrencesOf(buddi, row, account, { from, to })
        : occurrences(await eventsOf(buddi, row, { from, to }), from, to, buddi.owner.timezone, row.name);
      for (const o of found) {
        o.calendarId = row.id;
        if (row.writable && row.accountId) o.writable = true;
      }
      items.push(...found);
    } catch (err) {
      problems.push(`${row.name} could not be read: ${err instanceof Error ? err.message : String(err)}`);
    }
  }
  items.sort((a, b) => a.start.getTime() - b.start.getTime() || Number(b.allDay) - Number(a.allDay));
  return { items, problems };
}

/** One line: "09:30–10:00 Team standup (Work, Zoom)". */
export function line(o: Occurrence, timezone: string, many: boolean, withDay = false): string {
  const where = [many ? o.calendar : undefined, o.location].filter(Boolean).join(', ');
  const tail = where ? ` (${where})` : '';
  if (o.allDay) {
    const last = addDays(o.endDate!, -1);
    const span = last === o.startDate ? '' : ` until ${dayLabel(last)}`;
    return `${withDay ? `${dayLabel(o.startDate!)} ` : ''}all day${span}: ${o.summary}${tail}`;
  }
  const startDay = dateIn(o.start, timezone);
  const endDay = dateIn(o.end, timezone);
  const end = o.end.getTime() === o.start.getTime() ? '' : `–${endDay === startDay ? '' : `${dayLabel(endDay)} `}${timeIn(o.end, timezone)}`;
  return `${withDay ? `${dayLabel(startDay)} ` : ''}${timeIn(o.start, timezone)}${end} ${o.summary}${tail}`;
}

const withProblems = <T extends object>(body: T, problems: string[]): T & { problems?: string[] } =>
  problems.length > 0 ? { ...body, problems } : body;

/** An event as the write tools name it: its calendar's id, a slash, its UID. A repeating event is its series. */
export const eventId = (calendarId: string, uid: string): string => `${calendarId}/${uid}`;

/** For the model only: the events in this answer it may change, with their ids. */
export interface Changeable {
  forAgent?: { changeable: Array<{ id: string; event: string }>; note: string };
}

export const CHANGEABLE_NOTE =
  'Ids for calendar.update_event and calendar.cancel_event. A repeating event has one id: changing or cancelling it is the whole series.';

/** The events in a calendar the owner lets agents change, once each, with their ids. */
export function changeable(items: readonly Occurrence[], timezone: string, many: boolean): Changeable {
  const seen = new Map<string, string>();
  for (const o of items) {
    if (!o.writable || !o.calendarId || !o.uid) continue;
    const id = eventId(o.calendarId, o.uid);
    if (!seen.has(id)) seen.set(id, `${line(o, timezone, many, true)}${o.recurring ? ' (repeats)' : ''}`);
  }
  return seen.size === 0 ? {} : { forAgent: { changeable: [...seen].map(([id, event]) => ({ id, event })), note: CHANGEABLE_NOTE } };
}

export const todayTool: ToolDefinition<Record<string, never>, ({ date: string; events: string[]; tiles: EventTile[]; problems?: string[] } & Changeable) | NotLinked> = {
  name: 'calendar.today',
  description:
    "Today's events from the owner's linked calendars, in their time: all-day events first, then each meeting with its " +
    'start and end. Use it for the morning brief and whenever the owner asks what today holds.',
  tier: 'auto',
  input: z.object({}).strict() as unknown as z.ZodType<Record<string, never>>,
  async execute(_input, ctx) {
    const buddi = ctx.buddi!;
    const tz = buddi.owner.timezone;
    const date = dateIn(buddi.clock.now(), tz);
    const found = await gather(buddi, zonedTime(date, '00:00', tz), zonedTime(addDays(date, 1), '00:00', tz));
    if (!found) return NOT_LINKED;
    const { items, problems } = found;
    const many = new Set(items.map((i) => i.calendar)).size > 1;
    const events = items.map((o) => line(o, tz, many));
    return withProblems(
      {
        date: `${dayLabel(date)} (${date})`,
        events: events.length > 0 ? events : ['No events today.'],
        tiles: items.map((o) => eventTile(o, tz)),
        ...changeable(items, tz, many),
      },
      problems,
    );
  },
};

const upcomingInput = z
  .object({ days: z.coerce.number().int().min(1).max(14).optional().describe('Days ahead, today included. 7 when left out, at most 14.') })
  .strict();

export const upcomingTool: ToolDefinition<
  z.infer<typeof upcomingInput>,
  ({ days: Array<{ date: string; events: string[] }>; tiles: EventTile[]; problems?: string[] } & Changeable) | NotLinked
> = {
  name: 'calendar.upcoming',
  description:
    "The owner's events for the coming days, today included, grouped by day in their time. Use it to plan the week " +
    'or answer "what do I have on Thursday".',
  tier: 'auto',
  input: upcomingInput,
  async execute(input, ctx) {
    const buddi = ctx.buddi!;
    const tz = buddi.owner.timezone;
    const today = dateIn(buddi.clock.now(), tz);
    const count = input.days ?? 7;
    const found = await gather(buddi, zonedTime(today, '00:00', tz), zonedTime(addDays(today, count), '00:00', tz));
    if (!found) return NOT_LINKED;
    const { items, problems } = found;
    const many = new Set(items.map((i) => i.calendar)).size > 1;
    const days: Array<{ date: string; events: string[] }> = [];
    const tiles: EventTile[] = [];
    for (let i = 0; i < count; i++) {
      const date = addDays(today, i);
      const from = zonedTime(date, '00:00', tz).getTime();
      const to = zonedTime(addDays(date, 1), '00:00', tz).getTime();
      const events = items.filter((o) => o.start.getTime() < to && o.end.getTime() > from || (o.start.getTime() === o.end.getTime() && o.start.getTime() >= from && o.start.getTime() < to));
      if (events.length > 0) days.push({ date: `${dayLabel(date)} (${date})`, events: events.map((o) => line(o, tz, many)) });
      // One card per event per day it falls on, with that day under the title.
      for (const o of events) tiles.push({ ...eventTile(o, tz), day: dayLabel(date) });
    }
    return withProblems({ days, tiles, ...changeable(items, tz, many) }, problems);
  },
};

const findInput = z
  .object({
    query: z.string().trim().min(2).max(120).describe('Words in the title, place or notes.'),
    from: z.string().max(10).optional().describe('YYYY-MM-DD, today or tomorrow. 30 days ago when left out.'),
    to: z.string().max(10).optional().describe('YYYY-MM-DD, the last day searched. 180 days ahead when left out.'),
  })
  .strict();

export const MAX_FOUND = 25;

export const findTool: ToolDefinition<z.infer<typeof findInput>, ({ found: string[]; more?: number; problems?: string[] } & Changeable) | NotLinked> = {
  name: 'calendar.find',
  description:
    "Search the owner's calendars for events whose title, place or notes contain the words, from 30 days ago to 180 " +
    'days ahead unless given dates. Use it for "when is the dentist" or "when did I last see Sam".',
  tier: 'auto',
  input: findInput,
  async execute(input, ctx) {
    const buddi = ctx.buddi!;
    const tz = buddi.owner.timezone;
    const now = buddi.clock.now();
    const today = dateIn(now, tz);
    const fromDay = input.from ? parseDay(input.from, now, tz) : addDays(today, -30);
    const toDay = input.to ? parseDay(input.to, now, tz) : addDays(today, 180);
    if (!fromDay || !toDay) throw new Error('Give dates as YYYY-MM-DD, today or tomorrow.');
    if (toDay < fromDay) throw new Error('The last day is before the first.');
    const gathered = await gather(buddi, zonedTime(fromDay, '00:00', tz), zonedTime(addDays(toDay, 1), '00:00', tz));
    if (!gathered) return NOT_LINKED;
    const { items, problems } = gathered;
    const words = input.query.toLowerCase().split(/\s+/).filter(Boolean);
    const matches = items.filter((o) => {
      const hay = [o.summary, o.location ?? '', o.description ?? ''].join(' ').toLowerCase();
      return words.every((w) => hay.includes(w));
    });
    const many = new Set(items.map((i) => i.calendar)).size > 1;
    const found = matches.slice(0, MAX_FOUND).map((o) => line(o, tz, many, true));
    return withProblems(
      {
        found: found.length > 0 ? found : [`Nothing matching "${input.query}" between ${fromDay} and ${toDay}.`],
        ...(matches.length > MAX_FOUND ? { more: matches.length - MAX_FOUND } : {}),
        ...changeable(matches.slice(0, MAX_FOUND), tz, many),
      },
      problems,
    );
  },
};

const freeInput = z
  .object({
    date: z.string().max(10).describe('YYYY-MM-DD, today or tomorrow.'),
    from: z.string().regex(/^\d{1,2}:\d{2}$/).optional().describe('Start of the day to consider, HH:MM. 09:00 when left out.'),
    to: z.string().regex(/^\d{1,2}:\d{2}$/).optional().describe('End of the day to consider, HH:MM. 18:00 when left out.'),
  })
  .strict();

/** The gaps in `[from, to)` that no busy occurrence covers, at least `min` long. */
export function freeSlots(busy: ReadonlyArray<{ start: Date; end: Date }>, from: Date, to: Date, minMs = 15 * 60_000): Array<{ start: Date; end: Date }> {
  const spans = busy
    .map((b) => ({ start: Math.max(b.start.getTime(), from.getTime()), end: Math.min(b.end.getTime(), to.getTime()) }))
    .filter((b) => b.end > b.start)
    .sort((a, b) => a.start - b.start);
  const out: Array<{ start: Date; end: Date }> = [];
  let cursor = from.getTime();
  for (const span of spans) {
    if (span.start - cursor >= minMs) out.push({ start: new Date(cursor), end: new Date(span.start) });
    cursor = Math.max(cursor, span.end);
  }
  if (to.getTime() - cursor >= minMs) out.push({ start: new Date(cursor), end: to });
  return out;
}

const hhmm = (t: string): string => t.padStart(5, '0');

export const freeTool: ToolDefinition<z.infer<typeof freeInput>, { date: string; free: string[]; busy: string[]; problems?: string[] } | NotLinked> = {
  name: 'calendar.free',
  description:
    "The owner's free time on one day, between 09:00 and 18:00 unless told otherwise, from the meetings in their " +
    'calendars (all-day events and ones marked free do not count). Use it before proposing a time.',
  tier: 'auto',
  input: freeInput,
  async execute(input, ctx) {
    const buddi = ctx.buddi!;
    const tz = buddi.owner.timezone;
    const date = parseDay(input.date, buddi.clock.now(), tz);
    if (!date) throw new Error('Give the date as YYYY-MM-DD, today or tomorrow.');
    const fromTime = hhmm(input.from ?? '09:00');
    const toTime = hhmm(input.to ?? '18:00');
    if (toTime <= fromTime) throw new Error('The end of the day is before its start.');
    const from = zonedTime(date, fromTime, tz);
    const to = zonedTime(date, toTime, tz);
    const gathered = await gather(buddi, from, to);
    if (!gathered) return NOT_LINKED;
    const { items, problems } = gathered;
    const busy = items.filter((o) => o.busy);
    const many = new Set(items.map((i) => i.calendar)).size > 1;
    const free = freeSlots(busy, from, to).map((s) => `${timeIn(s.start, tz)}–${timeIn(s.end, tz)} (${duration(s.end.getTime() - s.start.getTime())})`);
    return withProblems(
      {
        date: `${dayLabel(date)} (${date}), ${fromTime}–${toTime}`,
        free: free.length > 0 ? free : ['No free time in those hours.'],
        busy: busy.map((o) => line(o, tz, many)),
      },
      problems,
    );
  },
};

export const calendarTools = [todayTool, upcomingTool, findTool, freeTool];
