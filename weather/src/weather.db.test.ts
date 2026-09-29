/**
 * The tools, the settings and the sentinel on a real Postgres with core
 * migrated, the weather service stubbed. Skipped without `DATABASE_URL`.
 */
import type { Pool } from 'pg';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { createPluginHost, createPool, hostBindingOf, runMigrations, testDatabaseUrl, type CoreToolContext } from '@buddi/core/testing';
import type { PluginManifest, ToolDefinition } from '@buddi/core/plugin';
import { createWeatherManifest } from './index.js';
import { hoursFrom, LYON, PARIS, stubService } from './testing/stub.js';
import type { Forecast } from './open-meteo.js';

const databaseUrl = await testDatabaseUrl();
const suite = databaseUrl ? describe : describe.skip;
const TEST_DB = `buddi_weather_test_${process.pid}`;
const NOW = new Date('2026-09-28T06:00:00Z');

suite('weather (postgres)', () => {
  let admin: Pool;
  let pool: Pool;
  let forecast: Forecast | undefined;
  const { service, asked } = stubService({
    places: { paris: [PARIS], lyon: [LYON], 'new york': [] },
    forecast: () => forecast ?? { timezone: 'Europe/Paris', days: [], hours: [] },
  });
  const manifest: PluginManifest = createWeatherManifest(service);

  const ctx = (over: Partial<CoreToolContext> = {}): CoreToolContext => {
    const facts: CoreToolContext = { db: pool, ownerId: 'owner', now: () => NOW, timezone: 'Europe/Paris', agentId: 'planner', ...over };
    return { ...facts, buddi: createPluginHost(hostBindingOf(manifest), facts) };
  };
  const tool = (name: string) => manifest.tools.find((t) => t.name === name)! as ToolDefinition<any, any>;
  const run = (name: string, input: unknown, over: Partial<CoreToolContext> = {}) => tool(name).execute(input as never, ctx(over));

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
    await pool?.end();
    await admin?.query(`drop database if exists ${TEST_DB}`);
    await admin?.end();
  });

  beforeEach(async () => {
    forecast = undefined;
    asked.geocode.length = 0;
    await pool.query('delete from weather.place; delete from weather.settings; delete from weather.alert; delete from core.owner_notifications');
  });

  it('makes home from the timezone on first use, says so once, and answers in plain words', async () => {
    forecast = {
      timezone: 'Europe/Paris',
      current: { time: '2026-09-28T08:00', temperatureC: 12.4, feelsLikeC: 10.9, code: 3, windKmh: 14, gustKmh: 22, precipitationMm: 0, humidity: 70 },
      days: [{ date: '2026-09-28', code: 61, highC: 18.2, lowC: 9.6, precipitationMm: 2, precipitationChance: 60, gustKmh: 30 }],
      hours: [],
    };
    const first = await run('weather.now', {});
    expect(first).toEqual({
      place: 'Home (Paris, Île-de-France, France)',
      now: '12°C (feels 11°C), overcast, wind 14 km/h',
      today: 'high 18°C, low 10°C, light rain, 60% chance of rain',
      note: 'Home is Paris, Île-de-France, France, from your timezone; change it on Settings → Weather.',
      tiles: [{ icon: 'cloud', value: '12°C', label: 'Home', sky: 'Overcast, feels 11°', rain: 'High 18°, low 10°' }],
    });
    expect(asked.geocode).toEqual(['Paris']);
    const second = await run('weather.now', {});
    expect(second.note).toBeUndefined();
    expect(asked.geocode).toEqual(['Paris']);
  });

  it('asks for home when the timezone names no city', async () => {
    // Not set up is an answer, not a failure: the canvas draws it as one card.
    expect(await run('weather.now', {}, { timezone: 'UTC' })).toEqual({ setUp: false, message: expect.stringMatching(/Add your home on Settings → Weather/) });
    expect((await run('weather.forecast', {}, { timezone: 'UTC' })).setUp).toBe(false);
    // And Home has no glance, rather than deriving a home it may not write.
    const glance = manifest.home!.find((h) => h.id === 'weather.now')!;
    expect(await glance.produce(ctx({ timezone: 'UTC' }))).toBeNull();
  });

  it('keeps places from the settings page: add, make home, units, remove', async () => {
    expect(await run('weather.add_place', { label: 'Home', place: 'Paris' }, { agentId: 'owner' })).toEqual({ note: 'Saved Home: Paris, Île-de-France, France, your home.' });
    expect(await run('weather.add_place', { label: 'Work', place: 'Lyon' }, { agentId: 'owner' })).toEqual({ note: 'Saved Work: Lyon, Auvergne-Rhône-Alpes, France.' });
    await expect(run('weather.add_place', { label: 'Nowhere', place: 'New York' }, { agentId: 'owner' })).rejects.toThrow(/No place called "New York"/);
    expect(await run('weather.places', {})).toEqual({
      places: ['Home: Paris, Île-de-France, France (home)', 'Work: Lyon, Auvergne-Rhône-Alpes, France'],
      units: 'metric',
    });
    await run('weather.set_home', { id: 'work' }, { agentId: 'owner' });
    await run('weather.set_units', { units: 'imperial' }, { agentId: 'owner' });
    expect(await run('weather.places', {})).toEqual({
      places: ['Work: Lyon, Auvergne-Rhône-Alpes, France (home)', 'Home: Paris, Île-de-France, France'],
      units: 'imperial',
    });
    await run('weather.remove_place', { id: 'work' }, { agentId: 'owner' });
    expect((await run('weather.places', {})).places).toEqual(['Home: Paris, Île-de-France, France (home)']);
    // The page reads the same.
    const page = await manifest.queries!.find((q) => q.name === 'settings')!.produce({}, ctx());
    expect(page).toMatchObject({ units: 'imperial', empty: false, places: [{ id: 'home', label: 'Home', isHome: true }] });
  });

  it('answers the forecast for a saved place by name, and for any city', async () => {
    await run('weather.add_place', { label: 'Work', place: 'Lyon' }, { agentId: 'owner' });
    forecast = {
      timezone: 'Europe/Paris',
      days: [
        { date: '2026-09-28', code: 95, highC: 24, lowC: 15, precipitationMm: 12, precipitationChance: 90, gustKmh: 60 },
        { date: '2026-09-29', code: 1, highC: 21, lowC: 12, precipitationMm: 0, precipitationChance: 10, gustKmh: 20 },
      ],
      hours: [],
    };
    expect(await run('weather.forecast', { place: 'work', days: 2 })).toEqual({
      place: 'Work (Lyon, Auvergne-Rhône-Alpes, France)',
      days: ['2026-09-28: thunderstorm, 15°C to 24°C, 12 mm rain (90%), gusts 60 km/h', '2026-09-29: mostly clear, 12°C to 21°C'],
      tiles: [
        { icon: 'storm', value: '24° / 15°', label: 'Today', sky: 'Thunderstorm', rain: '90% chance · 12 mm' },
        { icon: 'sun', value: '21° / 12°', label: 'Tuesday', sky: 'Mostly clear', rain: '10% chance' },
      ],
    });
    expect((await run('weather.forecast', { place: 'Paris', days: 1 })).place).toBe('Paris (Paris, Île-de-France, France)');
  });

  it('glances at home from Home: temperature and sky in the owner units, cached, linking to Settings', async () => {
    await run('weather.add_place', { label: 'Home', place: 'Paris' }, { agentId: 'owner' });
    forecast = {
      timezone: 'Europe/Paris',
      current: { time: '2026-09-28T08:00', temperatureC: 17.8, feelsLikeC: 17, code: 3, windKmh: 10, gustKmh: 20, precipitationMm: 0, humidity: 70, isDay: true },
      days: [],
      hours: [],
    };
    await run('weather.set_units', { units: 'imperial' }, { agentId: 'owner' });
    const glance = manifest.home!.find((h) => h.id === 'weather.now')!;
    expect(glance.placement).toBe('glance');
    const before = asked.forecast.length;
    expect(await glance.produce(ctx())).toEqual({ icon: 'cloud', text: '64°F, overcast in Paris', link: { route: { page: 'settings' } } });
    await glance.produce(ctx());
    expect(asked.forecast.length).toBe(before + 1);
  });

  it('tells the owner once per severe event, and nothing without saved places', async () => {
    const sentinel = manifest.sentinels![0]!;
    const host = () => ({ buddi: createPluginHost(hostBindingOf(manifest), { db: pool, ownerId: 'owner', now: () => NOW, timezone: 'Europe/Paris' } as CoreToolContext) });
    forecast = { timezone: 'Europe/Paris', days: [], hours: hoursFrom(NOW, 30, (i) => (i === 10 ? { code: 95, gustKmh: 90 } : {})) };
    expect(await sentinel.run(host())).toEqual([]);
    expect((await pool.query('select 1 from core.owner_notifications')).rowCount).toBe(0);

    await run('weather.add_place', { label: 'Home', place: 'Paris' }, { agentId: 'owner' });
    await sentinel.run(host());
    await sentinel.run(host());
    const { rows } = await pool.query(`select title, urgency, plugin_id from core.owner_notifications order by title`);
    expect(rows).toEqual([
      { title: 'Thunderstorms and strong wind at Home from 16:00 on 2026-09-28', urgency: 'today', plugin_id: 'weather' },
    ]);
    // A new kind later in the day is news; the storm already said is not.
    forecast = { timezone: 'Europe/Paris', days: [], hours: hoursFrom(NOW, 30, (i) => (i === 10 ? { code: 95, gustKmh: 90 } : i === 12 ? { temperatureC: 36 } : {})) };
    await sentinel.run(host());
    expect((await pool.query(`select title from core.owner_notifications where title like 'Extreme heat%'`)).rowCount).toBe(1);
  });
});
