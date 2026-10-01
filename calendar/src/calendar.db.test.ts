/**
 * The whole path on a real Postgres with core migrated, through the host a
 * plugin is handed: the link typed on the page becomes an owner secret bound
 * to `http.url` for this plugin, the tools read it through core without ever
 * seeing it, the answers are in the owner's time, the cache holds ten
 * minutes, and removing forgets the link. The transport is a fake: no socket.
 * Skipped without `DATABASE_URL`.
 */
import { readFileSync } from 'node:fs';
import type { Pool } from 'pg';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import {
  configurePluginHost, createMemoryVault, createPluginHost, createPool, hostBindingOf, resetPluginHost, runMigrations, testDatabaseUrl,
  type CoreToolContext,
} from '@buddi/core/testing';
import type { ToolDefinition } from '@buddi/core/plugin';
import { manifest } from './index.js';
import { dropCache } from './store.js';
import { agendaQuery } from './agenda.js';

const databaseUrl = await testDatabaseUrl();
const suite = databaseUrl ? describe : describe.skip;
const TEST_DB = `buddi_calendar_test_${process.pid}`;
const LINK = 'https://calendar.google.com/calendar/ical/owner%40example.com/private-5f2c0e7d9a1b4c3d/basic.ics';
const ICS = readFileSync(new URL('./fixtures/google-work.ics', import.meta.url), 'utf8');

suite('calendar (postgres)', () => {
  let admin: Pool;
  let pool: Pool;
  let now = new Date('2026-09-28T12:00:00Z');
  let answer: { status: number; body: string } = { status: 200, body: ICS };
  const fetched: string[] = [];
  const transport = () => async (url: string) => {
    fetched.push(url);
    return {
      ok: answer.status < 400, status: answer.status, statusText: '', headers: { get: () => null },
      text: async () => answer.body, json: async () => ({}), arrayBuffer: async () => new ArrayBuffer(0),
    };
  };

  const ctx = (over: Partial<CoreToolContext> = {}): CoreToolContext => {
    const facts: CoreToolContext = { db: pool, ownerId: 'owner', now: () => now, timezone: 'America/New_York', agentId: 'planner', ...over };
    return { ...facts, buddi: createPluginHost(hostBindingOf(manifest), facts) };
  };
  const tool = (name: string) => manifest.tools.find((t) => t.name === name)! as ToolDefinition<any, any>;
  const run = (name: string, input: unknown, over: Partial<CoreToolContext> = {}) => tool(name).execute(input as never, ctx(over));
  const asOwner = { agentId: 'owner' };

  beforeAll(async () => {
    admin = createPool(databaseUrl as string);
    await admin.query(`drop database if exists ${TEST_DB}`);
    await admin.query(`create database ${TEST_DB}`);
    const url = new URL(databaseUrl as string);
    url.pathname = `/${TEST_DB}`;
    pool = createPool(url.toString());
    await runMigrations(pool, [manifest]);
    configurePluginHost({ vault: createMemoryVault(), httpTransport: transport as never });
  });

  afterAll(async () => {
    resetPluginHost();
    await pool?.end();
    await admin?.query(`drop database if exists ${TEST_DB}`);
    await admin?.end();
  });

  beforeEach(async () => {
    now = new Date('2026-09-28T12:00:00Z');
    answer = { status: 200, body: ICS };
    fetched.length = 0;
    dropCache();
    for (const { id } of (await pool.query('select id from calendar.calendar')).rows) {
      await run('calendar.remove', { id }, asOwner);
    }
  });

  it('says where to link one before any is', async () => {
    // Not linked is an answer, not a failure: the canvas draws it as one card linking to Settings.
    const notLinked = { linked: false, message: 'No calendar is linked yet. Add one on Settings → Calendar.' };
    expect(await run('calendar.today', {})).toEqual(notLinked);
    expect(await run('calendar.upcoming', {})).toEqual(notLinked);
    expect(await run('calendar.find', { query: 'dentist' })).toEqual(notLinked);
    expect(await run('calendar.free', { date: 'today' })).toEqual(notLinked);
    expect(await manifest.home![0]!.produce(ctx())).toBeNull();
    expect(await manifest.widgets![0]!.produce(ctx(), { size: 'medium' })).toEqual({ kind: 'text', icon: 'calendar', text: 'Link a calendar on Settings → Calendar to see your day here.' });
    expect(await agendaQuery.produce({}, ctx())).toEqual({
      linked: false, many: false, calendars: [], message: 'No calendar is linked yet. Add one on Settings → Calendar.', events: [], summary: [], problem: '',
    });
  });

  it('answers the Calendar page: the days it asks for, each event with its calendar, tone and place, filtered by calendar', async () => {
    await run('calendar.add', { name: 'Work', link: LINK }, asOwner);
    type Event = { id: string; title: string; start: string; end: string; allDay: boolean; calendar: string; tone: number; location: string };
    type Agenda = { linked: boolean; many: boolean; events: Event[]; summary: Array<{ text: string }> };
    const agenda = (await agendaQuery.produce({}, ctx())) as Agenda;
    expect(agenda).toMatchObject({ linked: true, many: false });
    // Today and the six days after it, when the page does not say.
    expect(agenda.events.filter((e) => e.start.startsWith('2026-09-28')).map((e) => [e.title, e.start, e.end, e.allDay, e.calendar, e.tone, e.location])).toEqual([
      ['Company offsite', '2026-09-28', '2026-09-29', true, 'Work', 0, ''],
      ['Team standup (moved)', '2026-09-28T15:00:00.000Z', '2026-09-28T15:30:00.000Z', false, 'Work', 0, 'Room 4'],
      ['Call with Paris office', '2026-09-28T18:00:00.000Z', '2026-09-28T19:00:00.000Z', false, 'Work', 0, ''],
      ['Dentist', '2026-09-28T19:00:00.000Z', '2026-09-28T20:00:00.000Z', false, 'Work', 0, '12 Main St'],
    ]);
    expect(agenda.events.find((e) => e.title === 'Trip to Boston')).toMatchObject({ start: '2026-10-01', end: '2026-10-03', allDay: true });
    expect(agenda.events.every((e) => e.start < '2026-10-05T04:00')).toBe(true);
    expect(new Set(agenda.events.map((e) => e.id)).size).toBe(agenda.events.length);
    expect(agenda.summary[0]!.text).toMatch(/^\d+ events over the next 7 days\.$/);
    // Nothing is a row no longer: the page draws "Nothing." on an empty day itself.
    expect(agenda.events.some((e) => e.title === 'Nothing.')).toBe(false);

    // The range the page asks for as the owner moves: a later week, and one the other way round.
    const later = (await agendaQuery.produce({ from: '2026-10-05', to: '2026-10-12' }, ctx())) as Agenda;
    expect(later.events.every((e) => e.start >= '2026-10-05' && e.start < '2026-10-12T04:00')).toBe(true);
    expect(later.events.filter((e) => e.title === 'Team standup').length).toBe(2);
    expect(later.summary[0]!.text).toBe('2 events from Mon 5 Oct to Sun 11 Oct.');
    const tuesday = (await agendaQuery.produce({ from: '2026-09-29', to: '2026-09-20' }, ctx())) as Agenda;
    expect(tuesday.events).toEqual([]);
    expect(tuesday.summary[0]!.text).toBe('No events from Tue 29 Sep to Tue 29 Sep.');
    await expect(agendaQuery.produce({ from: 'monday' }, ctx())).rejects.toThrow();

    await run('calendar.add', { name: 'Family', link: 'webcal://p12-caldav.icloud.com/published/2/MTIzNDU2Nzg5MTIzNDU2N' }, asOwner);
    const both = (await agendaQuery.produce({}, ctx())) as Agenda & { calendars: unknown };
    expect(both.many).toBe(true);
    expect(both.calendars).toEqual([{ id: 'work', name: 'Work' }, { id: 'family', name: 'Family' }]);
    // Each calendar wears its own tone: its place in the list.
    expect(new Set(both.events.map((e) => `${e.calendar}:${e.tone}`))).toEqual(new Set(['Work:0', 'Family:1']));
    const onlyFamily = (await agendaQuery.produce({ calendars: 'family' }, ctx())) as Agenda;
    expect(onlyFamily.events.every((e) => e.calendar === 'Family' && e.tone === 1)).toBe(true);
    const onlyWork = (await agendaQuery.produce({ calendars: 'work,nobody' }, ctx())) as Agenda;
    expect(onlyWork.events.every((e) => e.calendar === 'Work')).toBe(true);
    expect(onlyWork.events.length).toBeGreaterThan(0);
  });

  it('keeps the link as a secret the plugin fetches without holding it', async () => {
    await expect(run('calendar.add', { name: 'Work', link: LINK })).rejects.toThrow(/Only the owner/);
    expect(await run('calendar.add', { name: 'Work', link: LINK }, asOwner)).toEqual({
      note: 'Linked Work (Google): 6 events read. The link is kept as a secret.',
    });
    expect(fetched).toEqual([LINK]);
    // The row names the secret, never the link; the secret is bound to http.url for this plugin and host.
    const { rows } = await pool.query(`select * from calendar.calendar`);
    expect(JSON.stringify(rows)).not.toContain('private-5f2c');
    expect(rows[0]).toMatchObject({ id: 'work', provider: 'Google', host: 'calendar.google.com', secret_name: 'Calendar link: Work' });
    const bindings = await pool.query(
      `select b.kind, b.target, b.rule from core.secret_bindings b join core.secrets s on s.id = b.secret_id where s.name = 'Calendar link: Work'`,
    );
    expect(bindings.rows).toEqual([{ kind: 'http.url', target: { plugin: 'calendar', host: 'calendar.google.com' }, rule: 'pre-approved' }]);

    const today = await run('calendar.today', {});
    expect(today).toEqual({
      date: 'Mon 28 Sep (2026-09-28)',
      events: ['all day: Company offsite', '11:00–11:30 Team standup (moved) (Room 4)', '14:00–15:00 Call with Paris office', '15:00–16:00 Dentist (12 Main St)'],
      tiles: [
        { time: 'All day', title: 'Company offsite' },
        { time: '11:00', title: 'Team standup (moved)', where: 'Room 4' },
        { time: '14:00', title: 'Call with Paris office' },
        { time: '15:00', title: 'Dentist', where: '12 Main St' },
      ],
    });
    expect(JSON.stringify(today)).not.toContain('private-');
    // Read within ten minutes: from memory.
    expect(fetched).toHaveLength(1);
    await run('calendar.today', {});
    expect(fetched).toHaveLength(1);
    now = new Date(now.getTime() + 11 * 60_000);
    await run('calendar.today', {});
    expect(fetched).toHaveLength(2);
  });

  it('answers the coming days, a search and the free time', async () => {
    await run('calendar.add', { name: 'Work', link: LINK }, asOwner);
    const upcoming = await run('calendar.upcoming', { days: 5 });
    expect(upcoming.days.map((d: { date: string }) => d.date)).toEqual([
      'Mon 28 Sep (2026-09-28)', 'Thu 1 Oct (2026-10-01)', 'Fri 2 Oct (2026-10-02)',
    ]);
    expect(upcoming.days[1].events).toEqual(['all day until Fri 2 Oct: Trip to Boston']);
    expect(upcoming.tiles.slice(4)).toEqual([
      { time: 'All day', title: 'Trip to Boston', day: 'Thu 1 Oct' },
      { time: 'All day', title: 'Trip to Boston', day: 'Fri 2 Oct' },
    ]);

    // Home's glance: the next meeting today, then nothing once the day's are over.
    const glance = manifest.home![0]!;
    expect(glance.placement).toBe('glance');
    expect(await glance.produce(ctx())).toEqual({ icon: 'calendar', text: 'Next: Team standup (moved) at 11:00' });
    now = new Date('2026-09-28T18:30:00Z');
    expect(await glance.produce(ctx())).toEqual({ icon: 'calendar', text: 'Next: Dentist at 15:00' });
    now = new Date('2026-09-28T21:00:00Z');
    expect(await glance.produce(ctx())).toBeNull();
    now = new Date('2026-09-28T12:00:00Z');

    // The Today widget: what is left of today and tomorrow, three rows and how many more, opening the Calendar page.
    const today = manifest.widgets!.find((w) => w.id === 'calendar.today')!;
    expect(today).toMatchObject({ title: 'Today', sizes: ['medium', 'small'], refreshSeconds: 300, link: { page: 'agenda' } });
    expect(await today.produce(ctx(), { size: 'medium' })).toEqual({
      kind: 'list',
      rows: [
        { title: 'Company offsite', side: 'All day' },
        { title: 'Team standup (moved)', sub: 'Room 4', side: '11:00' },
        { title: 'Call with Paris office', side: '14:00' },
      ],
      more: '1 more by tomorrow night',
    });
    now = new Date('2026-09-28T21:00:00Z');
    expect(await today.produce(ctx(), { size: 'small' })).toEqual({ kind: 'list', rows: [{ title: 'Company offsite', side: 'All day' }] });
    now = new Date('2026-09-28T12:00:00Z');

    expect(await run('calendar.find', { query: 'dentist' })).toEqual({ found: ['Mon 28 Sep 15:00–16:00 Dentist (12 Main St)'] });
    expect((await run('calendar.find', { query: 'standup', to: '2026-10-07' })).found).toEqual([
      'Mon 14 Sep 09:30–10:00 Team standup (Zoom)',
      'Wed 16 Sep 09:30–10:00 Team standup (Zoom)',
      'Mon 21 Sep 09:30–10:00 Team standup (Zoom)',
      'Wed 23 Sep 09:30–10:00 Team standup (Zoom)',
      'Mon 28 Sep 11:00–11:30 Team standup (moved) (Room 4)',
      'Mon 5 Oct 09:30–10:00 Team standup (Zoom)',
      'Wed 7 Oct 09:30–10:00 Team standup (Zoom)',
    ]);

    expect(await run('calendar.free', { date: 'today' })).toEqual({
      date: 'Mon 28 Sep (2026-09-28), 09:00–18:00',
      free: ['09:00–11:00 (2 h)', '11:30–14:00 (2 h 30)', '16:00–18:00 (2 h)'],
      busy: ['11:00–11:30 Team standup (moved) (Room 4)', '14:00–15:00 Call with Paris office', '15:00–16:00 Dentist (12 Main St)'],
    });
    expect((await run('calendar.free', { date: '2026-09-28', from: '15:30', to: '17:00' })).free).toEqual(['16:00–17:00 (1 h)']);
  });

  it('refuses a link that does not answer with a calendar, and keeps nothing of it', async () => {
    answer = { status: 404, body: 'Not found' };
    await expect(run('calendar.add', { name: 'Old', link: LINK }, asOwner)).rejects.toThrow(/could not read that calendar: the calendar service answered 404/);
    expect((await pool.query(`select 1 from core.secrets where name = 'Calendar link: Old'`)).rowCount).toBe(0);
    expect((await pool.query(`select 1 from calendar.calendar`)).rowCount).toBe(0);
  });

  it('names a calendar that cannot be read and still answers from the others; removing forgets the link', async () => {
    await run('calendar.add', { name: 'Work', link: LINK }, asOwner);
    await run('calendar.add', { name: 'Family', link: 'webcal://p12-caldav.icloud.com/published/2/MTIzNDU2Nzg5MTIzNDU2N' }, asOwner);
    dropCache('family');
    answer = { status: 200, body: ICS };
    const both = await run('calendar.today', {});
    expect(both.events[0]).toBe('all day: Company offsite (Work)');
    dropCache();
    answer = { status: 403, body: '' };
    const failing = await run('calendar.today', {});
    expect(failing.problems).toEqual([
      'Work could not be read: the calendar service answered 403: the link was reset, unpublished or turned off. Add it again with the new link.',
      'Family could not be read: the calendar service answered 403: the link was reset, unpublished or turned off. Add it again with the new link.',
    ]);
    const page = await manifest.queries![0]!.produce({}, ctx());
    expect((page as { calendars: Array<{ state: unknown }> }).calendars[0]!.state).toEqual([{ value: 'cannot read', tone: 'danger' }]);

    expect(await run('calendar.remove', { id: 'work' }, asOwner)).toEqual({ note: 'Unlinked Work, and forgot its link.' });
    expect((await pool.query(`select 1 from core.secrets where name = 'Calendar link: Work'`)).rowCount).toBe(0);
  });
});
