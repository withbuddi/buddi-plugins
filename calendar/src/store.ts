/**
 * The linked calendars, and reading them. A row holds the name, the provider,
 * the host and the name of the owner secret that *is* the link; the link is
 * fetched through `ctx.buddi.http` with `auth: { secret, as: 'url' }` (host
 * API 1.9), so core inserts it and this plugin never reads it. Each calendar's
 * events are kept in memory for ten minutes.
 */
import type { BuddiHost, DbArea } from '@buddi/core/plugin';
import type { VEvent } from 'node-ical';
import { parseIcs } from './ics.js';

export interface CalendarRow {
  id: string;
  name: string;
  provider: string;
  host: string;
  secretName: string;
  lastFetchedAt: Date | null;
  lastError: string | null;
  eventCount: number | null;
}

type Db = Pick<DbArea, 'query'>;

export const CACHE_MS = 10 * 60 * 1000;
export const FETCH_TIMEOUT_MS = 20_000;
export const MAX_BYTES = 15_000_000;

/** The hosts the manifest names; any other is declared at runtime, with why. */
export const KNOWN_HOSTS = ['calendar.google.com', '*.icloud.com', 'outlook.office365.com', 'outlook.live.com'];

export function toRow(r: Record<string, unknown>): CalendarRow {
  return {
    id: String(r.id),
    name: String(r.name),
    provider: String(r.provider),
    host: String(r.host),
    secretName: String(r.secret_name),
    lastFetchedAt: r.last_fetched_at instanceof Date ? r.last_fetched_at : null,
    lastError: r.last_error === null || r.last_error === undefined ? null : String(r.last_error),
    eventCount: r.event_count === null || r.event_count === undefined ? null : Number(r.event_count),
  };
}

export async function listCalendars(db: Db): Promise<CalendarRow[]> {
  const { rows } = await db.query(
    `select id, name, provider, host, secret_name, last_fetched_at, last_error, event_count from calendar.calendar order by created_at, name`,
  );
  return rows.map((r) => toRow(r as Record<string, unknown>));
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

const cache = new Map<string, { at: number; events: VEvent[] }>();

/** Keep what was just read, so the first question after adding does not read it again. */
export function remember(id: string, events: VEvent[], at: Date): void {
  cache.set(id, { at: at.getTime(), events });
}

/** Forget one calendar's events, or all of them. */
export function dropCache(id?: string): void {
  if (id === undefined) cache.clear();
  else cache.delete(id);
}

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
 * One calendar's events: from memory when read in the last ten minutes, else
 * fetched and parsed, and the row updated with when and how it went.
 */
export async function eventsOf(buddi: Pick<BuddiHost, 'http' | 'network' | 'db' | 'clock'>, row: CalendarRow): Promise<VEvent[]> {
  const now = buddi.clock.now().getTime();
  const hit = cache.get(row.id);
  if (hit && now - hit.at < CACHE_MS) return hit.events;
  try {
    const events = parseIcs(await fetchIcs(buddi, row.host, row.secretName));
    cache.set(row.id, { at: now, events });
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
