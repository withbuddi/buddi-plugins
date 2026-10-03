/**
 * CalDAV accounts end to end, on a real Postgres with core migrated and core's
 * own `http` area in front of a fake CalDAV server:
 *
 *  - Link with an app password: the password becomes an owner secret bound to
 *    `http.basic` for this plugin and `*.icloud.com`; core signs every request
 *    in, the plugin never holds it; discovery links the event calendars for
 *    reading, with their colours, and leaves a reminders-only one out.
 *  - Reads go through REPORT into the same cache and tools as a private link.
 *  - Writes are approvals: registry.invoke records the card (calendar, title,
 *    when in the owner's format; before → after for a change), the owner
 *    approves, the executor writes exactly what the card was made from —
 *    PUT with If-None-Match for a new event, If-Match for a change, and a
 *    clear refusal when the event changed in the calendar meanwhile.
 *  - A series is changed and cancelled whole, and cancelling one asks so.
 *
 * Skipped without `DATABASE_URL`.
 */
import type { Pool } from 'pg';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import {
  configurePluginHost, createMemoryVault, createPluginHost, createPool, decideApproval, executeApproved, hostBindingOf, resetPluginHost,
  runMigrations, testDatabaseUrl, ToolRegistry, type CoreToolContext,
} from '@buddi/core/testing';
import type { ToolDefinition } from '@buddi/core/plugin';
import { manifest } from './index.js';
import { dropCache } from './store.js';
import { fakeCaldav, type FakeCaldav } from './testing/fake-caldav.js';
import { buildEvent, unfold } from './icalwrite.js';

const databaseUrl = await testDatabaseUrl();
const suite = databaseUrl ? describe : describe.skip;
const TEST_DB = `buddi_calendar_caldav_${process.pid}`;
const PASSWORD = 'abcd-efgh-ijkl-mnop';
const TZ = 'America/New_York';

const SERIES = (uid: string, extra = '') =>
  [
    'BEGIN:VCALENDAR', 'VERSION:2.0', 'PRODID:-//Apple Inc.//iOS 26//EN',
    'BEGIN:VEVENT', `UID:${uid}`, 'DTSTAMP:20260901T000000Z', 'DTSTART;TZID=America/New_York:20260929T100000',
    'DTEND;TZID=America/New_York:20260929T103000', 'RRULE:FREQ=WEEKLY', 'SUMMARY:Weekly 1:1', extra,
    'END:VEVENT', 'END:VCALENDAR', '',
  ].filter(Boolean).join('\r\n');

suite('calendar over CalDAV (postgres)', () => {
  let admin: Pool;
  let pool: Pool;
  let server: FakeCaldav;
  let now = new Date('2026-10-05T13:00:00Z'); // Mon 5 Oct, 09:00 in New York
  const registry = new ToolRegistry();
  registry.register(manifest);

  const facts = (over: Partial<CoreToolContext> = {}): CoreToolContext => ({ db: pool, ownerId: 'owner', now: () => now, timezone: TZ, agentId: 'tempo', ...over });
  const ctx = (over: Partial<CoreToolContext> = {}): CoreToolContext => {
    const f = facts(over);
    return { ...f, buddi: createPluginHost(hostBindingOf(manifest), f) };
  };
  const tool = (name: string) => manifest.tools.find((t) => t.name === name)! as ToolDefinition<any, any>;
  const owner = (name: string, input: unknown) => tool(name).execute(input as never, ctx({ agentId: 'owner' }));
  const read = (name: string, input: unknown = {}) => tool(name).execute(input as never, ctx());
  const settings = async () => manifest.queries!.find((q) => q.name === 'settings')!.produce({}, ctx({ agentId: 'owner' })) as Promise<any>;

  /** An agent's call as the runtime makes it: recorded, waiting for the owner. */
  const ask = async (name: string, args: unknown) => {
    const result = await registry.invoke(name, args, facts());
    return result as { ok: false; reason: string; actionId?: string; preview?: string; message: string } | { ok: true; output: any };
  };
  /** The owner says yes; the executor runs what the card was made from. */
  const approve = async (actionId: string) => {
    expect((await decideApproval(pool, { actionId, decision: 'approved', by: 'owner', via: 'web', now })).ok).toBe(true);
    return executeApproved(pool, { actionId, registry, ctx: facts(), worker: 'test', now });
  };

  beforeAll(async () => {
    admin = createPool(databaseUrl as string);
    await admin.query(`drop database if exists ${TEST_DB}`);
    await admin.query(`create database ${TEST_DB}`);
    const url = new URL(databaseUrl as string);
    url.pathname = `/${TEST_DB}`;
    pool = createPool(url.toString());
    await runMigrations(pool, [manifest]);
  });

  afterAll(async () => {
    resetPluginHost();
    await pool?.end();
    await admin?.query(`drop database if exists ${TEST_DB}`);
    await admin?.end();
  });

  beforeEach(async () => {
    now = new Date('2026-10-05T13:00:00Z');
    dropCache();
    server = fakeCaldav({
      host: 'caldav.icloud.com',
      homeHost: 'p52-caldav.icloud.com',
      user: 'sam@icloud.com',
      password: PASSWORD,
      calendars: [
        { path: '/123/calendars/work/', name: 'Work', color: '#1F6FEBFF' },
        { path: '/123/calendars/family/', name: 'Family', color: '#E5534B' },
        { path: '/123/calendars/tasks/', name: 'Reminders', components: ['VTODO'] },
      ],
    });
    resetPluginHost();
    configurePluginHost({ vault: createMemoryVault(), httpTransport: server.transport as never });
    await pool.query('delete from calendar.calendar');
    await pool.query('delete from calendar.account');
    await pool.query(`delete from core.secret_bindings`).catch(() => {});
    await pool.query(`delete from core.secrets`).catch(() => {});
  });

  /** The secrets core keeps, with where each may go: names and bindings, never values. */
  const secretsKept = async () =>
    (await pool.query(`select s.name, b.kind, b.target from core.secrets s left join core.secret_bindings b on b.secret_id = s.id order by s.name`)).rows.map(
      (r: { name: string; kind: string; target: unknown }) => [r.name, r.kind, r.target],
    );

  const link = () => owner('calendar.link_account', { service: 'icloud', username: 'sam@icloud.com', password: PASSWORD });

  it('links an account with an app password the plugin never holds, and its event calendars with their colours', async () => {
    const done = await link();
    expect(done.note).toBe('Signed in to iCloud as sam@icloud.com: linked 2 calendars for reading. Allow changes on the ones agents may add events to, under From your accounts.');
    // Core built the sign-in from the vault; the plugin's requests named only the user.
    const auth = `Basic ${Buffer.from(`sam@icloud.com:${PASSWORD}`).toString('base64')}`;
    expect(server.requests.length).toBeGreaterThan(0);
    for (const r of server.requests) expect(r.headers.authorization).toBe(auth);
    expect(await secretsKept()).toEqual([['Calendar sign-in: iCloud sam@icloud.com', 'http.basic', { plugin: 'calendar', host: '*.icloud.com' }]]);
    const { rows } = await pool.query('select * from calendar.account');
    expect(JSON.stringify(rows)).not.toContain(PASSWORD);

    const page = await settings();
    expect(page.hasCalendars).toBe(true);
    expect(page.calendars.map((c: any) => [c.name, c.color, c.groupLabel, c.groupAside, c.access, c.kind, c.readOnly])).toEqual([
      ['Work', '#1f6feb', 'iCloud · sam@icloud.com', '2 calendars · 2 linked', 'read', 'account', false],
      ['Family', '#e5534b', 'iCloud · sam@icloud.com', '2 calendars · 2 linked', 'read', 'account', false],
    ]);
    expect(page.accounts).toEqual([expect.objectContaining({ label: 'iCloud', username: 'sam@icloud.com' })]);

    // The same account twice is said, not duplicated.
    await expect(link()).rejects.toThrow(/iCloud as sam@icloud.com is already linked/);
  });

  it('forgets the password when the sign-in is turned down, and says why', async () => {
    await expect(owner('calendar.link_account', { service: 'icloud', username: 'sam@icloud.com', password: 'wrong' })).rejects.toThrow(
      /buddi could not sign in to iCloud: the server turned the sign-in down/,
    );
    expect(await secretsKept()).toEqual([]);
    expect((await pool.query('select count(*)::int as n from calendar.account')).rows[0].n).toBe(0);
  });

  it('reads linked calendars over REPORT into the same tools, with ids only where agents may change events', async () => {
    await link();
    const at = new Date('2026-10-05T18:00:00Z');
    server.put('/123/calendars/work/lunch.ics', buildEvent({ uid: 'lunch', title: 'Team lunch', time: { allDay: false, start: at, end: new Date(at.getTime() + 3_600_000), tz: TZ }, location: 'Café Lou', now }));
    server.put('/123/calendars/family/dinner.ics', buildEvent({ uid: 'dinner', title: 'Dinner', time: { allDay: false, start: new Date('2026-10-05T23:00:00Z'), end: new Date('2026-10-06T00:30:00Z'), tz: TZ }, now }));
    const today = await read('calendar.today');
    expect(today.events).toEqual(['14:00–15:00 Team lunch (Work, Café Lou)', '19:00–20:30 Dinner (Family)']);
    expect(today.forAgent).toBeUndefined();
    const report = server.requests.find((r) => r.method === 'REPORT')!;
    expect(report.headers.depth).toBe('1');
    expect(report.body).toContain('<c:comp-filter name="VEVENT"><c:time-range start="');

    // Read and change: the row's third choice.
    expect((await owner('calendar.set_access', { id: 'work', access: 'change' })).note).toBe('Agents read and change Work. Each change asks you first.');
    expect((await settings()).calendars[0]).toMatchObject({ access: 'change', line: expect.stringMatching(/ · changes ask you first$/) });
    // Agents see which calendars they may write to, and the one to use without asking.
    expect(await read('calendar.calendars')).toEqual({
      calendars: [
        { name: 'Work', account: 'iCloud · sam@icloud.com', colour: '#1f6feb', mayWrite: true, default: true },
        { name: 'Family', account: 'iCloud · sam@icloud.com', colour: '#e5534b', mayWrite: false, default: false },
      ],
    });
    dropCache();
    const again = await read('calendar.today');
    expect(again.forAgent.changeable).toEqual([{ id: 'work/lunch', event: 'Mon 5 Oct 14:00–15:00 Team lunch (Work, Café Lou)' }]);
    // A private link's calendar is never offered for changes.
    await expect(owner('calendar.allow_changes', { id: 'nope', writable: true })).rejects.toThrow(/not here any more/);

    // Unlinked, agents stop reading it; the account still lists it.
    expect((await owner('calendar.set_access', { id: 'family', access: 'off' })).note).toBe('Agents no longer see Family.');
    expect((await read('calendar.today')).events).toEqual(['14:00–15:00 Team lunch (Café Lou)']);
    expect((await settings()).calendars.find((c: any) => c.id === 'family')).toMatchObject({ access: 'off', line: 'Agents don’t see it', groupAside: '2 calendars · 1 linked' });
    // And back to Read; Read and change back to Read keeps it linked.
    expect((await owner('calendar.set_access', { id: 'family', access: 'read' })).note).toBe('Agents read Family.');
    await owner('calendar.set_access', { id: 'work', access: 'read' });
    expect((await settings()).calendars.map((c: any) => c.access)).toEqual(['read', 'read']);
    // A private link's calendar: only Read.
    await expect(owner('calendar.set_access', { id: 'nope', access: 'read' })).rejects.toThrow(/not here any more/);
  });

  it('adds an event only once the owner approves the card, in the owner’s zone with its VTIMEZONE', async () => {
    await link();
    await owner('calendar.allow_changes', { id: 'work', writable: true });
    const asked = await ask('calendar.create_event', { calendar: 'Work', title: 'Dentist', start: '2026-11-02T09:00', duration: 45, location: '12 Main St', notes: 'Bring the X-rays' });
    expect(asked).toMatchObject({ ok: false, reason: 'approval-required' });
    const { actionId, preview } = asked as { actionId: string; preview: string };
    // The Monday after the clocks go back: 09:00 is still 09:00 on the card and in the calendar.
    expect(preview).toBe('Add to Work (iCloud)\n“Dentist”\nMon 2 Nov, 09:00–09:45\nWhere: 12 Main St\nNotes: Bring the X-rays');
    expect(server.requests.some((r) => r.method === 'PUT')).toBe(false);

    const executed = await approve(actionId);
    expect(executed).toMatchObject({ ok: true });
    const put = server.requests.find((r) => r.method === 'PUT')!;
    expect(put.headers['if-none-match']).toBe('*');
    expect(put.url).toMatch(/^https:\/\/p52-caldav\.icloud\.com\/123\/calendars\/work\/[0-9a-f-]{36}%40withbuddi\.com\.ics$/);
    const lines = unfold(put.body);
    expect(lines).toContain('DTSTART;TZID=America/New_York:20261102T090000');
    expect(lines).toContain('DTEND;TZID=America/New_York:20261102T094500');
    expect(lines).toContain('BEGIN:VTIMEZONE');
    expect(lines.some((l) => l.startsWith('ATTENDEE') || l.startsWith('ORGANIZER'))).toBe(false);
    expect((executed as { result: { note: string } }).result.note).toBe('Added “Dentist” to Work: Mon 2 Nov, 09:00–09:45.');

    // The same event asked for again is the same object: refused, not doubled.
    const twice = (await ask('calendar.create_event', { calendar: 'Work', title: 'Dentist', start: '2026-11-02T09:00', duration: 45, location: '12 Main St', notes: 'Bring the X-rays' })) as { actionId: string };
    const again = await approve(twice.actionId);
    expect((again as { message: string }).message).toMatch(/“Dentist” is already in Work at that time: buddi added nothing/);
    expect(server.requests.filter((r) => r.method === 'PUT')).toHaveLength(2);
    expect([...server.objects.keys()].filter((k) => k.startsWith('/123/calendars/work/'))).toHaveLength(1);
  });

  it('refuses a calendar it may not write, a time the clocks skip, and a rejected card writes nothing', async () => {
    await link();
    const refused = await ask('calendar.create_event', { calendar: 'Family', title: 'Party', start: '2026-10-10T18:00' });
    expect(refused).toMatchObject({ ok: false });
    expect((refused as { message: string }).message).toMatch(/The owner has not allowed changes to Family\. No calendar allows changes yet/);
    await owner('calendar.allow_changes', { id: 'family', writable: true });
    const gap = await ask('calendar.create_event', { calendar: 'family', title: 'Early', start: '2027-03-14T02:30' });
    expect((gap as { message: string }).message).toMatch(/02:30 on 2027-03-14 does not exist in America\/New_York/);

    const asked = (await ask('calendar.create_event', { calendar: 'Family', title: 'Party', start: '2026-10-10T18:00', end: '2026-10-10T22:00' })) as { actionId: string };
    expect((await decideApproval(pool, { actionId: asked.actionId, decision: 'rejected', by: 'owner', via: 'web', now })).ok).toBe(true);
    expect(server.requests.some((r) => r.method === 'PUT')).toBe(false);
  });

  it('changes an event at the version the card showed, before → after, and refuses one changed meanwhile', async () => {
    await link();
    await owner('calendar.allow_changes', { id: 'work', writable: true });
    const at = new Date('2026-10-09T16:30:00Z'); // Fri 12:30 in New York
    server.put('/123/calendars/work/lunch.ics', buildEvent({ uid: 'lunch', title: 'Team lunch', time: { allDay: false, start: at, end: new Date(at.getTime() + 3_600_000), tz: TZ }, location: 'Café Lou', now }));
    await read('calendar.upcoming'); // the id comes from a read

    const asked = (await ask('calendar.update_event', { id: 'work/lunch', start: '2026-10-09T13:00', location: '' })) as { actionId: string; preview: string };
    expect(asked.preview).toBe('Change “Team lunch” on Work (iCloud)\nWhen:  Fri 9 Oct, 12:30–13:30  →  Fri 9 Oct, 13:00–14:00\nWhere: Café Lou  →  (none)');
    const executed = await approve(asked.actionId);
    expect(executed).toMatchObject({ ok: true });
    const put = server.requests.filter((r) => r.method === 'PUT').at(-1)!;
    expect(put.headers['if-match']).toBe('"v1"');
    const lines = unfold(server.objects.get('/123/calendars/work/lunch.ics')!.data);
    expect(lines).toContain('DTSTART;TZID=America/New_York:20261009T130000');
    expect(lines.some((l) => l.startsWith('LOCATION'))).toBe(false);
    expect(lines).toContain('SEQUENCE:1');

    // A card made, then the event moved on the owner's phone before they approved it.
    const second = (await ask('calendar.update_event', { id: 'work/lunch', title: 'Team lunch (all hands)' })) as { actionId: string };
    server.put('/123/calendars/work/lunch.ics', server.objects.get('/123/calendars/work/lunch.ics')!.data.replace('Team lunch', 'Lunch moved by Sam'));
    const stale = await approve(second.actionId);
    // Core sees the card no longer matches the event, and refuses before anything is sent.
    expect(stale).toMatchObject({ ok: false, reason: 'effect-changed' });
    expect(server.objects.get('/123/calendars/work/lunch.ics')!.data).toContain('Lunch moved by Sam');

    // And a change landing between that check and the write: If-Match refuses it, in words.
    const third = (await ask('calendar.update_event', { id: 'work/lunch', title: 'Lunch (all hands)' })) as { actionId: string };
    const { rows: [card] } = await pool.query('select envelope from core.actions where id = $1', [third.actionId]);
    server.put('/123/calendars/work/lunch.ics', server.objects.get('/123/calendars/work/lunch.ics')!.data.replace('Lunch moved by Sam', 'Lunch moved again'));
    await expect(tool('calendar.update_event').execute({ id: 'work/lunch', title: 'Lunch (all hands)' }, { ...ctx(), approvedEffect: { envelope: card.envelope } })).rejects.toThrow(
      /“Lunch moved by Sam” changed in Work since you were asked, so buddi changed nothing\. Ask again to see it as it is now\./,
    );
    expect(server.objects.get('/123/calendars/work/lunch.ics')!.data).toContain('Lunch moved again');

    expect(((await ask('calendar.update_event', { id: 'work/lunch', title: 'Lunch moved again' })) as { message: string }).message).toMatch(/Nothing to change/);
  });

  it('changes a series whole, cancels one only when asked for the series, and leaves events with invitees alone', async () => {
    await link();
    await owner('calendar.allow_changes', { id: 'work', writable: true });
    server.put('/123/calendars/work/weekly.ics', SERIES('weekly'));
    server.put('/123/calendars/work/invited.ics', SERIES('invited', 'ATTENDEE;CN=Ana:mailto:ana@example.com'));

    const moved = (await ask('calendar.update_event', { id: 'work/weekly', start: '2026-10-06T11:00' })) as { actionId: string; preview: string };
    // The day the model named is not the series' first: the time of day moves for every occurrence.
    expect(moved.preview).toBe('Change “Weekly 1:1” on Work (iCloud)\nRepeats weekly: the whole series changes.\nWhen:  Tue 29 Sep, 10:00–10:30  →  Tue 29 Sep, 11:00–11:30');
    expect(await approve(moved.actionId)).toMatchObject({ ok: true });
    expect(unfold(server.objects.get('/123/calendars/work/weekly.ics')!.data)).toContain('DTSTART;TZID=America/New_York:20260929T110000');

    const once = await ask('calendar.cancel_event', { id: 'work/weekly' });
    expect((once as { message: string }).message).toMatch(/repeats \(repeats weekly\)\. Cancelling it cancels every occurrence: call calendar\.cancel_event again with series: true/);
    const series = (await ask('calendar.cancel_event', { id: 'work/weekly', series: true })) as { actionId: string; preview: string };
    expect(series.preview).toBe('Cancel “Weekly 1:1” on Work (iCloud)\nRepeats weekly, from Tue 29 Sep, 11:00–11:30\nThe whole series: every occurrence goes.');
    const deleted = await approve(series.actionId);
    expect((deleted as { result: { note: string } }).result.note).toBe('Cancelled “Weekly 1:1” in Work, every occurrence.');
    expect(server.requests.filter((r) => r.method === 'DELETE').at(-1)!.headers['if-match']).toMatch(/^"v\d+"$/);
    expect(server.objects.has('/123/calendars/work/weekly.ics')).toBe(false);

    expect(((await ask('calendar.cancel_event', { id: 'work/invited', series: true })) as { message: string }).message).toMatch(/has invitees, and buddi does not cancel events others are invited to/);
    expect(((await ask('calendar.update_event', { id: 'work/invited', title: 'x' })) as { message: string }).message).toMatch(/has invitees/);
  });

  it('signs out: the password and its calendars go, the account’s calendars stay where they are', async () => {
    await link();
    const { note } = await owner('calendar.sign_out', { id: (await settings()).accounts[0].id });
    expect(note).toBe('Removed iCloud (sam@icloud.com): buddi forgot its password and its calendars. Nothing changed in iCloud.');
    expect(await secretsKept()).toEqual([]);
    expect((await pool.query('select count(*)::int as n from calendar.calendar')).rows[0].n).toBe(0);
    expect(await read('calendar.today')).toEqual({ linked: false, message: 'No calendar is linked yet. Add one on Settings → Calendar.' });
  });
});
