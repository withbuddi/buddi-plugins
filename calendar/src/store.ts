/**
 * The calendars, and reading them. A calendar is either a private link — the
 * row holds the name of the owner secret that *is* the link, fetched through
 * `ctx.buddi.http` with `auth: { secret, as: 'url' }` (host API 1.9) — or one
 * calendar of a CalDAV account, at its own address, read with a time-range
 * REPORT signed in with the account's app password (`as: 'basic'`, 1.26).
 * Either way core inserts the credential and this plugin never reads it.
 * Each calendar's events are kept in memory for ten minutes.
 */
import type { BuddiHost, DbArea } from '@buddi/core/plugin';
import type { VEvent } from 'node-ical';
import { parseIcs } from './ics.js';
import { davSender, queryEvents, uidsOf, type DavSend } from './caldav.js';
import { addDays, dateIn, zonedTime } from './time.js';

export interface CalendarRow {
  id: string;
  name: string;
  provider: string;
  host: string;
  /** The private link's secret; null for an account's calendar. */
  secretName: string | null;
  lastFetchedAt: Date | null;
  lastError: string | null;
  eventCount: number | null;
  /** The account it belongs to, and its address there; null for a private link. */
  accountId: string | null;
  url: string | null;
  color: string | null;
  /** Agents read it. */
  linked: boolean;
  /** The owner lets agents add and change events in it (each change approved). */
  writable: boolean;
  /** What the server said about writing it; null when it did not say. */
  canWrite: boolean | null;
}

/**
 * A sign-in to a calendar server. `kind` is `caldav`; `google` (OAuth) is
 * the seam for later, read through the same rows.
 */
export interface AccountRow {
  id: string;
  kind: string;
  service: string;
  label: string;
  server: string;
  hostPattern: string;
  username: string;
  secretName: string;
  homeUrl: string | null;
  lastFoundAt: Date | null;
  lastError: string | null;
}

type Db = Pick<DbArea, 'query'>;

export const CACHE_MS = 10 * 60 * 1000;
export const FETCH_TIMEOUT_MS = 20_000;
export const MAX_BYTES = 15_000_000;

/** The hosts the manifest names; any other is declared at runtime, with why. */
export const KNOWN_HOSTS = ['calendar.google.com', '*.icloud.com', 'outlook.office365.com', 'outlook.live.com'];

const str = (v: unknown): string | null => (v === null || v === undefined ? null : String(v));

export function toRow(r: Record<string, unknown>): CalendarRow {
  return {
    id: String(r.id),
    name: String(r.name),
    provider: String(r.provider),
    host: String(r.host),
    secretName: str(r.secret_name),
    lastFetchedAt: r.last_fetched_at instanceof Date ? r.last_fetched_at : null,
    lastError: str(r.last_error),
    eventCount: r.event_count === null || r.event_count === undefined ? null : Number(r.event_count),
    accountId: str(r.account_id),
    url: str(r.url),
    color: str(r.color),
    linked: r.linked !== false,
    writable: r.writable === true,
    canWrite: r.can_write === null || r.can_write === undefined ? null : r.can_write === true,
  };
}

const COLUMNS = `id, name, provider, host, secret_name, last_fetched_at, last_error, event_count, account_id, url, color, linked, writable, can_write`;

/** The calendars agents read: every private link, and the account calendars the owner linked. */
export async function listCalendars(db: Db): Promise<CalendarRow[]> {
  const { rows } = await db.query(`select ${COLUMNS} from calendar.calendar where linked order by created_at, name`);
  return rows.map((r) => toRow(r as Record<string, unknown>));
}

/** Every calendar, linked or not: Settings → Calendar's account lists. */
export async function listAllCalendars(db: Db): Promise<CalendarRow[]> {
  const { rows } = await db.query(`select ${COLUMNS} from calendar.calendar order by created_at, name`);
  return rows.map((r) => toRow(r as Record<string, unknown>));
}

export function toAccount(r: Record<string, unknown>): AccountRow {
  return {
    id: String(r.id),
    kind: String(r.kind),
    service: String(r.service),
    label: String(r.label),
    server: String(r.server),
    hostPattern: String(r.host_pattern),
    username: String(r.username),
    secretName: String(r.secret_name),
    homeUrl: str(r.home_url),
    lastFoundAt: r.last_found_at instanceof Date ? r.last_found_at : null,
    lastError: str(r.last_error),
  };
}

export async function listAccounts(db: Db): Promise<AccountRow[]> {
  const { rows } = await db.query(
    `select id, kind, service, label, server, host_pattern, username, secret_name, home_url, last_found_at, last_error
       from calendar.account order by created_at, label`,
  );
  return rows.map((r) => toAccount(r as Record<string, unknown>));
}

export async function accountOf(db: Db, id: string): Promise<AccountRow | undefined> {
  return (await listAccounts(db)).find((a) => a.id === id);
}

/** How a calendar's account is spoken to; a test hands in a fake server instead. */
let sendFor = (buddi: Pick<BuddiHost, 'http' | 'network'>, account: AccountRow): DavSend =>
  davSender(buddi, { hostPattern: account.hostPattern, username: account.username, secretName: account.secretName });

/** Tests only: talk to a fake server. Returns the way back. */
export function setDavSender(make: (buddi: Pick<BuddiHost, 'http' | 'network'>, account: AccountRow) => DavSend): () => void {
  const before = sendFor;
  sendFor = make;
  return () => {
    sendFor = before;
  };
}

export function davFor(buddi: Pick<BuddiHost, 'http' | 'network'>, account: AccountRow): DavSend {
  return sendFor(buddi, account);
}

/** Which service a host belongs to, in the owner's words. */
export function providerOf(host: string): string {
  if (host === 'calendar.google.com') return 'Google';
  if (host === 'icloud.com' || host.endsWith('.icloud.com')) return 'iCloud';
  if (host === 'outlook.office365.com' || host === 'outlook.live.com' || host.endsWith('.outlook.com')) return 'Outlook';
  return 'Calendar link';
}

/**
 * The link as buddi keeps it: `webcal://` read as `https://`, HTTPS only, no
 * user or password in it. Throws a sentence the owner can act on.
 */
export function normaliseLink(raw: string): { link: string; host: string } {
  const trimmed = raw.trim().replace(/^webcals?:\/\//i, 'https://');
  let url: URL;
  try {
    url = new URL(trimmed);
  } catch {
    throw new Error('That is not a web address. Paste the whole private link, starting with https:// or webcal://.');
  }
  if (url.protocol !== 'https:') throw new Error('buddi reads calendar links over HTTPS only. Paste the https:// or webcal:// link.');
  if (url.username !== '' || url.password !== '') throw new Error('Paste the link without a user name or password in it.');
  if (url.pathname === '/' && url.search === '') throw new Error('That is a site, not a calendar link. Paste the private address of the calendar itself.');
  return { link: url.toString(), host: url.hostname.toLowerCase() };
}

function hostDeclared(buddi: Pick<BuddiHost, 'network'>, host: string): boolean {
  return buddi.network.declared().some((d) => d.host === host || (d.host.startsWith('*.') && host.endsWith(d.host.slice(1))));
}

/** Declare a host outside the known ones, so the Plugins page lists it. */
export function declareHost(buddi: Pick<BuddiHost, 'network'>, host: string): void {
  if (hostDeclared(buddi, host)) return;
  buddi.network.declare([{ host, why: 'A calendar you linked: buddi reads its private ICS address, nothing is sent.' }]);
}

/** Where an account calendar's event lives and at which version, by UID. */
export interface ObjectRef {
  href: string;
  etag: string | null;
}

/**
 * What was read: the events, and for an account calendar the window it
 * covers (a link is the whole file) and where each event lives.
 */
interface Cached {
  at: number;
  events: VEvent[];
  from?: number;
  to?: number;
  objects?: Map<string, ObjectRef>;
}

const cache = new Map<string, Cached>();

/** Keep what was just read, so the first question after adding does not read it again. */
export function remember(id: string, events: VEvent[], at: Date): void {
  cache.set(id, { at: at.getTime(), events });
}

/** Forget one calendar's events, or all of them. */
export function dropCache(id?: string): void {
  if (id === undefined) cache.clear();
  else cache.delete(id);
}

/** Where an event read in the last ten minutes lives, when it was. */
export function cachedObject(id: string, uid: string): ObjectRef | undefined {
  return cache.get(id)?.objects?.get(uid);
}

/** How far back and ahead an account calendar is read at least: what `find` searches, and room. */
export const DAV_BACK_DAYS = 35;
export const DAV_AHEAD_DAYS = 190;

/** Fetch the file behind a secret link, through core. Never sees the link. */
export async function fetchIcs(buddi: Pick<BuddiHost, 'http' | 'network'>, host: string, secretName: string): Promise<string> {
  if (buddi.http === undefined) throw new Error('calendar: no http area (the manifest declares uses: http).');
  declareHost(buddi, host);
  const response = await buddi.http.request({
    url: `https://${host}/`,
    auth: { secret: secretName, as: 'url' },
    headers: { accept: 'text/calendar, text/plain;q=0.9, */*;q=0.1' },
    signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
    idleTimeoutMs: FETCH_TIMEOUT_MS,
    maxBytes: MAX_BYTES,
  });
  if (response.status === 401 || response.status === 403 || response.status === 404) {
    throw new Error(`the calendar service answered ${response.status}: the link was reset, unpublished or turned off. Add it again with the new link.`);
  }
  if (!response.ok) throw new Error(`the calendar service answered ${response.status}; buddi tries again later.`);
  return response.text();
}

/**
 * One account calendar's events over a window: a time-range REPORT, each
 * object parsed, and where each event lives kept for the write tools.
 */
async function readDav(
  buddi: Pick<BuddiHost, 'http' | 'network' | 'db' | 'owner'>,
  row: CalendarRow,
  from: Date,
  to: Date,
): Promise<{ events: VEvent[]; objects: Map<string, ObjectRef> }> {
  const account = row.accountId ? await accountOf(buddi.db, row.accountId) : undefined;
  if (!account || !row.url) throw new Error('its account is no longer signed in. Link it again on Settings → Calendar.');
  const found = await queryEvents(davFor(buddi, account), row.url, from, to);
  const events: VEvent[] = [];
  const objects = new Map<string, ObjectRef>();
  for (const object of found) {
    try {
      events.push(...parseIcs(object.data));
    } catch {
      continue; // One object the server mangled does not hide the rest.
    }
    for (const uid of uidsOf(object.data)) objects.set(uid, { href: object.href, etag: object.etag });
  }
  return { events, objects };
}

/**
 * One calendar's events: from memory when read in the last ten minutes, else
 * fetched and parsed, and the row updated with when and how it went. An
 * account calendar is read over a window — five weeks back to half a year
 * ahead, widened to cover `window` when asked for more.
 */
export async function eventsOf(
  buddi: Pick<BuddiHost, 'http' | 'network' | 'db' | 'clock' | 'owner'>,
  row: CalendarRow,
  window?: { from: Date; to: Date },
): Promise<VEvent[]> {
  const now = buddi.clock.now().getTime();
  const hit = cache.get(row.id);
  const covers = (c: Cached): boolean =>
    c.from === undefined || window === undefined || (c.from <= window.from.getTime() && (c.to ?? 0) >= window.to.getTime());
  if (hit && now - hit.at < CACHE_MS && covers(hit)) return hit.events;
  try {
    let events: VEvent[];
    if (row.accountId) {
      const today = dateIn(new Date(now), buddi.owner.timezone);
      let from = zonedTime(addDays(today, -DAV_BACK_DAYS), '00:00', buddi.owner.timezone).getTime();
      let to = zonedTime(addDays(today, DAV_AHEAD_DAYS), '00:00', buddi.owner.timezone).getTime();
      if (window) {
        from = Math.min(from, window.from.getTime() - 86_400_000);
        to = Math.max(to, window.to.getTime() + 86_400_000);
      }
      const read = await readDav(buddi, row, new Date(from), new Date(to));
      events = read.events;
      cache.set(row.id, { at: now, events, from, to, objects: read.objects });
    } else {
      events = parseIcs(await fetchIcs(buddi, row.host, row.secretName ?? ''));
      cache.set(row.id, { at: now, events });
    }
    await buddi.db.query(
      `update calendar.calendar set last_fetched_at = $2, last_error = null, event_count = $3 where id = $1`,
      [row.id, new Date(now), events.length],
    ).catch(() => {});
    return events;
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    await buddi.db.query(`update calendar.calendar set last_error = $2 where id = $1`, [row.id, message.slice(0, 300)]).catch(() => {});
    throw err;
  }
}
