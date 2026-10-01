/**
 * The tools, the settings and the sentinel on a real Postgres with core
 * migrated, the weather service stubbed. Skipped without `DATABASE_URL`.
 */
import type { Pool } from 'pg';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { createPluginHost, createPool, hostBindingOf, runMigrations, saveOwnerPlace, testDatabaseUrl, ToolRegistry, type CoreToolContext } from '@buddi/core/testing';
import { listPlaces } from './places.js';
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
    await pool.query('delete from weather.place; delete from weather.settings; delete from weather.alert; delete from core.owner_notifications; delete from core.owner_places');
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
      note: 'Home is Paris, Île-de-France, France, from your timezone; set your own on Settings → Profile.',
      tiles: [{ icon: 'cloud', value: '12°C', label: 'Home', sky: 'Overcast, feels 11°', rain: 'High 18°, low 10°' }],
    });
    expect(asked.geocode).toEqual(['Paris']);
    const second = await run('weather.now', {});
    expect(second.note).toBeUndefined();
    expect(asked.geocode).toEqual(['Paris']);
  });

  it('asks for home when the timezone names no city', async () => {
    // Not set up is an answer, not a failure: the canvas draws it as one card.
    expect(await run('weather.now', {}, { timezone: 'UTC' })).toEqual({ setUp: false, message: expect.stringMatching(/Add your Home on Settings → Profile/) });
    expect((await run('weather.forecast', {}, { timezone: 'UTC' })).setUp).toBe(false);
    // And Home has no glance, rather than deriving a home it may not write.
    const glance = manifest.home!.find((h) => h.id === 'weather.now')!;
    expect(await glance.produce(ctx({ timezone: 'UTC' }))).toBeNull();
    // The widget says where to start instead of standing empty.
    expect(await manifest.widgets![0]!.produce(ctx({ timezone: 'UTC' }), { size: 'small' })).toEqual({ kind: 'text', icon: 'sun', text: 'Add your Home on Settings → Profile to see it here.' });
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

  it('glances at home from Home: temperature and sky in the owner units, a card with the next hours, cached, linking to the Weather page', async () => {
    await run('weather.add_place', { label: 'Home', place: 'Paris' }, { agentId: 'owner' });
    forecast = {
      timezone: 'Europe/Paris',
      current: { time: '2026-09-28T08:00', temperatureC: 17.8, feelsLikeC: 17, code: 3, windKmh: 10, gustKmh: 20, precipitationMm: 0, humidity: 70, isDay: true },
      days: [{ date: '2026-09-28', code: 3, highC: 23, lowC: 14, precipitationMm: 0, precipitationChance: 10, gustKmh: 20 }],
      hours: [7, 8, 9, 10].map((hour) => ({ local: `2026-09-28T${String(hour).padStart(2, '0')}:00`, temperatureC: 10 + hour, code: 3, windKmh: 10, gustKmh: 20, precipitationMm: 0 })) as never,
    };
    await run('weather.set_units', { units: 'imperial' }, { agentId: 'owner' });
    const glance = manifest.home!.find((h) => h.id === 'weather.now')!;
    expect(glance.placement).toBe('glance');
    const before = asked.forecast.length;
    expect(await glance.produce(ctx())).toEqual({
      icon: 'cloud',
      text: '64°F, overcast in Paris',
      link: { route: { page: 'weather' } },
      // The card starts at the hour it is now: 08:00, 09:00, 10:00.
      card: { value: '64°F', caption: 'Overcast · Paris', trend: { label: 'Next 12 hours', points: [64, 66, 68] }, foot: 'High 73° · Low 57°' },
    });
    await glance.produce(ctx());
    expect(asked.forecast.length).toBe(before + 1);
    // The widget under the same id: the card as a stat when small, a strip of the next hours when medium, from the same cache.
    const widget = manifest.widgets!.find((w) => w.id === 'weather.now')!;
    expect(widget).toMatchObject({ title: 'Weather', sizes: ['small', 'medium'], refreshSeconds: 600, link: { page: 'weather' } });
    expect(await widget.produce(ctx(), { size: 'small' })).toEqual({
      kind: 'stat', icon: 'cloud', value: '64°F', caption: 'Overcast · Paris', trend: { label: 'Next 12 hours', points: [64, 66, 68] }, foot: 'High 73° · Low 57°',
    });
    expect(await widget.produce(ctx(), { size: 'medium' })).toEqual({
      kind: 'strip', icon: 'cloud', value: '64°F', caption: 'Overcast · Paris',
      items: [{ label: '08:00', icon: 'cloud', value: '64°' }, { label: '10:00', icon: 'cloud', value: '68°' }],
    });
    expect(asked.forecast.length).toBe(before + 1);

    // Each placement picks its place and units (host API 1.19): home in the plugin's units by default.
    expect(widget.settings!.map((f) => [f.key, f.kind])).toEqual([['place', 'select'], ['units', 'select']]);
    await run('weather.add_place', { label: 'Work', place: 'Lyon' }, { agentId: 'owner' });
    const place = widget.settings![0]! as { options: (ctx: unknown) => Promise<Array<{ value: string; label: string }>> };
    const choices = await place.options(ctx());
    expect(choices[0]).toEqual({ value: '', label: 'Home' });
    const work = choices.find((c) => c.label === 'Work')!;
    expect(work.value).not.toBe('');
    expect(await widget.produce(ctx(), { size: 'small', settings: { place: work.value, units: 'metric' } })).toMatchObject({
      kind: 'stat', value: '18°C', caption: 'Overcast · Lyon',
    });
    // A place since removed is no choice: home again.
    expect(await widget.produce(ctx(), { size: 'small', settings: { place: 'gone', units: '' } })).toMatchObject({ caption: 'Overcast · Paris', value: '64°F' });
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

  describe('the owner\'s places (host API 1.18)', () => {
    const profileHome = { label: 'Home', address: '12 rue X, Lyon', name: 'Lyon, Auvergne-Rhône-Alpes, France', latitude: 45.75, longitude: 4.85, timezone: 'Europe/Paris' };

    it('reads the profile first, steps its own copy aside, and takes the profile\'s Home', async () => {
      await run('weather.add_place', { label: 'Lyon', place: 'Lyon', home: true }, { agentId: 'owner' });
      await run('weather.add_place', { label: 'Paris', place: 'Paris' }, { agentId: 'owner' });
      await saveOwnerPlace(pool, profileHome);
      const places = await listPlaces(ctx().buddi!);
      // Lyon, kept here, is where the profile's Home already is: it steps aside.
      expect(places.map((p) => [p.label, p.source, p.isHome])).toEqual([['Home', 'profile', true], ['Paris', 'weather', false]]);
      expect(places[0]!.id).toBe('profile-home');
      await expect(run('weather.remove_place', { id: 'profile-home' }, { agentId: 'owner' })).rejects.toThrow(/Settings → Profile/);
      // A question without a place is about the profile's Home, and nothing is derived from the timezone.
      forecast = { timezone: 'Europe/Paris', days: [], hours: [] };
      expect((await run('weather.now', {})).place).toBe('Home (Lyon, Auvergne-Rhône-Alpes, France)');
      expect(asked.geocode).toEqual(['Lyon', 'Paris']);
    });

    it('says it needs a place until there is one, reading only', async () => {
      const registry = new ToolRegistry();
      registry.register(manifest);
      expect(await registry.readiness('weather', ctx({ timezone: 'UTC' }))).toEqual({ ready: false, note: 'Pick a place for the forecast.', page: 'settings' });
      await saveOwnerPlace(pool, profileHome);
      expect(await registry.readiness('weather', ctx())).toEqual({ ready: true });
    });

    it('exports the forecast for a place, to a plugin that requires it', async () => {
      await saveOwnerPlace(pool, profileHome);
      forecast = {
        timezone: 'Europe/Paris',
        current: { time: '2026-09-28T08:00', temperatureC: 12.4, feelsLikeC: 10.9, code: 3, windKmh: 14, gustKmh: 22, precipitationMm: 0, humidity: 70 },
        days: [{ date: '2026-09-28', code: 61, highC: 18.2, lowC: 9.6, precipitationMm: 2, precipitationChance: 60, gustKmh: 30 }],
        hours: [],
      };
      const registry = new ToolRegistry();
      registry.register(manifest);
      const commute: PluginManifest = {
        name: 'commute', version: '0.1.0', schema: 'commute', migrationsDir: '', requires: { weather: '>=0.1.0' },
        tools: [{ name: 'commute.host', description: 'host', tier: 'auto', inputSchema: { type: 'object', properties: {} }, execute: async (_i: unknown, c: CoreToolContext) => c.buddi } as never],
      };
      registry.register(commute);
      const result = await registry.invoke('commute.host', {}, ctx());
      if (!result.ok) throw new Error(result.message);
      const host = result.output as NonNullable<CoreToolContext['buddi']>;
      const answer = await host.plugins!.call<{ place: { label: string }; current: { temperature: string }; days: Array<{ high: string }> }>('weather', 'forecast', { days: 1 });
      expect(answer.place.label).toBe('Home');
      expect(answer.current.temperature).toBe('12°');
      expect(answer.days[0]!.high).toBe('18°');
      await expect(host.plugins!.call('weather', 'forecast', { latitude: 1 })).rejects.toThrow(/both latitude and longitude/);
      await expect(host.plugins!.call('weather', 'now', {})).rejects.toThrow(/exports no "now"; it exports forecast/);
    });
  });
});
