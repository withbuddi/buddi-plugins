/**
 * CalDAV over `ctx.buddi.http` (host API 1.26): every request carries the
 * account's app password as Basic auth, filled in by core from the owner
 * secret — `auth: { secret, as: 'basic', username }` — so this plugin names
 * the user and never holds the password. Core keeps the requests to the
 * account's host (exact, or `*.icloud.com` for iCloud's numbered hosts), to
 * the WebDAV verbs, a small body, a capped answer and a per-minute budget.
 *
 * What is here: discovery (the principal, its calendar home, the calendars in
 * it with their names and colours), a time-range query, one resource read by
 * href or found by UID, and a write or a delete guarded by its ETag, so a
 * change made elsewhere since buddi read the event is refused rather than
 * overwritten.
 */
import type { BuddiHost } from '@buddi/core/plugin';
import { APPLE, CALDAV, CS, DAV, childOf, childrenOf, escapeXml, parseXml, type XmlElement } from './xml.js';

export const DAV_TIMEOUT_MS = 20_000;
/** The most a calendar answer may carry; core caps it at 10 MB whatever is asked. */
export const DAV_MAX_BYTES = 10 * 1024 * 1024;
const MAX_REDIRECTS = 5;

/** One answer, its body read. `url` is where it finally came from, after redirects. */
export interface DavResponse {
  status: number;
  url: string;
  etag: string | null;
  body: string;
}

export interface DavRequest {
  method: 'GET' | 'PROPFIND' | 'REPORT' | 'PUT' | 'DELETE';
  url: string;
  headers?: Record<string, string>;
  body?: string;
}

/** How a request is sent: through core in the plugin, a fake server in a test. */
export type DavSend = (req: DavRequest) => Promise<DavResponse>;

/** What signing in to an account takes: never the password, only its secret's name. */
export interface DavSignIn {
  /** The host the password may go to: exact, or `*.` a domain. */
  hostPattern: string;
  username: string;
  secretName: string;
}

/** A status the server answered that the caller has a sentence for. */
export class DavError extends Error {
  constructor(
    message: string,
    readonly status: number,
  ) {
    super(message);
    this.name = 'DavError';
  }
}

/** The event changed on the server since buddi read it (412 on If-Match). */
export class StaleError extends Error {
  constructor(message = 'the event changed in the calendar since buddi read it') {
    super(message);
    this.name = 'StaleError';
  }
}

/** Whether a host is one a pattern names: the same, or under its `*.` domain. */
export function hostCovered(pattern: string, host: string): boolean {
  const h = host.toLowerCase();
  const p = pattern.toLowerCase();
  if (p.startsWith('*.')) return h.endsWith(p.slice(1)) && h.length > p.length - 1;
  return h === p;
}

function declare(buddi: Pick<BuddiHost, 'network'>, host: string): void {
  const known = buddi.network.declared().some((d) => d.host === host || (d.host.startsWith('*.') && hostCovered(d.host, host)));
  if (!known) buddi.network.declare([{ host, why: 'A calendar account you linked: buddi reads its calendars and writes the events you approve.' }]);
}

/**
 * Send through core, signed in as the account: HTTPS only, to the account's
 * host only, redirects followed by hand (core follows none) while they stay
 * on that host.
 */
export function davSender(buddi: Pick<BuddiHost, 'http' | 'network'>, account: DavSignIn): DavSend {
  return async (req) => {
    if (buddi.http === undefined) throw new Error('calendar: no http area (the manifest declares uses: http).');
    let url = req.url;
    for (let hop = 0; ; hop++) {
      const parsed = new URL(url);
      if (parsed.protocol !== 'https:') throw new Error('buddi signs in to a calendar server over HTTPS only.');
      if (!hostCovered(account.hostPattern, parsed.hostname)) {
        throw new Error(`the server sent buddi to ${parsed.hostname}, which is not this account's server (${account.hostPattern}).`);
      }
      declare(buddi, parsed.hostname);
      const response = await buddi.http.request({
        url,
        method: req.method,
        headers: { ...(req.headers ?? {}) },
        ...(req.body === undefined ? {} : { body: req.body }),
        auth: { secret: account.secretName, as: 'basic', username: account.username },
        signal: AbortSignal.timeout(DAV_TIMEOUT_MS),
        idleTimeoutMs: DAV_TIMEOUT_MS,
        maxBytes: DAV_MAX_BYTES,
      });
      const location = response.headers.get('location');
      if ([301, 302, 307, 308].includes(response.status) && location && hop < MAX_REDIRECTS) {
        url = new URL(location, url).toString();
        continue;
      }
      return { status: response.status, url, etag: response.headers.get('etag'), body: await response.text() };
    }
  };
}

/* ------------------------------------------------------------------ *
 * Multistatus
 * ------------------------------------------------------------------ */

interface DavItem {
  href: string;
  /** The props a 200 propstat carried. */
  props: XmlElement | undefined;
}

function multistatus(body: string, base: string): DavItem[] {
  const doc = parseXml(body);
  if (doc.ns !== DAV || doc.name !== 'multistatus') throw new Error('the server did not answer with a WebDAV multistatus');
  return childrenOf(doc, DAV, 'response').flatMap((response) => {
    const href = childOf(response, DAV, 'href')?.text.trim();
    if (!href) return [];
    const ok = childrenOf(response, DAV, 'propstat').find((ps) => /\s2\d\d\s/.test(` ${childOf(ps, DAV, 'status')?.text ?? ''} `));
    return [{ href: new URL(href, base).toString(), props: childOf(ok, DAV, 'prop') }];
  });
}

const XML_HEADERS = { 'content-type': 'application/xml; charset=utf-8' };

function says(status: number, what: string): DavError {
  if (status === 401 || status === 403) {
    return new DavError('the server turned the sign-in down: check the user name, and that the password is an app-specific password.', status);
  }
  if (status === 404) return new DavError(`the server has no ${what} there (404).`, status);
  return new DavError(`the server answered ${status} for ${what}.`, status);
}

async function propfind(send: DavSend, url: string, depth: '0' | '1', props: string, what: string): Promise<{ items: DavItem[]; url: string }> {
  const body =
    `<?xml version="1.0" encoding="utf-8"?>` +
    `<d:propfind xmlns:d="DAV:" xmlns:c="${CALDAV}" xmlns:a="${APPLE}" xmlns:cs="${CS}"><d:prop>${props}</d:prop></d:propfind>`;
  const res = await send({ method: 'PROPFIND', url, headers: { ...XML_HEADERS, depth }, body });
  if (res.status !== 207) throw says(res.status, what);
  return { items: multistatus(res.body, res.url), url: res.url };
}

/* ------------------------------------------------------------------ *
 * Discovery
 * ------------------------------------------------------------------ */

/** One calendar an account holds, as discovery found it. */
export interface FoundCalendar {
  url: string;
  name: string;
  /** `#rrggbb`, or null when the server keeps none. */
  color: string | null;
  /** Whether it holds events (some hold only reminders). */
  events: boolean;
  /** Whether the server lets this user write it; null when it did not say. */
  writable: boolean | null;
}

export interface Discovery {
  principal: string;
  home: string;
  calendars: FoundCalendar[];
}

/** `#RRGGBBAA` or `#RGB` to `#rrggbb`; anything else to null. */
export function normaliseColor(raw: string | undefined): string | null {
  const t = (raw ?? '').trim().toLowerCase();
  let m = /^#([0-9a-f]{6})(?:[0-9a-f]{2})?$/.exec(t);
  if (m) return `#${m[1]}`;
  m = /^#([0-9a-f])([0-9a-f])([0-9a-f])$/.exec(t);
  return m ? `#${m[1]}${m[1]}${m[2]}${m[2]}${m[3]}${m[3]}` : null;
}

function hrefIn(props: XmlElement | undefined, ns: string, name: string, base: string): string | undefined {
  const href = childOf(childOf(props, ns, name), DAV, 'href')?.text.trim();
  return href ? new URL(href, base).toString() : undefined;
}

/**
 * The principal, its calendar home and the calendars in it. Asks the address
 * given, then `/.well-known/caldav` on the same server, so the owner can give
 * a server's root (iCloud, Fastmail) or the exact address their provider
 * prints (Nextcloud's `…/remote.php/dav`).
 */
export async function discover(send: DavSend, server: string): Promise<Discovery> {
  const ask = '<d:current-user-principal/><c:calendar-home-set/>';
  let principal: string | undefined;
  let home: string | undefined;
  for (const start of [server, new URL('/.well-known/caldav', server).toString()]) {
    let found: { items: DavItem[]; url: string };
    try {
      found = await propfind(send, start, '0', ask, 'calendar account');
    } catch (err) {
      if (err instanceof DavError && (err.status === 401 || err.status === 403)) throw err;
      continue;
    }
    const first = found.items[0];
    home = hrefIn(first?.props, CALDAV, 'calendar-home-set', found.url);
    principal = hrefIn(first?.props, DAV, 'current-user-principal', found.url);
    if (home || principal) break;
  }
  if (!principal && !home) throw new Error('that server did not say where your calendars are. Check the address: it should be the CalDAV address your provider gives.');
  if (!home) {
    const found = await propfind(send, principal!, '0', '<c:calendar-home-set/>', 'calendar home');
    home = hrefIn(found.items[0]?.props, CALDAV, 'calendar-home-set', found.url);
    if (!home) throw new Error('that account did not say where its calendars are kept.');
  }
  const listed = await propfind(
    send,
    home,
    '1',
    '<d:resourcetype/><d:displayname/><a:calendar-color/><c:supported-calendar-component-set/><d:current-user-privilege-set/>',
    'calendar list',
  );
  const calendars: FoundCalendar[] = [];
  for (const item of listed.items) {
    if (!childOf(childOf(item.props, DAV, 'resourcetype'), CALDAV, 'calendar')) continue;
    const comps = childrenOf(childOf(item.props, CALDAV, 'supported-calendar-component-set'), CALDAV, 'comp');
    const events = comps.length === 0 || comps.some((c) => (c.attrs.name ?? '').toUpperCase() === 'VEVENT');
    const privileges = childOf(item.props, DAV, 'current-user-privilege-set');
    const granted = new Set(childrenOf(privileges, DAV, 'privilege').flatMap((p) => p.children.map((c) => c.name)));
    const writable = privileges === undefined ? null : ['all', 'write', 'write-content', 'bind'].some((p) => granted.has(p));
    const name = childOf(item.props, DAV, 'displayname')?.text.trim() || decodeURIComponent(new URL(item.href).pathname.replace(/\/$/, '').split('/').pop() ?? 'Calendar');
    calendars.push({ url: item.href, name, color: normaliseColor(childOf(item.props, APPLE, 'calendar-color')?.text), events, writable });
  }
  return { principal: principal ?? home, home, calendars };
}

/* ------------------------------------------------------------------ *
 * Events
 * ------------------------------------------------------------------ */

/** One calendar object: where it lives, its version, and its iCalendar text. */
export interface DavObject {
  href: string;
  etag: string | null;
  data: string;
}

/** `20261008T140000Z`. */
export function davTime(d: Date): string {
  return d.toISOString().replace(/[-:]/g, '').replace(/\.\d{3}/, '');
}

function objectsOf(body: string, base: string): DavObject[] {
  return multistatus(body, base).flatMap((item) => {
    const data = childOf(item.props, CALDAV, 'calendar-data')?.text;
    if (!data) return [];
    return [{ href: item.href, etag: childOf(item.props, DAV, 'getetag')?.text.trim() || null, data }];
  });
}

/** Every event object with an occurrence in `[from, to)`: a recurring one comes whole, with its rule. */
export async function queryEvents(send: DavSend, calendarUrl: string, from: Date, to: Date): Promise<DavObject[]> {
  const body =
    `<?xml version="1.0" encoding="utf-8"?>` +
    `<c:calendar-query xmlns:d="DAV:" xmlns:c="${CALDAV}"><d:prop><d:getetag/><c:calendar-data/></d:prop>` +
    `<c:filter><c:comp-filter name="VCALENDAR"><c:comp-filter name="VEVENT">` +
    `<c:time-range start="${davTime(from)}" end="${davTime(to)}"/>` +
    `</c:comp-filter></c:comp-filter></c:filter></c:calendar-query>`;
  const res = await send({ method: 'REPORT', url: calendarUrl, headers: { ...XML_HEADERS, depth: '1' }, body });
  if (res.status !== 207) throw says(res.status, 'this calendar');
  return objectsOf(res.body, res.url);
}

/** The object holding the event with this UID, or null. */
export async function findByUid(send: DavSend, calendarUrl: string, uid: string): Promise<DavObject | null> {
  const body =
    `<?xml version="1.0" encoding="utf-8"?>` +
    `<c:calendar-query xmlns:d="DAV:" xmlns:c="${CALDAV}"><d:prop><d:getetag/><c:calendar-data/></d:prop>` +
    `<c:filter><c:comp-filter name="VCALENDAR"><c:comp-filter name="VEVENT">` +
    `<c:prop-filter name="UID"><c:text-match collation="i;octet">${escapeXml(uid)}</c:text-match></c:prop-filter>` +
    `</c:comp-filter></c:comp-filter></c:filter></c:calendar-query>`;
  const res = await send({ method: 'REPORT', url: calendarUrl, headers: { ...XML_HEADERS, depth: '1' }, body });
  if (res.status !== 207) throw says(res.status, 'this calendar');
  // text-match is a substring test: keep the one whose UID is exactly this.
  return objectsOf(res.body, res.url).find((o) => uidsOf(o.data).includes(uid)) ?? null;
}

/** The UIDs an object's text names (unfolded). */
export function uidsOf(data: string): string[] {
  return [...data.replace(/\r?\n[ \t]/g, '').matchAll(/^UID(?:;[^:]*)?:(.*)$/gim)].map((m) => m[1]!.trim());
}

/** One object by its href, with its ETag; null when it is gone. */
export async function getObject(send: DavSend, href: string): Promise<DavObject | null> {
  const res = await send({ method: 'GET', url: href, headers: { accept: 'text/calendar' } });
  if (res.status === 404 || res.status === 410) return null;
  if (res.status !== 200) throw says(res.status, 'this event');
  return { href: res.url, etag: res.etag, data: res.body };
}

/**
 * Write one object. `ifMatch` (an ETag) for a change, so a version moved on
 * by someone else is refused with `StaleError`; `create` for a new one, so a
 * UID already taken is refused rather than replaced.
 */
export async function putObject(send: DavSend, href: string, data: string, guard: { ifMatch: string } | { create: true }): Promise<{ etag: string | null }> {
  const headers: Record<string, string> = { 'content-type': 'text/calendar; charset=utf-8' };
  if ('ifMatch' in guard) headers['if-match'] = guard.ifMatch;
  else headers['if-none-match'] = '*';
  const res = await send({ method: 'PUT', url: href, headers, body: data });
  if (res.status === 412) throw 'ifMatch' in guard ? new StaleError() : new DavError('an event with that id is already in the calendar.', 412);
  if (res.status < 200 || res.status >= 300) throw says(res.status, 'this event');
  return { etag: res.etag };
}

/** Delete one object at the version buddi read. `gone` when it was already gone. */
export async function deleteObject(send: DavSend, href: string, etag: string | null): Promise<'deleted' | 'gone'> {
  const res = await send({ method: 'DELETE', url: href, headers: etag ? { 'if-match': etag } : {} });
  if (res.status === 412) throw new StaleError();
  if (res.status === 404 || res.status === 410) return 'gone';
  if (res.status < 200 || res.status >= 300) throw says(res.status, 'this event');
  return 'deleted';
}

/** Where a new event goes: `<calendar>/<uid>.ics`. */
export function objectHref(calendarUrl: string, uid: string): string {
  const base = calendarUrl.endsWith('/') ? calendarUrl : `${calendarUrl}/`;
  return new URL(`${encodeURIComponent(uid)}.ics`, base).toString();
}

