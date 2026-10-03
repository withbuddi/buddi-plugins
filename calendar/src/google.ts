/**
 * Google Calendar over its API, through `ctx.buddi.http` with `auth: {
 * secret, as: 'bearer' }` (host API 1.28): core keeps the account's tokens
 * as an owner secret, refreshes them at Google and inserts the access token,
 * so this plugin names the secret and never holds a token. A sign-in Google
 * stops accepting (revoked, or the seven days of testing mode) comes back as
 * core's `SignInExpiredError`, read here by its `code`.
 *
 * What is here: the calendar list (`calendarList.list`), events over a time
 * range with repeating ones expanded by Google (`events.list`, `singleEvents`),
 * one event read, and a write — insert, patch, delete — guarded by the
 * event's ETag (`If-Match`), so a change made elsewhere since buddi read the
 * event is refused rather than overwritten.
 */
import { createHash } from 'node:crypto';
import type { BuddiHost } from '@buddi/core/plugin';
import type { Occurrence } from './ics.js';
import type { EventFacts, EventTime } from './icalwrite.js';
import { StaleError } from './caldav.js';
import { dateIn, timeIn, zonedTime } from './time.js';
import { GOOGLE_API, GOOGLE_API_HOST } from './google-client.js';

export const GOOGLE_TIMEOUT_MS = 20_000;
export const GOOGLE_MAX_BYTES = 10 * 1024 * 1024;

export interface GoogleRequest {
  method: 'GET' | 'POST' | 'PATCH' | 'DELETE';
  /** Under `/calendar/v3`, each segment already encoded. */
  path: string;
  query?: Record<string, string>;
  body?: unknown;
  headers?: Record<string, string>;
}

export interface GoogleResponse {
  status: number;
  etag: string | null;
  /** The JSON answer, or null for an empty one. */
  data: any;
}

/** How a request is sent: through core in the plugin, a fake server in a test. */
export type GoogleSend = (req: GoogleRequest) => Promise<GoogleResponse>;

/** Google no longer accepts the sign-in: the owner signs in again. */
export class GoogleSignedOut extends Error {
  constructor(message = 'Google no longer accepts buddi’s sign-in. Sign in to Google again on Settings → Calendar.') {
    super(message);
    this.name = 'GoogleSignedOut';
  }
}

/** Core's `SignInExpiredError`, by its code: the plugin may load its own copy of core's module. */
export const isSignInExpired = (err: unknown): boolean =>
  typeof err === 'object' && err !== null && (err as { code?: unknown }).code === 'sign-in-expired';

const enc = encodeURIComponent;

/** Send through core, as the account the secret signs in. */
export function googleSender(buddi: Pick<BuddiHost, 'http'>, secretName: string): GoogleSend {
  return async (req) => {
    if (buddi.http === undefined) throw new Error('calendar: no http area (the manifest declares uses: http).');
    const url = new URL(`${GOOGLE_API}${req.path}`);
    for (const [k, v] of Object.entries(req.query ?? {})) url.searchParams.set(k, v);
    let response;
    try {
      response = await buddi.http.request({
        url: url.toString(),
        method: req.method,
        headers: { accept: 'application/json', ...(req.body === undefined ? {} : { 'content-type': 'application/json' }), ...(req.headers ?? {}) },
        ...(req.body === undefined ? {} : { body: JSON.stringify(req.body) }),
        auth: { secret: secretName, as: 'bearer' },
        signal: AbortSignal.timeout(GOOGLE_TIMEOUT_MS),
        idleTimeoutMs: GOOGLE_TIMEOUT_MS,
        maxBytes: GOOGLE_MAX_BYTES,
      });
    } catch (err) {
      if (isSignInExpired(err)) throw new GoogleSignedOut();
      throw err;
    }
    const text = await response.text();
    let data: any = null;
    if (text.trim() !== '') {
      try {
        data = JSON.parse(text);
      } catch {
        data = null;
      }
    }
    return { status: response.status, etag: response.headers.get('etag') ?? (typeof data?.etag === 'string' ? data.etag : null), data };
  };
}

/** What Google said went wrong, in a sentence that names no token. */
function says(res: GoogleResponse, what: string): Error {
  if (res.status === 401) return new GoogleSignedOut();
  const reason = String(res.data?.error?.errors?.[0]?.reason ?? res.data?.error?.status ?? '');
  if (res.status === 403 && /rate|quota|limit/i.test(reason)) return new Error(`Google is limiting requests just now (${what}); buddi tries again later.`);
  if (res.status === 403) return new Error(`Google refused ${what} (403${reason ? `, ${reason}` : ''}).`);
  if (res.status === 404) return new Error(`Google has no ${what} there (404).`);
  return new Error(`Google answered ${res.status} for ${what}.`);
}

/* ------------------------------------------------------------------ *
 * The calendar list
 * ------------------------------------------------------------------ */

/** One calendar the account holds, as Google lists it. */
export interface GoogleCalendar {
  id: string;
  name: string;
  /** `#rrggbb`, or null. */
  color: string | null;
  /** The account may add and change events in it (owner or writer). */
  writable: boolean;
  primary: boolean;
}

const hex = (c: unknown): string | null => (typeof c === 'string' && /^#[0-9a-f]{6}$/i.test(c) ? c.toLowerCase() : null);

/** Every calendar in the account's list, the primary first. */
export async function listGoogleCalendars(send: GoogleSend): Promise<GoogleCalendar[]> {
  const out: GoogleCalendar[] = [];
  let pageToken: string | undefined;
  for (let page = 0; page < 20; page++) {
    const res = await send({ method: 'GET', path: '/users/me/calendarList', query: { maxResults: '250', ...(pageToken ? { pageToken } : {}) } });
    if (res.status !== 200) throw says(res, 'calendar list');
    for (const item of (res.data?.items ?? []) as Array<Record<string, unknown>>) {
      if (typeof item.id !== 'string' || item.deleted === true) continue;
      const name = String(item.summaryOverride ?? item.summary ?? item.id).trim() || item.id;
      out.push({
        id: item.id,
        name,
        color: hex(item.backgroundColor),
        writable: item.accessRole === 'owner' || item.accessRole === 'writer',
        primary: item.primary === true,
      });
    }
    pageToken = typeof res.data?.nextPageToken === 'string' ? res.data.nextPageToken : undefined;
    if (!pageToken) break;
  }
  return out.sort((a, b) => Number(b.primary) - Number(a.primary));
}

/* ------------------------------------------------------------------ *
 * Events
 * ------------------------------------------------------------------ */

export interface GoogleTime {
  date?: string;
  dateTime?: string;
  timeZone?: string;
}

/** An event as Google has it, as far as buddi reads it. */
export interface GoogleEvent {
  id: string;
  etag?: string;
  status?: string;
  summary?: string;
  location?: string;
  description?: string;
  start: GoogleTime;
  end: GoogleTime;
  recurrence?: string[];
  recurringEventId?: string;
  attendees?: Array<{ email?: string; self?: boolean; resource?: boolean; organizer?: boolean }>;
  transparency?: string;
}

const eventPath = (calendarId: string, eventId?: string): string =>
  `/calendars/${enc(calendarId)}/events${eventId === undefined ? '' : `/${enc(eventId)}`}`;

/** Every occurrence with a moment in `[from, to)`: Google expands the repeating ones. */
export async function listGoogleEvents(send: GoogleSend, calendarId: string, from: Date, to: Date, timeZone: string): Promise<GoogleEvent[]> {
  const out: GoogleEvent[] = [];
  let pageToken: string | undefined;
  for (let page = 0; page < 20; page++) {
    const res = await send({
      method: 'GET',
      path: eventPath(calendarId),
      query: {
        timeMin: from.toISOString(),
        timeMax: to.toISOString(),
        singleEvents: 'true',
        orderBy: 'startTime',
        maxResults: '2500',
        timeZone,
        ...(pageToken ? { pageToken } : {}),
      },
    });
    if (res.status !== 200) throw says(res, 'events');
    out.push(...((res.data?.items ?? []) as GoogleEvent[]).filter((e) => typeof e?.id === 'string' && e.start && e.end));
    pageToken = typeof res.data?.nextPageToken === 'string' ? res.data.nextPageToken : undefined;
    if (!pageToken) break;
  }
  return out;
}

/** The series an occurrence belongs to, or the event itself: what the write tools name. */
export const seriesIdOf = (e: Pick<GoogleEvent, 'id' | 'recurringEventId'>): string => e.recurringEventId ?? e.id;

/** Occurrences as the agenda and the tools read them, in the owner's zone. */
export function googleOccurrences(events: readonly GoogleEvent[], from: Date, to: Date, timezone: string, calendar: string): Occurrence[] {
  const out: Occurrence[] = [];
  for (const e of events) {
    if (e.status === 'cancelled') continue;
    const allDay = typeof e.start.date === 'string';
    let start: Date;
    let end: Date;
    let startDate: string | undefined;
    let endDate: string | undefined;
    if (allDay) {
      startDate = e.start.date!;
      endDate = typeof e.end.date === 'string' && e.end.date > startDate ? e.end.date : startDate;
      start = zonedTime(startDate, '00:00', timezone);
      end = zonedTime(endDate, '00:00', timezone);
      if (endDate === startDate) end = new Date(start.getTime() + 86_400_000);
    } else {
      start = new Date(e.start.dateTime ?? '');
      end = new Date(e.end.dateTime ?? e.start.dateTime ?? '');
      if (Number.isNaN(start.getTime())) continue;
      if (Number.isNaN(end.getTime()) || end.getTime() < start.getTime()) end = start;
    }
    const overlaps = end.getTime() > from.getTime() && start.getTime() < to.getTime();
    const instant = end.getTime() === start.getTime() && start.getTime() >= from.getTime() && start.getTime() < to.getTime();
    if (!overlaps && !instant) continue;
    const location = e.location?.trim();
    const description = e.description?.trim();
    out.push({
      calendar,
      uid: seriesIdOf(e),
      summary: e.summary?.trim() || '(no title)',
      ...(location ? { location } : {}),
      ...(description ? { description } : {}),
      start,
      end,
      allDay,
      ...(startDate ? { startDate, endDate } : {}),
      busy: !allDay && e.transparency !== 'transparent',
      ...(e.recurringEventId ? { recurring: true } : {}),
    });
  }
  return out.sort((a, b) => a.start.getTime() - b.start.getTime() || Number(b.allDay) - Number(a.allDay) || a.summary.localeCompare(b.summary));
}

/** One event (a series' master by its id), with its version; null when it is gone. */
export async function getGoogleEvent(send: GoogleSend, calendarId: string, eventId: string): Promise<GoogleEvent | null> {
  const res = await send({ method: 'GET', path: eventPath(calendarId, eventId) });
  if (res.status === 404 || res.status === 410) return null;
  if (res.status !== 200) throw says(res, 'that event');
  const event = res.data as GoogleEvent;
  if (event?.status === 'cancelled') return null;
  return { ...event, ...(res.etag ? { etag: res.etag } : {}) };
}

/** What buddi needs to know about an event before it changes it, as the CalDAV path has it. */
export function googleFacts(e: GoogleEvent, ownerTz: string): EventFacts {
  const allDay = typeof e.start.date === 'string';
  const rule = e.recurrence?.find((l) => /^RRULE:/i.test(l))?.slice(6).trim();
  const tz = e.start.timeZone?.trim();
  let start: Date;
  let end: Date;
  let startDate: string | undefined;
  let endDate: string | undefined;
  if (allDay) {
    startDate = e.start.date!;
    endDate = typeof e.end.date === 'string' && e.end.date > startDate ? e.end.date : startDate;
    start = zonedTime(startDate, '00:00', ownerTz);
    end = zonedTime(endDate, '00:00', ownerTz);
  } else {
    start = new Date(e.start.dateTime ?? '');
    end = new Date(e.end.dateTime ?? e.start.dateTime ?? '');
    if (Number.isNaN(start.getTime())) throw new Error('buddi could not read that event’s time.');
    if (Number.isNaN(end.getTime())) end = start;
  }
  const location = e.location?.trim();
  const description = e.description?.trim();
  return {
    uid: e.id,
    summary: e.summary?.trim() || '(no title)',
    ...(location ? { location } : {}),
    ...(description ? { description } : {}),
    allDay,
    start,
    end,
    ...(startDate ? { startDate, endDate } : {}),
    ...(tz ? { tz } : {}),
    ...(rule ? { rule } : {}),
    // Google keeps a moved occurrence as its own event; the master does not say. Its skipped ones are EXDATEs.
    overrides: false,
    skips: (e.recurrence ?? []).some((l) => /^EXDATE/i.test(l)),
    invitees: (e.attendees ?? []).some((a) => a.self !== true && a.resource !== true),
  };
}

/** An event's time as Google takes it: dates for all-day, the wall clock and its zone otherwise. */
export function googleTime(time: EventTime): { start: GoogleTime; end: GoogleTime } {
  if (time.allDay) return { start: { date: time.startDate }, end: { date: time.endDate } };
  const wall = (d: Date): string => `${dateIn(d, time.tz)}T${timeIn(d, time.tz)}:${String(d.getUTCSeconds()).padStart(2, '0')}`;
  return { start: { dateTime: wall(time.start), timeZone: time.tz }, end: { dateTime: wall(time.end), timeZone: time.tz } };
}

/**
 * A new event's id, from what it is (Google takes ids of 5–1024 characters
 * a–v and 0–9): the same event asked for twice is the same id, refused the
 * second time rather than doubled.
 */
export function googleEventIdFor(seed: string): string {
  return `buddi${createHash('sha256').update(seed).digest('hex').slice(0, 32)}`;
}

/** Insert an event under its id; `exists` when that id is already there. */
export async function insertGoogleEvent(send: GoogleSend, calendarId: string, event: Record<string, unknown>): Promise<'created' | 'exists'> {
  const res = await send({ method: 'POST', path: eventPath(calendarId), query: { sendUpdates: 'none' }, body: event });
  if (res.status === 409) return 'exists';
  if (res.status !== 200 && res.status !== 201) throw says(res, 'the new event');
  return 'created';
}

/** Change an event at the version buddi read; `StaleError` when it moved on since. */
export async function patchGoogleEvent(send: GoogleSend, calendarId: string, eventId: string, changes: Record<string, unknown>, etag: string): Promise<void> {
  const res = await send({ method: 'PATCH', path: eventPath(calendarId, eventId), query: { sendUpdates: 'none' }, body: changes, headers: { 'if-match': etag } });
  if (res.status === 412) throw new StaleError();
  if (res.status === 404 || res.status === 410) throw new Error('the event is no longer in the calendar');
  if (res.status !== 200) throw says(res, 'that change');
}

/** Delete an event at the version buddi read; `gone` when it already was, `StaleError` when it changed. */
export async function deleteGoogleEvent(send: GoogleSend, calendarId: string, eventId: string, etag: string): Promise<'deleted' | 'gone'> {
  const res = await send({ method: 'DELETE', path: eventPath(calendarId, eventId), query: { sendUpdates: 'none' }, headers: { 'if-match': etag } });
  if (res.status === 412) throw new StaleError();
  if (res.status === 404 || res.status === 410) return 'gone';
  if (res.status !== 204 && res.status !== 200) throw says(res, 'that cancellation');
  return 'deleted';
}

export { GOOGLE_API_HOST };
