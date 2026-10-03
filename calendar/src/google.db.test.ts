/**
 * Google accounts end to end, on a real Postgres with core migrated, core's
 * own `http` area in front of a fake Google Calendar API, and a fake sign-in
 * service in core's place (the real one is buddi's, tested there):
 *
 *  - Sign in with Google: the consent link, Finish refusing while Google has
 *    not answered, the loopback answer or a pasted address, then the account
 *    named by its address, its writable calendars linked, the tokens kept by
 *    core as "Calendar sign-in: Google <address>" bound to `http.bearer` —
 *    never in the plugin's rows.
 *  - Reads through `events.list` into the same tools, a series' occurrences
 *    under one id; a token Google stopped taking refreshed once and sent again.
 *  - Writes as approvals: insert under an id from what the event is (409
 *    refused, not doubled), patch and delete with `If-Match`, a change made in
 *    Google meanwhile refused in words; a series only whole; invitees left alone.
 *  - A sign-in Google refuses: the account says sign in again, one message to
 *    the owner, the page warns, writes refuse in words, the readiness note —
 *    and signing in again keeps every link.
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
import { fakeGoogle, type FakeGoogle } from './testing/fake-google.js';

const databaseUrl = await testDatabaseUrl();
const suite = databaseUrl ? describe : describe.skip;
const TEST_DB = `buddi_calendar_google_${process.pid}`;
const TZ = 'America/New_York';
const SAM = 'sam@gmail.com';

suite('calendar over Google (postgres)', () => {
  let admin: Pool;
  let pool: Pool;
  let google: FakeGoogle;
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
  const readiness = () => manifest.setup!.produce(ctx());
  const ask = async (name: string, args: unknown) =>
    (await registry.invoke(name, args, facts())) as { ok: false; reason: string; actionId?: string; preview?: string; message: string } | { ok: true; output: any };
  const approve = async (actionId: string) => {
    expect((await decideApproval(pool, { actionId, decision: 'approved', by: 'owner', via: 'web', now })).ok).toBe(true);
    return executeApproved(pool, { actionId, registry, ctx: facts(), worker: 'test', now });
  };
  const secretsKept = async () =>
    (await pool.query(`select s.name, b.kind, b.target from core.secrets s left join core.secret_bindings b on b.secret_id = s.id order by s.name`)).rows.map(
      (r: { name: string; kind: string; target: unknown }) => [r.name, r.kind, r.target],
    );
  const writes = () => google.state.requests.filter((r) => r.method !== 'GET');

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
    google = fakeGoogle({
      calendars: [
        { id: SAM, summary: SAM, backgroundColor: '#039BE5', accessRole: 'owner', primary: true },
        { id: 'family123@group.calendar.google.com', summary: 'Family', backgroundColor: '#7986cb', accessRole: 'writer' },
        { id: 'en.usa#holiday@group.v.calendar.google.com', summary: 'Holidays in United States', backgroundColor: '#16a765', accessRole: 'reader' },
      ],
    });
    resetPluginHost();
    configurePluginHost({ vault: createMemoryVault(), httpTransport: google.transport as never, signIns: google.service as never });
    await pool.query('delete from calendar.google_sign_in');
    await pool.query('delete from calendar.calendar');
    await pool.query('delete from calendar.account');
    await pool.query(`delete from core.secret_bindings`).catch(() => {});
    await pool.query(`delete from core.secrets`).catch(() => {});
    await pool.query(`delete from core.owner_notifications`).catch(() => {});
  });

  /** The whole sign-in, Google answering on the loopback port. */
  const signIn = async (account?: string) => {
    await owner('calendar.google_sign_in', account ? { account } : {});
    const { googleSignIn } = await settings();
    await google.answer(googleSignIn.id);
    return owner('calendar.google_finish', { id: googleSignIn.id });
  };

  it('signs in with Google: the consent link, Finish once Google answered, the account named by its address, the tokens core’s alone', async () => {
    const before = await settings();
    expect(before).toMatchObject({ googleAvailable: true, hasGoogleSignIn: false });
    const started = await owner('calendar.google_sign_in', {});
    expect(started.note).toBe('Continue on Google’s page, then come back here and press Finish signing in.');
    const page = await settings();
    expect(page).toMatchObject({ googleAvailable: false, hasGoogleSignIn: true, googleSignIn: { id: 'signin-1', url: expect.stringMatching(/^https:\/\/accounts\.google\.com\//) } });

    // Finish before Google answered says what to do; nothing is kept.
    await expect(owner('calendar.google_finish', { id: 'signin-1' })).rejects.toThrow(/Google has not sent buddi back yet.*paste it here/);
    await google.answer('signin-1');
    const done = await owner('calendar.google_finish', { id: 'signin-1' });
    expect(done.note).toBe(`Signed in to Google as ${SAM}: 3 calendars found, 2 linked for reading. Link others and allow changes under From your accounts.`);

    expect(await secretsKept()).toEqual([[`Calendar sign-in: Google ${SAM}`, 'http.bearer', { plugin: 'calendar', host: 'www.googleapis.com' }]]);
    const { rows } = await pool.query('select * from calendar.account');
    expect(rows).toEqual([expect.objectContaining({ kind: 'google', label: 'Google', username: SAM, host_pattern: 'www.googleapis.com', needs_sign_in: false })]);
    expect(JSON.stringify(rows)).not.toMatch(/ya29|1\/\/refresh/);
    // Every request carried the token core inserted, never one the plugin named.
    for (const r of google.state.requests) expect(r.headers.authorization).toMatch(/^Bearer ya29\.token-\d+$/);

    const after = await settings();
    expect(after).toMatchObject({ hasGoogleSignIn: false, googleAvailable: true, hasSignedOut: false });
    expect(after.calendars.map((c: any) => [c.name, c.color, c.provider])).toEqual([
      [SAM, '#039be5', `Google · ${SAM}`],
      ['Family', '#7986cb', `Google · ${SAM}`],
    ]);
    expect(after.found.map((c: any) => [c.name, c.linked, c.canAllow])).toEqual([
      [SAM, true, true],
      ['Family', true, true],
      ['Holidays in United States', false, false],
    ]);
    expect(after.accounts).toEqual([expect.objectContaining({ label: 'Google', username: SAM, calendars: '3 calendars · 2 linked', needsSignIn: false })]);
    // A reader's calendar can be linked but never allowed changes.
    await owner('calendar.link_calendar', { id: (after.found[2] as { id: string }).id, linked: true });
    await expect(owner('calendar.allow_changes', { id: (after.found[2] as { id: string }).id, writable: true })).rejects.toThrow(/does not let this account change/);
  });

  it('takes the address pasted from another computer, and drops a sign-in on Cancel', async () => {
    await owner('calendar.google_sign_in', {});
    await expect(owner('calendar.google_finish', { id: 'signin-1', pasted: 'http://127.0.0.1:50123/?state=signin-9&code=x' })).rejects.toThrow(/another sign-in/);
    const done = await owner('calendar.google_finish', { id: 'signin-1', pasted: 'http://127.0.0.1:50123/?state=signin-1&code=4/0Ab' });
    expect(done.note).toMatch(/^Signed in to Google as sam@gmail\.com/);
    expect(google.state.finished.map((f) => f.id)).toEqual(['signin-1', 'signin-1']);

    await owner('calendar.google_sign_in', {});
    expect((await settings()).hasGoogleSignIn).toBe(true);
    expect((await owner('calendar.google_cancel', { id: 'signin-2' })).note).toBe('Stopped signing in to Google.');
    expect((await settings()).hasGoogleSignIn).toBe(false);
  });

  it('reads Google calendars into the same tools, a series under one id, and refreshes a token Google stopped taking, once', async () => {
    await signIn();
    google.put(SAM, { id: 'lunch1', summary: 'Team lunch', location: 'Café Lou', start: { dateTime: '2026-10-05T14:00:00-04:00', timeZone: TZ }, end: { dateTime: '2026-10-05T15:00:00-04:00', timeZone: TZ } });
    google.put(SAM, { id: 'weekly1', summary: 'Weekly 1:1', start: { dateTime: '2026-09-28T16:00:00-04:00', timeZone: TZ }, end: { dateTime: '2026-09-28T16:30:00-04:00', timeZone: TZ }, recurrence: ['RRULE:FREQ=WEEKLY'] });
    google.put('family123@group.calendar.google.com', { id: 'trip', summary: 'School trip', start: { date: '2026-10-05' }, end: { date: '2026-10-06' } });
    const today = await read('calendar.today');
    expect(today.events).toEqual(['all day: School trip (Family)', `14:00–15:00 Team lunch (${SAM}, Café Lou)`, `16:00–16:30 Weekly 1:1 (${SAM})`]);
    const list = google.state.requests.find((r) => r.method === 'GET' && r.url.pathname.endsWith('/events'))!;
    expect(list.url.searchParams.get('singleEvents')).toBe('true');
    expect(list.url.searchParams.get('timeZone')).toBe(TZ);
    expect(today.forAgent).toBeUndefined();

    const samId = (await settings()).found[0].id as string;
    await owner('calendar.allow_changes', { id: samId, writable: true });
    dropCache();
    // The access token ran out at Google: core refreshes it once and sends again.
    google.expireToken();
    const again = await read('calendar.upcoming', { days: 14 });
    expect(google.state.refreshes).toBe(1);
    expect(again.problems).toBeUndefined();
    expect(again.forAgent.changeable.map((c: { id: string }) => c.id)).toEqual([`${samId}/lunch1`, `${samId}/weekly1`]);
    expect(again.forAgent.changeable[1].event).toMatch(/Weekly 1:1.*\(repeats\)$/);
  });

  it('adds an event on approval under an id from what it is, refused rather than doubled the second time', async () => {
    await signIn();
    const samId = (await settings()).found[0].id as string;
    await owner('calendar.allow_changes', { id: samId, writable: true });
    const input = { calendar: SAM, title: 'Dentist', start: '2026-11-02T09:00', duration: 45, location: '12 Main St', notes: 'Bring the X-rays' };
    const asked = (await ask('calendar.create_event', input)) as { actionId: string; preview: string };
    expect(asked.preview).toBe(`Add to ${SAM} (Google)\n“Dentist”\nMon 2 Nov, 09:00–09:45\nWhere: 12 Main St\nNotes: Bring the X-rays`);
    expect(writes()).toHaveLength(0);
    const executed = await approve(asked.actionId);
    expect((executed as { result: { note: string } }).result.note).toBe('Added “Dentist” to sam@gmail.com: Mon 2 Nov, 09:00–09:45.');
    const insert = writes()[0]!;
    expect(insert.method).toBe('POST');
    expect(insert.url.searchParams.get('sendUpdates')).toBe('none');
    const body = JSON.parse(insert.body);
    expect(body).toEqual({
      id: expect.stringMatching(/^buddi[0-9a-f]{32}$/),
      summary: 'Dentist',
      location: '12 Main St',
      description: 'Bring the X-rays',
      start: { dateTime: '2026-11-02T09:00:00', timeZone: TZ },
      end: { dateTime: '2026-11-02T09:45:00', timeZone: TZ },
    });
    expect(body.attendees).toBeUndefined();

    const twice = (await ask('calendar.create_event', input)) as { actionId: string };
    expect(((await approve(twice.actionId)) as { message: string }).message).toMatch(/“Dentist” is already in sam@gmail\.com at that time: buddi added nothing/);
    expect(google.state.events.get(SAM)).toHaveLength(1);

    const allDay = (await ask('calendar.create_event', { calendar: SAM, title: 'Off', start: '2026-11-05', end: '2026-11-06', allDay: true })) as { actionId: string };
    await approve(allDay.actionId);
    expect(JSON.parse(writes().at(-1)!.body)).toMatchObject({ start: { date: '2026-11-05' }, end: { date: '2026-11-07' } });
  });

  it('changes an event with If-Match on the version the card showed, and refuses one changed in Google meanwhile', async () => {
    await signIn();
    const samId = (await settings()).found[0].id as string;
    await owner('calendar.allow_changes', { id: samId, writable: true });
    google.put(SAM, { id: 'lunch1', summary: 'Team lunch', location: 'Café Lou', start: { dateTime: '2026-10-09T12:30:00-04:00', timeZone: TZ }, end: { dateTime: '2026-10-09T13:30:00-04:00', timeZone: TZ } });
    const etag = google.state.events.get(SAM)![0]!.etag;
    const asked = (await ask('calendar.update_event', { id: `${samId}/lunch1`, start: '2026-10-09T13:00', location: '' })) as { actionId: string; preview: string };
    expect(asked.preview).toBe(`Change “Team lunch” on ${SAM} (Google)\nWhen:  Fri 9 Oct, 12:30–13:30  →  Fri 9 Oct, 13:00–14:00\nWhere: Café Lou  →  (none)`);
    expect(await approve(asked.actionId)).toMatchObject({ ok: true });
    const patch = writes().at(-1)!;
    expect(patch.method).toBe('PATCH');
    expect(patch.headers['if-match']).toBe(etag);
    expect(JSON.parse(patch.body)).toEqual({ location: '', start: { dateTime: '2026-10-09T13:00:00', timeZone: TZ }, end: { dateTime: '2026-10-09T14:00:00', timeZone: TZ } });

    // A change landing in Google between the card and the write: If-Match refuses it, in words.
    const second = (await ask('calendar.update_event', { id: `${samId}/lunch1`, title: 'Team lunch (all hands)' })) as { actionId: string };
    const { rows: [card] } = await pool.query('select envelope from core.actions where id = $1', [second.actionId]);
    google.put(SAM, { ...google.state.events.get(SAM)![0]!, summary: 'Lunch moved by Sam' });
    await expect(tool('calendar.update_event').execute({ id: `${samId}/lunch1`, title: 'Team lunch (all hands)' }, { ...ctx(), approvedEffect: { envelope: card.envelope } })).rejects.toThrow(
      /“Team lunch” changed in sam@gmail\.com since you were asked, so buddi changed nothing/,
    );
    expect(google.state.events.get(SAM)![0]!.summary).toBe('Lunch moved by Sam');
  });

  it('changes and cancels a series only whole, and leaves events with invitees alone', async () => {
    await signIn();
    const samId = (await settings()).found[0].id as string;
    await owner('calendar.allow_changes', { id: samId, writable: true });
    google.put(SAM, { id: 'weekly1', summary: 'Weekly 1:1', start: { dateTime: '2026-09-29T10:00:00-04:00', timeZone: TZ }, end: { dateTime: '2026-09-29T10:30:00-04:00', timeZone: TZ }, recurrence: ['RRULE:FREQ=WEEKLY'] });
    google.put(SAM, { id: 'invited', summary: 'Board', start: { dateTime: '2026-10-07T10:00:00-04:00', timeZone: TZ }, end: { dateTime: '2026-10-07T11:00:00-04:00', timeZone: TZ }, attendees: [{ email: SAM, self: true }, { email: 'ana@example.com' }] });

    const moved = (await ask('calendar.update_event', { id: `${samId}/weekly1`, start: '2026-10-06T11:00' })) as { actionId: string; preview: string };
    expect(moved.preview).toBe(`Change “Weekly 1:1” on ${SAM} (Google)\nRepeats weekly: the whole series changes.\nWhen:  Tue 29 Sep, 10:00–10:30  →  Tue 29 Sep, 11:00–11:30`);
    expect(await approve(moved.actionId)).toMatchObject({ ok: true });
    expect(google.state.events.get(SAM)!.find((e) => e.id === 'weekly1')!.start).toEqual({ dateTime: '2026-09-29T11:00:00', timeZone: TZ });

    expect(((await ask('calendar.cancel_event', { id: `${samId}/weekly1` })) as { message: string }).message).toMatch(/series: true/);
    const series = (await ask('calendar.cancel_event', { id: `${samId}/weekly1`, series: true })) as { actionId: string };
    const deleted = await approve(series.actionId);
    expect((deleted as { result: { note: string } }).result.note).toBe('Cancelled “Weekly 1:1” in sam@gmail.com, every occurrence.');
    expect(writes().at(-1)).toMatchObject({ method: 'DELETE', headers: expect.objectContaining({ 'if-match': expect.stringMatching(/^"\d+"$/) }) });
    expect(google.state.events.get(SAM)!.some((e) => e.id === 'weekly1')).toBe(false);

    expect(((await ask('calendar.cancel_event', { id: `${samId}/invited` })) as { message: string }).message).toMatch(/has invitees/);
    expect(((await ask('calendar.update_event', { id: `${samId}/invited`, title: 'x' })) as { message: string }).message).toMatch(/has invitees/);
  });

  it('when Google stops accepting the sign-in: sign in again, one message, a warning, words on a write, the note — and signing in again keeps the links', async () => {
    await signIn();
    const samId = (await settings()).found[0].id as string;
    await owner('calendar.allow_changes', { id: samId, writable: true });
    await owner('calendar.link_calendar', { id: (await settings()).found[1].id, linked: false });
    google.put(SAM, { id: 'lunch1', summary: 'Team lunch', start: { dateTime: '2026-10-05T14:00:00-04:00', timeZone: TZ }, end: { dateTime: '2026-10-05T15:00:00-04:00', timeZone: TZ } });
    dropCache();
    google.revoke();

    const today = await read('calendar.today');
    expect(today.problems).toEqual([`${SAM} could not be read: Google no longer accepts buddi’s sign-in. Sign in to Google again on Settings → Calendar.`]);
    await read('calendar.upcoming');
    const { rows: messages } = await pool.query(`select title, action, link, plugin_id from core.owner_notifications`);
    expect(messages).toEqual([{ title: `Google Calendar: sign in again (${SAM})`, action: 'Sign in to Google again', link: '#/settings/p.calendar.settings', plugin_id: 'calendar' }]);

    const page = await settings();
    expect(page.hasSignedOut).toBe(true);
    expect(page.signedOut).toMatch(/Google stopped accepting buddi’s sign-in to sam@gmail\.com.*your calendar links stay as they are/);
    expect(page.accounts[0]).toMatchObject({ needsSignIn: true, canFind: false, state: [{ value: 'sign in again', tone: 'danger' }] });
    expect(await readiness()).toEqual({ ready: false, note: `Sign in to Google again (${SAM}).`, page: 'settings' });

    const refused = await ask('calendar.create_event', { calendar: SAM, title: 'Dentist', start: '2026-11-02T09:00' });
    expect((refused as { message: string }).message).toMatch(/Google no longer accepts buddi’s sign-in to sam@gmail\.com, so buddi changed nothing/);

    // Signing in again: the same account, the same links and permissions, the warning gone.
    google.state.revoked = false;
    const again = await signIn(page.accounts[0].id);
    expect(again.note).toBe(`Signed in to Google again as ${SAM}: your calendar links are as they were.`);
    const after = await settings();
    expect(after.hasSignedOut).toBe(false);
    expect(after.found.map((c: any) => [c.name, c.linked, c.writable])).toEqual([
      [SAM, true, true],
      ['Family', false, false],
      ['Holidays in United States', false, false],
    ]);
    expect(await secretsKept()).toEqual([[`Calendar sign-in: Google ${SAM}`, 'http.bearer', { plugin: 'calendar', host: 'www.googleapis.com' }]]);
    expect(await readiness()).toEqual({ ready: true });
    dropCache();
    expect((await read('calendar.today')).events).toEqual([`14:00–15:00 Team lunch`]);
  });

  it('signs out of Google: the sign-in and its calendars go here, and it says where to remove buddi at Google', async () => {
    await signIn();
    const { note } = await owner('calendar.sign_out', { id: (await settings()).accounts[0].id });
    expect(note).toMatch(/^Signed out of Google \(sam@gmail\.com\): buddi forgot its sign-in\..*myaccount\.google\.com\/connections/);
    expect(await secretsKept()).toEqual([]);
    expect((await pool.query('select count(*)::int as n from calendar.calendar')).rows[0].n).toBe(0);
  });
});
