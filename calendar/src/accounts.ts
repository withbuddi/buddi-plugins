/**
 * CalDAV accounts: "Link with an app password" on Settings → Calendar.
 *
 * The owner picks a service — iCloud, Fastmail, or another CalDAV server by
 * its address — and types the sign-in name and an app-specific password. The
 * password becomes an owner secret at once (`secrets.put`), bound to core's
 * `http.basic` for this plugin and the account's host (`*.icloud.com`, whose
 * calendars live on numbered hosts; `caldav.fastmail.com`; another server's
 * exact host); this plugin keeps the user name and the secret's name, and
 * core signs every request in. Discovery finds the principal, its calendar
 * home and the calendars in it, each with its name and colour; the ones that
 * hold events are linked for reading straight away, and the owner allows
 * changes on the ones agents may add events to. Every tool here is the
 * owner's own (`ownerOnly`).
 */
import { z } from 'zod';
import type { ToolDefinition } from '@buddi/core/plugin';
import { discover, type FoundCalendar } from './caldav.js';
import { accountOf, davFor, dropCache, listAccounts, listAllCalendars, type AccountRow, type CalendarRow } from './store.js';
import { idOf } from './ids.js';

/** The services the form offers; `other` is any CalDAV server by its address. */
export const SERVICES = {
  icloud: { label: 'iCloud', server: 'https://caldav.icloud.com/', hostPattern: '*.icloud.com' },
  fastmail: { label: 'Fastmail', server: 'https://caldav.fastmail.com/', hostPattern: 'caldav.fastmail.com' },
} as const;

export type Service = keyof typeof SERVICES | 'other';

export const secretNameForAccount = (label: string, username: string): string => `Calendar sign-in: ${label} ${username}`;

/** Another server's address as buddi keeps it: HTTPS, the standard port, no user or password in it. */
export function normaliseServer(raw: string): { server: string; host: string } {
  let url: URL;
  try {
    url = new URL(raw.trim());
  } catch {
    throw new Error('That is not a web address. Give the CalDAV address your provider shows, starting with https://.');
  }
  if (url.protocol !== 'https:') throw new Error('buddi signs in to a calendar server over HTTPS only. Give the https:// address.');
  if (url.username !== '' || url.password !== '') throw new Error('Give the address without a user name or password in it; they go in their own fields.');
  if (url.port !== '' && url.port !== '443') throw new Error('buddi reaches calendar servers on the standard HTTPS port only.');
  return { server: url.toString(), host: url.hostname.toLowerCase() };
}

/** Where a sign-in goes, from what the form said. */
export function whereFor(service: Service, server: string | undefined): { label: string; server: string; hostPattern: string } {
  if (service !== 'other') return { ...SERVICES[service] };
  if (!server) throw new Error('Give the server’s CalDAV address.');
  const { server: url, host } = normaliseServer(server);
  return { label: host, server: url, hostPattern: host };
}

type Host = NonNullable<Parameters<ToolDefinition['execute']>[1]['buddi']>;

/** A name no linked calendar has yet: "Home", else "Home (iCloud)", else "Home (iCloud) 2". */
function freeName(name: string, label: string, taken: ReadonlySet<string>): string {
  if (!taken.has(name.toLowerCase())) return name;
  const withAccount = `${name} (${label})`;
  if (!taken.has(withAccount.toLowerCase())) return withAccount;
  for (let n = 2; ; n++) if (!taken.has(`${withAccount} ${n}`.toLowerCase())) return `${withAccount} ${n}`;
}

function freeId(name: string, taken: ReadonlySet<string>): string {
  const base = idOf(name);
  if (!taken.has(base)) return base;
  for (let n = 2; ; n++) if (!taken.has(`${base}-${n}`)) return `${base}-${n}`;
}

/**
 * Keep what discovery found for an account: new calendars added (linked for
 * reading when they hold events), names, colours and rights refreshed, and
 * calendars the server no longer has dropped. Returns what changed.
 */
async function keepFound(buddi: Host, account: AccountRow, found: FoundCalendar[]): Promise<{ added: number; linked: number; gone: number }> {
  const all = await listAllCalendars(buddi.db);
  const mine = all.filter((c) => c.accountId === account.id);
  const ids = new Set(all.map((c) => c.id));
  const linkedNames = new Set(all.filter((c) => c.linked).map((c) => c.name.toLowerCase()));
  let added = 0;
  let linked = 0;
  for (const cal of found.filter((c) => c.events)) {
    const known = mine.find((c) => c.url === cal.url);
    if (known) {
      await buddi.db.query(`update calendar.calendar set color = $2, can_write = $3, writable = writable and coalesce($3, true) where id = $1`, [
        known.id, cal.color, cal.writable,
      ]);
      continue;
    }
    const name = freeName(cal.name, account.label, linkedNames);
    const id = freeId(name, ids);
    ids.add(id);
    linkedNames.add(name.toLowerCase());
    await buddi.db.query(
      `insert into calendar.calendar (id, name, provider, host, secret_name, account_id, url, color, linked, writable, can_write)
       values ($1, $2, $3, $4, null, $5, $6, $7, true, false, $8)`,
      [id, name, account.label, new URL(cal.url).hostname, account.id, cal.url, cal.color, cal.writable],
    );
    added++;
    linked++;
  }
  const urls = new Set(found.filter((c) => c.events).map((c) => c.url));
  const gone = mine.filter((c) => !urls.has(c.url ?? ''));
  for (const c of gone) {
    await buddi.db.query(`delete from calendar.calendar where id = $1`, [c.id]);
    dropCache(c.id);
  }
  await buddi.db.query(`update calendar.account set last_found_at = $2, last_error = null where id = $1`, [account.id, buddi.clock.now()]);
  return { added, linked, gone: gone.length };
}

const plural = (n: number, one: string, many = `${one}s`): string => `${n} ${n === 1 ? one : many}`;

const linkInput = z
  .object({
    service: z.enum(['icloud', 'fastmail', 'other']),
    server: z.string().trim().max(500).optional(),
    username: z.string().trim().min(1).max(256),
    password: z.string().min(1).max(512),
  })
  .strict();

export const linkAccountTool: ToolDefinition<z.infer<typeof linkInput>, { note: string }> = {
  name: 'calendar.link_account',
  description: 'Sign in to a CalDAV account with an app password and link its calendars. The owner’s own.',
  tier: 'auto',
  ownerOnly: true,
  input: linkInput,
  async execute(input, ctx) {
    const buddi = ctx.buddi!;
    if (buddi.secrets === undefined) throw new Error('This buddi cannot keep secrets, so an app password cannot be stored.');
    if (/[:\r\n]/.test(input.username)) throw new Error('A sign-in name has no colon or line break in it.');
    const where = whereFor(input.service, input.server || undefined);
    const accounts = await listAccounts(buddi.db);
    const twin = accounts.find((a) => a.hostPattern === where.hostPattern && a.username.toLowerCase() === input.username.toLowerCase());
    if (twin) throw new Error(`${twin.label} as ${twin.username} is already linked. Use Find calendars again on it, or Sign out first.`);
    const taken = new Set(accounts.map((a) => a.id));
    const id = freeId(`${where.label}-${input.username}`, taken);
    const secretName = secretNameForAccount(where.label, input.username);
    await buddi.secrets.put(secretName, input.password, [
      { kind: 'http.basic', target: { plugin: 'calendar', host: where.hostPattern }, rule: 'pre-approved' },
    ]);
    const draft: AccountRow = {
      id, kind: 'caldav', service: input.service, label: where.label, server: where.server, hostPattern: where.hostPattern,
      username: input.username, secretName, homeUrl: null, lastFoundAt: null, lastError: null,
    };
    let found;
    try {
      found = await discover(davFor(buddi, draft), where.server);
    } catch (err) {
      await buddi.secrets.delete(secretName).catch(() => false);
      throw new Error(`buddi could not sign in to ${where.label}: ${err instanceof Error ? err.message : String(err)}`);
    }
    await buddi.db.query(
      `insert into calendar.account (id, kind, service, label, server, host_pattern, username, secret_name, home_url)
       values ($1, 'caldav', $2, $3, $4, $5, $6, $7, $8)`,
      [id, input.service, where.label, where.server, where.hostPattern, input.username, secretName, found.home],
    );
    const kept = await keepFound(buddi, { ...draft, homeUrl: found.home }, found.calendars);
    if (kept.added === 0) {
      return { note: `Signed in to ${where.label} as ${input.username}, but it holds no calendar with events yet. The password is kept as a secret.` };
    }
    return {
      note:
        `Signed in to ${where.label} as ${input.username}: linked ${plural(kept.added, 'calendar')} for reading. ` +
        'Allow changes on the ones agents may add events to, under From your accounts.',
    };
  },
};

const idInput = z.object({ id: z.string().min(1).max(80) }).strict();

async function accountCalendar(buddi: Host, id: string): Promise<CalendarRow> {
  const row = (await listAllCalendars(buddi.db)).find((c) => c.id === id);
  if (!row) throw new Error('That calendar is not here any more.');
  if (!row.accountId) throw new Error('That calendar is a private link: it can only be read.');
  return row;
}

const linkCalendarInput = z.object({ id: z.string().min(1).max(80), linked: z.boolean() }).strict();

export const linkCalendarTool: ToolDefinition<z.infer<typeof linkCalendarInput>, { note: string }> = {
  name: 'calendar.link_calendar',
  description: 'Link or unlink one calendar of a signed-in account. The owner’s own.',
  tier: 'auto',
  ownerOnly: true,
  input: linkCalendarInput,
  async execute(input, ctx) {
    const buddi = ctx.buddi!;
    const row = await accountCalendar(buddi, input.id);
    if (!input.linked) {
      await buddi.db.query(`update calendar.calendar set linked = false, writable = false where id = $1`, [row.id]);
      dropCache(row.id);
      return { note: `Unlinked ${row.name}. Agents no longer read it; it stays in your account.` };
    }
    const taken = new Set((await listAllCalendars(buddi.db)).filter((c) => c.linked && c.id !== row.id).map((c) => c.name.toLowerCase()));
    const name = freeName(row.name, row.provider, taken);
    await buddi.db.query(`update calendar.calendar set linked = true, name = $2 where id = $1`, [row.id, name]);
    return { note: `Linked ${name} for reading.` };
  },
};

const changesInput = z.object({ id: z.string().min(1).max(80), writable: z.boolean() }).strict();

export const allowChangesTool: ToolDefinition<z.infer<typeof changesInput>, { note: string }> = {
  name: 'calendar.allow_changes',
  description: 'Let agents add and change events in one linked account calendar, or make it read-only again. The owner’s own.',
  tier: 'auto',
  ownerOnly: true,
  input: changesInput,
  async execute(input, ctx) {
    const buddi = ctx.buddi!;
    const row = await accountCalendar(buddi, input.id);
    if (!input.writable) {
      await buddi.db.query(`update calendar.calendar set writable = false where id = $1`, [row.id]);
      return { note: `${row.name} is read-only for agents again.` };
    }
    if (!row.linked) throw new Error(`Link ${row.name} first.`);
    if (row.canWrite === false) throw new Error(`${row.provider} does not let this account change ${row.name} (it is shared with you read-only).`);
    await buddi.db.query(`update calendar.calendar set writable = true where id = $1`, [row.id]);
    return { note: `Agents may now add and change events in ${row.name}. You approve each change on a card first.` };
  },
};

export const findAgainTool: ToolDefinition<z.infer<typeof idInput>, { note: string }> = {
  name: 'calendar.find_again',
  description: 'Look for new, renamed or removed calendars in a signed-in account. The owner’s own.',
  tier: 'auto',
  ownerOnly: true,
  input: idInput,
  async execute(input, ctx) {
    const buddi = ctx.buddi!;
    const account = await accountOf(buddi.db, input.id);
    if (!account) throw new Error('That account is not linked any more.');
    let found;
    try {
      found = await discover(davFor(buddi, account), account.server);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      await buddi.db.query(`update calendar.account set last_error = $2 where id = $1`, [account.id, message.slice(0, 300)]);
      throw new Error(`buddi could not read ${account.label}: ${message}`);
    }
    const kept = await keepFound(buddi, account, found.calendars);
    const parts = [kept.added > 0 ? `linked ${plural(kept.added, 'new calendar')}` : '', kept.gone > 0 ? `dropped ${plural(kept.gone, 'calendar')} it no longer has` : ''].filter(Boolean);
    return { note: parts.length > 0 ? `${account.label}: ${parts.join(', ')}.` : `${account.label}: nothing new.` };
  },
};

export const signOutTool: ToolDefinition<z.infer<typeof idInput>, { note: string }> = {
  name: 'calendar.sign_out',
  description: 'Forget a CalDAV account: its password and its calendars here. The owner’s own.',
  tier: 'auto',
  ownerOnly: true,
  input: idInput,
  async execute(input, ctx) {
    const buddi = ctx.buddi!;
    const account = await accountOf(buddi.db, input.id);
    if (!account) throw new Error('That account is not linked any more.');
    const calendars = (await listAllCalendars(buddi.db)).filter((c) => c.accountId === account.id);
    await buddi.secrets?.delete(account.secretName).catch(() => false);
    await buddi.db.query(`delete from calendar.account where id = $1`, [account.id]);
    for (const c of calendars) dropCache(c.id);
    return { note: `Signed out of ${account.label} (${account.username}) and forgot its password. Your calendars there are untouched.` };
  },
};

export const accountTools = [linkAccountTool, linkCalendarTool, allowChangesTool, findAgainTool, signOutTool];

