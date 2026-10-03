/**
 * Writing to the owner's calendars: add, change and cancel an event, in a
 * calendar of a signed-in account — CalDAV, or Google through its API
 * (`google.ts`) — the owner allowed changes on.
 *
 * Every call is `gated`: `describe` reads what it needs (the event as the
 * server has it now, and its ETag), renders the card — the calendar, the
 * title, when in the owner's format, before → after for a change — and puts
 * what will be written in the envelope: where, the event's UID, the version
 * it was read at, and each change. Nothing in it depends on the clock, so the
 * executor's second `describe` hashes the same. Core refuses an approval
 * whose event has moved on since the card (its envelope no longer matches);
 * `execute` writes what the envelope says and nothing else, with If-Match on
 * the version the card was made from, so a change landing in between is
 * refused with a sentence rather than overwritten.
 *
 * What it does not do, and the descriptions say so: invite anyone (an event
 * with invitees is left alone), or touch one occurrence of a repeating event
 * — a change is the whole series, and cancelling a series has to be asked
 * for as such (`series: true`).
 */
import { createHash } from 'node:crypto';
import { z } from 'zod';
import { ToolRefusal, type EffectDescription, type ToolContext, type ToolDefinition } from '@buddi/core/plugin';
import { StaleError, deleteObject, findByUid, getObject, objectHref, putObject, type DavObject, type DavSend } from './caldav.js';
import { buildEvent, editEvent, eventFacts, knownZone, parseWhen, validDate, type EventChanges, type EventFacts, type EventTime } from './icalwrite.js';
import { accountOf, cachedObject, davFor, dropCache, googleFor, listCalendars, markSignedOut, type AccountRow, type CalendarRow } from './store.js';
import { GoogleSignedOut, deleteGoogleEvent, getGoogleEvent, googleEventIdFor, googleFacts, googleTime, insertGoogleEvent, patchGoogleEvent } from './google.js';
import { eventId } from './tools.js';
import { glanceFormat } from './home.js';
import { addDays, dateIn, dayLabel, timeIn, zonedTime } from './time.js';

type Host = NonNullable<ToolContext['buddi']>;

/** The longest a timed event buddi writes may last. */
export const MAX_EVENT_MS = 14 * 86_400_000;
/** How long an event lasts when neither an end nor a duration is given. */
export const DEFAULT_DURATION_MIN = 60;

/* ------------------------------------------------------------------ *
 * The owner's words
 * ------------------------------------------------------------------ */

export interface Formats {
  time: '12h' | '24h';
  date: 'short' | 'long' | 'iso';
}

/** How the owner reads times and dates (Settings → Profile), Auto read as their language does, else 24-hour and short. */
export async function ownerFormats(buddi: Pick<Host, 'owner'>): Promise<Formats> {
  const time = await glanceFormat(buddi);
  let date: Formats['date'] = 'short';
  try {
    const set = (await buddi.owner.formats?.())?.date;
    if (set === 'long' || set === 'iso' || set === 'short') date = set;
  } catch {
    // Auto.
  }
  return { time, date };
}

const WEEKDAYS = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];
const MONTHS = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];

/** A date in the owner's format: "Thu 8 Oct", "Thursday, 8 October" or "2026-10-08". */
export function dayText(date: string, f: Formats): string {
  if (f.date === 'iso') return date;
  if (f.date === 'short') return dayLabel(date);
  const [y, m, d] = date.split('-').map(Number) as [number, number, number];
  return `${WEEKDAYS[new Date(Date.UTC(y, m - 1, d)).getUTCDay()]}, ${d} ${MONTHS[m - 1]}`;
}

/** A clock in the owner's format: "14:00" or "2:00 PM". */
export function clockText(at: Date, tz: string, f: Formats): string {
  if (f.time === '24h') return timeIn(at, tz);
  return new Intl.DateTimeFormat('en-US', { timeZone: tz, hour: 'numeric', minute: '2-digit', hourCycle: 'h12' }).format(at);
}

/**
 * When, as the card says it: "Thu 8 Oct, 14:00–15:00", "Thu 8 Oct, 22:00 –
 * Fri 9 Oct, 01:00", "Thu 8 Oct, all day", "Thu 8 Oct – Sat 10 Oct, all day";
 * the zone named when it is not the owner's.
 */
export function whenText(time: EventTime, ownerTz: string, f: Formats): string {
  if (time.allDay) {
    const last = addDays(time.endDate, -1);
    return last === time.startDate ? `${dayText(time.startDate, f)}, all day` : `${dayText(time.startDate, f)} – ${dayText(last, f)}, all day`;
  }
  const tz = time.tz;
  const startDay = dateIn(time.start, tz);
  const endDay = dateIn(time.end, tz);
  const span =
    startDay === endDay
      ? `${dayText(startDay, f)}, ${clockText(time.start, tz, f)}–${clockText(time.end, tz, f)}`
      : `${dayText(startDay, f)}, ${clockText(time.start, tz, f)} – ${dayText(endDay, f)}, ${clockText(time.end, tz, f)}`;
  return tz === ownerTz ? span : `${span} (${tz})`;
}

/** An existing event's time, as `EventTime`. */
export function timeOf(facts: EventFacts, ownerTz: string): EventTime {
  return facts.allDay
    ? { allDay: true, startDate: facts.startDate!, endDate: facts.endDate! }
    : { allDay: false, start: facts.start, end: facts.end, tz: facts.tz ?? ownerTz };
}

const FREQ: Record<string, [string, string]> = { DAILY: ['daily', 'days'], WEEKLY: ['weekly', 'weeks'], MONTHLY: ['monthly', 'months'], YEARLY: ['yearly', 'years'] };

/** "Repeats weekly", "Repeats every 2 weeks". */
export function repeatsText(rule: string): string {
  const parts = Object.fromEntries(rule.split(';').map((p) => p.split('=') as [string, string]));
  const freq = FREQ[(parts.FREQ ?? '').toUpperCase()];
  if (!freq) return 'Repeats';
  const every = Number(parts.INTERVAL ?? 1);
  return every > 1 ? `Repeats every ${every} ${freq[1]}` : `Repeats ${freq[0]}`;
}

const quoted = (text: string): string => `“${text}”`;
const shortText = (text: string, max = 120): string => (text.length > max ? `${text.slice(0, max - 1).trimEnd()}…` : text);

/* ------------------------------------------------------------------ *
 * Calendars and events
 * ------------------------------------------------------------------ */

/** A linked calendar agents may change, by its id or its name. Throws a sentence the model can pass on. */
export async function writableCalendar(buddi: Host, ref: string): Promise<{ row: CalendarRow; account: AccountRow }> {
  const linked = await listCalendars(buddi.db);
  const wanted = ref.trim().toLowerCase();
  const row = linked.find((c) => c.id === wanted) ?? linked.find((c) => c.name.toLowerCase() === wanted);
  const open = linked.filter((c) => c.writable && c.accountId).map((c) => c.name);
  const which = open.length > 0 ? ` Agents may change: ${open.join(', ')}.` : ' No calendar allows changes yet: the owner allows them on Settings → Calendar.';
  if (!row) throw new ToolRefusal(`There is no linked calendar called ${ref}.${which}`);
  if (!row.accountId || !row.url) {
    throw new ToolRefusal(
      `${row.name} is read through a private link, which can only be read. Signing in to its account on Settings → Calendar ` +
        '(Sign in with Google, or an app password for iCloud, Fastmail or CalDAV) lets agents add events.',
    );
  }
  if (!row.writable) throw new ToolRefusal(`The owner has not allowed changes to ${row.name}.${which}`);
  const account = await accountOf(buddi.db, row.accountId);
  if (!account) throw new ToolRefusal(`${row.name}'s account is no longer signed in.`);
  if (account.needsSignIn) throw signedOutRefusal(account);
  return { row, account };
}

/** What a write says when Google no longer accepts the account's sign-in: nothing was written, and what the owner does. */
function signedOutRefusal(account: AccountRow): ToolRefusal {
  return new ToolRefusal(
    `Google no longer accepts buddi’s sign-in to ${account.username}, so buddi changed nothing. ` +
      'The owner signs in to Google again on Settings → Calendar; the calendars stay linked.',
  );
}

/** Run a Google call; a sign-in Google stopped accepting marks the account, tells the owner once, and refuses in words. */
async function onGoogle<T>(buddi: Host, account: AccountRow, run: () => Promise<T>): Promise<T> {
  try {
    return await run();
  } catch (err) {
    if (err instanceof GoogleSignedOut) {
      await markSignedOut(buddi, account);
      throw signedOutRefusal(account);
    }
    throw err;
  }
}

/** An event as the write tools need it: where it lives, its version, its facts. */
interface LoadedEvent {
  href: string;
  etag: string;
  facts: EventFacts;
  /** The iCalendar text, for a CalDAV event. */
  data?: string;
}

/** The event as its calendar has it now, from CalDAV or Google. */
async function readEvent(buddi: Host, row: CalendarRow, account: AccountRow, uid: string): Promise<LoadedEvent> {
  if (account.kind === 'google') {
    const event = await onGoogle(buddi, account, () => getGoogleEvent(googleFor(buddi, account), row.url!, uid));
    if (!event) throw new ToolRefusal(`That event is no longer in ${row.name}.`);
    if (!event.etag) throw new ToolRefusal(`Google gave no version for that event, so buddi cannot change it safely.`);
    return { href: `google:${row.url}`, etag: event.etag, facts: googleFacts(event, buddi.owner.timezone) };
  }
  const { object, facts } = await loadEvent(buddi, davFor(buddi, account), row, uid);
  return { href: object.href, etag: object.etag!, facts, data: object.data };
}

/** A change as Google's patch takes it. */
function googlePatch(changes: EventChanges): Record<string, unknown> {
  return {
    ...(changes.title !== undefined ? { summary: changes.title } : {}),
    ...(changes.location !== undefined ? { location: changes.location ?? '' } : {}),
    ...(changes.notes !== undefined ? { description: changes.notes ?? '' } : {}),
    ...(changes.time ? googleTime(changes.time) : {}),
  };
}

/** `work/abc-123@example.com` → the calendar and the UID. */
export function splitId(id: string): { calendarId: string; uid: string } {
  const slash = id.indexOf('/');
  if (slash <= 0 || slash === id.length - 1) {
    throw new ToolRefusal('That is not an event id. Use the id calendar.today, calendar.upcoming or calendar.find gave for the event.');
  }
  return { calendarId: id.slice(0, slash), uid: id.slice(slash + 1) };
}

/** The event as the server has it now, with its version, and what buddi needs to know about it. */
async function loadEvent(buddi: Host, send: DavSend, row: CalendarRow, uid: string): Promise<{ object: DavObject; facts: EventFacts }> {
  let object: DavObject | null = null;
  const known = cachedObject(row.id, uid);
  if (known) object = await getObject(send, known.href);
  if (!object || !object.data.includes(uid)) object = await findByUid(send, row.url!, uid);
  if (object && !object.etag) {
    // A GET without an ETag: ask once more the way a query answers, with its version.
    object = (await findByUid(send, row.url!, uid)) ?? object;
  }
  if (!object) throw new ToolRefusal(`That event is no longer in ${row.name}.`);
  if (!object.etag) throw new ToolRefusal(`${row.name}'s server gave no version for that event, so buddi cannot change it safely.`);
  return { object, facts: eventFacts(object.data, uid, buddi.owner.timezone) };
}

function zoneOf(buddi: Host, timezone: string | undefined): string {
  const tz = timezone?.trim() || buddi.owner.timezone;
  if (!knownZone(tz)) throw new ToolRefusal(`${tz} is not a time zone. Give an IANA name such as Europe/Paris, or leave it out for the owner's.`);
  return tz;
}

/** `YYYY-MM-DD`, from a date or the date of a date and time. */
function dayOf(text: string, what: string): string {
  const day = text.trim().slice(0, 10);
  if (!validDate(day)) throw new ToolRefusal(`${what} “${text}” is not a date. Give it as YYYY-MM-DD.`);
  return day;
}

function when(text: string, tz: string): Date {
  try {
    return parseWhen(text, tz);
  } catch (err) {
    throw new ToolRefusal(err instanceof Error ? err.message : String(err));
  }
}

function checkSpan(start: Date, end: Date): void {
  if (end.getTime() <= start.getTime()) throw new ToolRefusal('The end is not after the start.');
  if (end.getTime() - start.getTime() > MAX_EVENT_MS) throw new ToolRefusal('An event buddi writes lasts at most 14 days.');
}

/** What the stale-version refusal says: nothing was written, and how to see the event as it is. */
function staleRefusal(title: string, calendar: string): ToolRefusal {
  return new ToolRefusal(
    `${quoted(title)} changed in ${calendar} since you were asked, so buddi changed nothing. Ask again to see it as it is now.`,
  );
}

/* ------------------------------------------------------------------ *
 * calendar.create_event
 * ------------------------------------------------------------------ */

const timeFields = {
  start: z.string().trim().min(10).max(40).describe('YYYY-MM-DDTHH:MM in the owner’s time (or with Z or an offset); YYYY-MM-DD for an all-day event.'),
  end: z.string().trim().min(10).max(40).optional().describe('Same form as start. For an all-day event, the last day (inclusive).'),
  duration: z.coerce.number().int().min(1).max(14 * 24 * 60).optional().describe('Minutes, instead of end. 60 when neither is given.'),
  allDay: z.boolean().optional().describe('An all-day event: start (and end) are dates.'),
  timezone: z.string().trim().max(64).optional().describe('IANA zone the times are in. The owner’s when left out.'),
};

const createInput = z
  .object({
    calendar: z.string().trim().min(1).max(80).describe('The calendar’s name (or id), one the owner allows changes on.'),
    title: z.string().trim().min(1).max(200),
    ...timeFields,
    location: z.string().trim().max(300).optional(),
    notes: z.string().trim().max(4000).optional(),
  })
  .strict();

type CreateInput = z.infer<typeof createInput>;

/** An `EventTime` as JSON: instants as ISO strings. */
type StoredTime =
  | { allDay: false; start: string; end: string; tz: string }
  | { allDay: true; startDate: string; endDate: string };

const storeTime = (t: EventTime): StoredTime =>
  t.allDay ? t : { allDay: false, start: t.start.toISOString(), end: t.end.toISOString(), tz: t.tz };
const loadTime = (t: StoredTime): EventTime =>
  t.allDay ? t : { allDay: false, start: new Date(t.start), end: new Date(t.end), tz: t.tz };

interface CreateEnvelope {
  calendar: string;
  href: string;
  uid: string;
  title: string;
  time: StoredTime;
  location?: string;
  notes?: string;
  when: string;
}

/**
 * A new event's UID, from what it is: the same event asked for twice is the
 * same object, refused the second time ("already in the calendar") rather
 * than doubled — and the executor's second `describe` agrees with the first.
 */
export function uidFor(calendarUrl: string, title: string, time: StoredTime, location?: string, notes?: string): string {
  const hash = createHash('sha256').update(JSON.stringify([calendarUrl, title, time, location ?? '', notes ?? ''])).digest('hex');
  return `${hash.slice(0, 8)}-${hash.slice(8, 12)}-${hash.slice(12, 16)}-${hash.slice(16, 20)}-${hash.slice(20, 32)}@withbuddi.com`;
}

/** When a new event happens, from what the call said. */
function newTime(input: Pick<CreateInput, 'start' | 'end' | 'duration' | 'allDay'>, tz: string): EventTime {
  if (input.allDay) {
    if (input.duration !== undefined) throw new ToolRefusal('An all-day event takes an end date (its last day), not a duration.');
    const startDate = dayOf(input.start, 'The start');
    const last = input.end ? dayOf(input.end, 'The end') : startDate;
    if (last < startDate) throw new ToolRefusal('The last day is before the first.');
    if (addDays(startDate, 14) < last) throw new ToolRefusal('An event buddi writes lasts at most 14 days.');
    return { allDay: true, startDate, endDate: addDays(last, 1) };
  }
  if (/^\d{4}-\d{2}-\d{2}$/.test(input.start.trim())) throw new ToolRefusal('Give the start with a time (YYYY-MM-DDTHH:MM), or set allDay.');
  const start = when(input.start, tz);
  const end = input.end ? when(input.end, tz) : new Date(start.getTime() + (input.duration ?? DEFAULT_DURATION_MIN) * 60_000);
  checkSpan(start, end);
  return { allDay: false, start, end, tz };
}

async function describeCreate(input: CreateInput, ctx: ToolContext): Promise<EffectDescription & { envelope: CreateEnvelope }> {
  const buddi = ctx.buddi!;
  const { row, account } = await writableCalendar(buddi, input.calendar);
  const tz = zoneOf(buddi, input.timezone);
  const time = newTime(input, tz);
  const f = await ownerFormats(buddi);
  const stored = storeTime(time);
  const uid =
    account.kind === 'google'
      ? googleEventIdFor(JSON.stringify([row.url, input.title, stored, input.location ?? '', input.notes ?? '']))
      : uidFor(row.url!, input.title, stored, input.location, input.notes);
  const whenWords = whenText(time, buddi.owner.timezone, f);
  const lines = [`Add to ${row.name} (${account.label})`, quoted(input.title), whenWords];
  if (input.location) lines.push(`Where: ${input.location}`);
  if (input.notes) lines.push(`Notes: ${shortText(input.notes.replace(/\s+/g, ' '))}`);
  return {
    preview: lines.join('\n'),
    envelope: {
      calendar: row.id,
      href: account.kind === 'google' ? `google:${row.url}` : objectHref(row.url!, uid),
      uid,
      title: input.title,
      time: stored,
      ...(input.location ? { location: input.location } : {}),
      ...(input.notes ? { notes: input.notes } : {}),
      when: whenWords,
    },
  };
}

export const createEventTool: ToolDefinition<CreateInput, { note: string; id: string }> = {
  name: 'calendar.create_event',
  description:
    'Add an event to one of the owner’s calendars that allows changes (a Google, iCloud, Fastmail or CalDAV calendar the owner ' +
    'allowed on Settings → Calendar; a private-link calendar is read-only). The owner approves it on a card first. Times ' +
    'are the owner’s unless a timezone is given; an end or a duration in minutes (an hour when neither). Limits: no ' +
    'attendees and no invitations — the event is the owner’s alone; no repeating events.',
  tier: 'gated',
  input: createInput,
  describe: describeCreate,
  async execute(input, ctx) {
    const buddi = ctx.buddi!;
    const env = (ctx.approvedEffect?.envelope as CreateEnvelope | undefined) ?? (await describeCreate(input, ctx)).envelope;
    // Allowed when asked; still allowed now, or nothing is written.
    const { row, account } = await writableCalendar(buddi, env.calendar);
    if (account.kind === 'google') {
      const event = {
        id: env.uid,
        summary: env.title,
        ...(env.location ? { location: env.location } : {}),
        ...(env.notes ? { description: env.notes } : {}),
        ...googleTime(loadTime(env.time)),
      };
      const done = await onGoogle(buddi, account, () => insertGoogleEvent(googleFor(buddi, account), row.url!, event));
      if (done === 'exists') throw new ToolRefusal(`${quoted(env.title)} is already in ${row.name} at that time: buddi added nothing.`);
      dropCache(row.id);
      return { note: `Added ${quoted(env.title)} to ${row.name}: ${env.when}.`, id: eventId(row.id, env.uid) };
    }
    const body = buildEvent({
      uid: env.uid,
      title: env.title,
      time: loadTime(env.time),
      ...(env.location ? { location: env.location } : {}),
      ...(env.notes ? { notes: env.notes } : {}),
      now: buddi.clock.now(),
    });
    try {
      await putObject(davFor(buddi, account), env.href, body, { create: true });
    } catch (err) {
      if (err instanceof Error && /already in the calendar/.test(err.message)) {
        throw new ToolRefusal(`${quoted(env.title)} is already in ${row.name} at that time: buddi added nothing.`);
      }
      throw err;
    }
    dropCache(row.id);
    return { note: `Added ${quoted(env.title)} to ${row.name}: ${env.when}.`, id: eventId(row.id, env.uid) };
  },
};

/* ------------------------------------------------------------------ *
 * calendar.update_event
 * ------------------------------------------------------------------ */

const updateInput = z
  .object({
    id: z.string().trim().min(3).max(400).describe('The event’s id, from calendar.today, calendar.upcoming or calendar.find.'),
    title: z.string().trim().min(1).max(200).optional(),
    start: timeFields.start.optional(),
    end: timeFields.end,
    duration: timeFields.duration,
    allDay: timeFields.allDay,
    timezone: timeFields.timezone,
    location: z.string().trim().max(300).optional().describe('The new place; an empty string takes it away.'),
    notes: z.string().trim().max(4000).optional().describe('The new notes; an empty string takes them away.'),
  })
  .strict();

type UpdateInput = z.infer<typeof updateInput>;

/** A change as the envelope keeps it: what is set, a null taking it away. */
interface StoredChanges {
  title?: string;
  location?: string | null;
  notes?: string | null;
  time?: StoredTime;
}

interface WriteEnvelope {
  calendar: string;
  href: string;
  /** The version the card was made from; nothing is written over another. */
  etag: string;
  uid: string;
  title: string;
  changes?: StoredChanges;
  series?: boolean;
}

const loadChanges = (c: StoredChanges): EventChanges => ({
  ...(c.title !== undefined ? { title: c.title } : {}),
  ...(c.location !== undefined ? { location: c.location } : {}),
  ...(c.notes !== undefined ? { notes: c.notes } : {}),
  ...(c.time ? { time: loadTime(c.time) } : {}),
});

/** The new time of an existing event, or undefined when the call does not move it. */
function movedTime(input: UpdateInput, facts: EventFacts, ownerTz: string): EventTime | undefined {
  const moving = input.start !== undefined || input.end !== undefined || input.duration !== undefined || (input.allDay !== undefined && input.allDay !== facts.allDay);
  if (!moving && input.timezone === undefined) return undefined;
  const tz = input.timezone?.trim() || facts.tz || ownerTz;
  if (!knownZone(tz)) throw new ToolRefusal(`${tz} is not a time zone.`);
  const allDay = input.allDay ?? facts.allDay;
  if (facts.rule) {
    // A series keeps its days: only the time of day and the length move, the same for every occurrence.
    if (allDay !== facts.allDay) throw new ToolRefusal('A repeating event cannot switch between all-day and timed from buddi. Change it in your calendar app.');
    if (allDay) throw new ToolRefusal('A repeating all-day event cannot be moved from buddi; its title, place and notes can change.');
    if (facts.overrides || facts.skips) {
      throw new ToolRefusal('This repeating event has occurrences moved or skipped on their own, so its time cannot change from buddi without breaking them. Change it in your calendar app.');
    }
    const firstDay = dateIn(facts.start, tz);
    const clockOf = (text: string): string => {
      const at = when(text, tz);
      return timeIn(at, tz);
    };
    const startClock = input.start ? clockOf(input.start) : timeIn(facts.start, tz);
    const start = zonedTime(firstDay, startClock, tz);
    const length = input.end && input.start
      ? when(input.end, tz).getTime() - when(input.start, tz).getTime()
      : input.duration !== undefined
        ? input.duration * 60_000
        : input.end
          ? zonedTime(firstDay, clockOf(input.end), tz).getTime() - start.getTime()
          : facts.end.getTime() - facts.start.getTime();
    const end = new Date(start.getTime() + length);
    checkSpan(start, end);
    return { allDay: false, start, end, tz };
  }
  if (allDay) {
    if (input.duration !== undefined) throw new ToolRefusal('An all-day event takes an end date (its last day), not a duration.');
    const startDate = input.start ? dayOf(input.start, 'The start') : facts.allDay ? facts.startDate! : dateIn(facts.start, tz);
    const span = facts.allDay ? Math.round((Date.parse(facts.endDate!) - Date.parse(facts.startDate!)) / 86_400_000) : 1;
    const endDate = input.end ? addDays(dayOf(input.end, 'The end'), 1) : addDays(startDate, Math.max(1, span));
    if (endDate <= startDate) throw new ToolRefusal('The last day is before the first.');
    return { allDay: true, startDate, endDate };
  }
  if (facts.allDay && !input.start) throw new ToolRefusal('To make an all-day event timed, give its start time.');
  const start = input.start ? when(input.start, tz) : facts.start;
  if (input.start && /^\d{4}-\d{2}-\d{2}$/.test(input.start.trim())) throw new ToolRefusal('Give the start with a time (YYYY-MM-DDTHH:MM), or set allDay.');
  const length = facts.allDay ? DEFAULT_DURATION_MIN * 60_000 : facts.end.getTime() - facts.start.getTime();
  const end = input.end ? when(input.end, tz) : input.duration !== undefined ? new Date(start.getTime() + input.duration * 60_000) : new Date(start.getTime() + length);
  checkSpan(start, end);
  return { allDay: false, start, end, tz };
}

async function describeUpdate(input: UpdateInput, ctx: ToolContext): Promise<EffectDescription & { envelope: WriteEnvelope }> {
  const buddi = ctx.buddi!;
  const { calendarId, uid } = splitId(input.id);
  const { row, account } = await writableCalendar(buddi, calendarId);
  const loaded = await readEvent(buddi, row, account, uid);
  const { facts } = loaded;
  if (facts.invitees) throw new ToolRefusal(`${quoted(facts.summary)} has invitees, and buddi does not change events others are invited to. Change it in your calendar app so they are told.`);
  const f = await ownerFormats(buddi);
  const tz = buddi.owner.timezone;
  const changes: EventChanges = {};
  const lines: string[] = [];
  if (input.title !== undefined && input.title !== facts.summary) {
    changes.title = input.title;
    lines.push(`Title: ${quoted(facts.summary)}  →  ${quoted(input.title)}`);
  }
  const time = movedTime(input, facts, tz);
  if (time) {
    const before = whenText(timeOf(facts, tz), tz, f);
    const after = whenText(time, tz, f);
    if (before !== after || time.allDay !== facts.allDay) {
      changes.time = time;
      lines.push(`When:  ${before}  →  ${after}`);
    }
  }
  if (input.location !== undefined && input.location !== (facts.location ?? '')) {
    changes.location = input.location || null;
    lines.push(`Where: ${facts.location ?? '(none)'}  →  ${input.location || '(none)'}`);
  }
  if (input.notes !== undefined && input.notes !== (facts.description ?? '')) {
    changes.notes = input.notes || null;
    lines.push(`Notes: ${facts.description ? shortText(facts.description.replace(/\s+/g, ' '), 60) : '(none)'}  →  ${input.notes ? shortText(input.notes.replace(/\s+/g, ' '), 60) : '(none)'}`);
  }
  if (lines.length === 0) throw new ToolRefusal(`Nothing to change: ${quoted(facts.summary)} is already like that.`);
  const head = [`Change ${quoted(facts.summary)} on ${row.name} (${account.label})`];
  if (facts.rule) head.push(`${repeatsText(facts.rule)}: the whole series changes.`);
  if (loaded.data !== undefined) editEvent(loaded.data, uid, changes, buddi.clock.now()); // It can be made: said now, on no card at all, if not.
  const stored: StoredChanges = {
    ...(changes.title !== undefined ? { title: changes.title } : {}),
    ...(changes.location !== undefined ? { location: changes.location } : {}),
    ...(changes.notes !== undefined ? { notes: changes.notes } : {}),
    ...(changes.time ? { time: storeTime(changes.time) } : {}),
  };
  return {
    preview: [...head, ...lines].join('\n'),
    envelope: { calendar: row.id, href: loaded.href, etag: loaded.etag, uid, title: facts.summary, changes: stored, ...(facts.rule ? { series: true } : {}) },
  };
}

export const updateEventTool: ToolDefinition<UpdateInput, { note: string; id: string }> = {
  name: 'calendar.update_event',
  description:
    'Change an event in a calendar the owner allows changes on: its title, start, end or duration, all-day, place or ' +
    'notes — give only what changes. The owner approves it on a card showing before and after. Limits: no attendees ' +
    'and no invitations (an event with invitees is left alone); a repeating event changes as a whole series — its time ' +
    'of day and length, never one occurrence. If the event changed in the calendar since, nothing is written.',
  tier: 'gated',
  input: updateInput,
  describe: describeUpdate,
  async execute(input, ctx) {
    const buddi = ctx.buddi!;
    const env = (ctx.approvedEffect?.envelope as WriteEnvelope | undefined) ?? (await describeUpdate(input, ctx)).envelope;
    const { row, account } = await writableCalendar(buddi, env.calendar);
    if (account.kind === 'google') {
      try {
        await onGoogle(buddi, account, () => patchGoogleEvent(googleFor(buddi, account), row.url!, env.uid, googlePatch(loadChanges(env.changes ?? {})), env.etag));
      } catch (err) {
        if (err instanceof StaleError) throw staleRefusal(env.title, row.name);
        if (err instanceof Error && /no longer in the calendar/.test(err.message)) throw new ToolRefusal(`${quoted(env.title)} is no longer in ${row.name}: buddi changed nothing.`);
        throw err;
      }
      dropCache(row.id);
      return { note: `Changed ${quoted(env.title)} in ${row.name}${env.series ? ' (the whole series)' : ''}.`, id: eventId(row.id, env.uid) };
    }
    const send = davFor(buddi, account);
    try {
      // The event at the version the card showed, changed as the card said.
      const current = await getObject(send, env.href);
      if (!current) throw new ToolRefusal(`${quoted(env.title)} is no longer in ${row.name}: buddi changed nothing.`);
      if (current.etag !== null && current.etag !== env.etag) throw new StaleError();
      const body = editEvent(current.data, env.uid, loadChanges(env.changes ?? {}), buddi.clock.now());
      await putObject(send, env.href, body, { ifMatch: env.etag });
    } catch (err) {
      if (err instanceof StaleError) throw staleRefusal(env.title, row.name);
      throw err;
    }
    dropCache(row.id);
    return { note: `Changed ${quoted(env.title)} in ${row.name}${env.series ? ' (the whole series)' : ''}.`, id: eventId(row.id, env.uid) };
  },
};

/* ------------------------------------------------------------------ *
 * calendar.cancel_event
 * ------------------------------------------------------------------ */

const cancelInput = z
  .object({
    id: z.string().trim().min(3).max(400).describe('The event’s id, from calendar.today, calendar.upcoming or calendar.find.'),
    series: z.boolean().optional().describe('Required, true, to cancel a repeating event: every occurrence goes.'),
  })
  .strict();

type CancelInput = z.infer<typeof cancelInput>;

async function describeCancel(input: CancelInput, ctx: ToolContext): Promise<EffectDescription & { envelope: WriteEnvelope }> {
  const buddi = ctx.buddi!;
  const { calendarId, uid } = splitId(input.id);
  const { row, account } = await writableCalendar(buddi, calendarId);
  const loaded = await readEvent(buddi, row, account, uid);
  const { facts } = loaded;
  if (facts.invitees) throw new ToolRefusal(`${quoted(facts.summary)} has invitees, and buddi does not cancel events others are invited to. Cancel it in your calendar app so they are told.`);
  if (facts.rule && input.series !== true) {
    throw new ToolRefusal(
      `${quoted(facts.summary)} repeats (${repeatsText(facts.rule).toLowerCase()}). Cancelling it cancels every occurrence: ` +
        'call calendar.cancel_event again with series: true, and the owner is asked for exactly that. One occurrence alone cannot be cancelled from buddi.',
    );
  }
  const f = await ownerFormats(buddi);
  const tz = buddi.owner.timezone;
  const whenWords = whenText(timeOf(facts, tz), tz, f);
  const lines = [`Cancel ${quoted(facts.summary)} on ${row.name} (${account.label})`];
  if (facts.rule) lines.push(`${repeatsText(facts.rule)}, from ${whenWords}`, 'The whole series: every occurrence goes.');
  else lines.push(whenWords);
  if (facts.location) lines.push(`Where: ${facts.location}`);
  return {
    preview: lines.join('\n'),
    envelope: { calendar: row.id, href: loaded.href, etag: loaded.etag, uid, title: facts.summary, ...(facts.rule ? { series: true } : {}) },
  };
}

export const cancelEventTool: ToolDefinition<CancelInput, { note: string }> = {
  name: 'calendar.cancel_event',
  description:
    'Cancel (delete) an event in a calendar the owner allows changes on. The owner approves it on a card first. ' +
    'Limits: an event with invitees is left alone (no cancellations are sent); a repeating event is cancelled only as a ' +
    'whole series, and only when the call says series: true — never one occurrence. If the event changed in the ' +
    'calendar since, nothing is deleted.',
  tier: 'gated',
  input: cancelInput,
  describe: describeCancel,
  async execute(input, ctx) {
    const buddi = ctx.buddi!;
    const env = (ctx.approvedEffect?.envelope as WriteEnvelope | undefined) ?? (await describeCancel(input, ctx)).envelope;
    const { row, account } = await writableCalendar(buddi, env.calendar);
    let done: 'deleted' | 'gone';
    try {
      done =
        account.kind === 'google'
          ? await onGoogle(buddi, account, () => deleteGoogleEvent(googleFor(buddi, account), row.url!, env.uid, env.etag))
          : await deleteObject(davFor(buddi, account), env.href, env.etag);
    } catch (err) {
      if (err instanceof StaleError) throw staleRefusal(env.title, row.name);
      throw err;
    }
    dropCache(row.id);
    if (done === 'gone') return { note: `${quoted(env.title)} was already gone from ${row.name}.` };
    return { note: `Cancelled ${quoted(env.title)} in ${row.name}${env.series ? ', every occurrence' : ''}.` };
  },
};

export const writeTools = [createEventTool, updateEventTool, cancelEventTool];
