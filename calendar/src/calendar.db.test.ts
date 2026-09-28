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
    await expect(run('calendar.today', {})).rejects.toThrow(/Add one on Settings → Calendar/);
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
