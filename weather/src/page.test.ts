/**
 * The Weather page: its descriptor through core's checks, and its four
 * queries on a stubbed service and a fake host — the glyphs, the owner's
 * units, the next 24 hours, a picked day, the week and ten days, the severe
 * warning, and one forecast per place per ten minutes.
 */
import { describe, expect, it } from 'vitest';
import type { BuddiHost, PageQuery } from '@buddi/core/plugin';
import { ToolRegistry } from '@buddi/core/testing';
import { createPageQueries, hourRow, shortDay, weatherRailPage } from './page.js';
import { manifest } from './index.js';
import { LYON, stubService } from './testing/stub.js';
import type { Day, Forecast, Hour } from './open-meteo.js';

const NOW = new Date('2026-09-28T08:15:00Z'); // 10:15 in Lyon

/** Two days of hours in Lyon (UTC+2): code 2 by day, 1 at night, a storm at 16:00 on the first. */
function forecast(): Forecast {
  const hours: Hour[] = Array.from({ length: 48 }, (_, i) => {
    const date = i < 24 ? '2026-09-28' : '2026-09-29';
    const hh = String(i % 24).padStart(2, '0');
    return {
      local: `${date}T${hh}:00`,
      at: new Date(Date.parse(`${date}T${hh}:00:00Z`) - 2 * 3_600_000),
      code: i === 16 ? 95 : i % 24 < 8 || i % 24 >= 20 ? 0 : 2,
      temperatureC: 10 + (i % 24) / 2,
      precipitationMm: 0,
      snowfallCm: 0,
      gustKmh: 20,
      windKmh: 10,
      precipitationChance: (i % 24) * 2,
      isDay: !(i % 24 < 8 || i % 24 >= 20),
    };
  });
  const days: Day[] = Array.from({ length: 10 }, (_, i) => ({
    date: new Date(Date.UTC(2026, 8, 28 + i)).toISOString().slice(0, 10),
    code: i === 1 ? 61 : 2,
    highC: 21 + i,
    lowC: 12,
    precipitationMm: 0,
    precipitationChance: i * 10,
    gustKmh: 30,
    windKmh: 12,
    sunrise: `2026-09-${28 + (i % 3)}T07:42`,
    sunset: `2026-09-${28 + (i % 3)}T19:31`,
  }));
  return { timezone: 'Europe/Paris', current: { time: '2026-09-28T10:15', temperatureC: 17.6, feelsLikeC: 16.6, code: 2, windKmh: 12, gustKmh: 20, precipitationMm: 0, humidity: 70, isDay: true }, days, hours };
}

const SAVED = [
  { id: 'home', label: 'Home', name: 'Lyon, Auvergne-Rhône-Alpes, France', latitude: 45.75, longitude: 4.85, timezone: 'Europe/Paris', is_home: true },
  { id: 'work', label: 'Work', name: 'Grenoble, Auvergne-Rhône-Alpes, France', latitude: 45.19, longitude: 5.72, timezone: 'Europe/Paris', is_home: false },
];

function setup(opts: { places?: typeof SAVED; units?: 'metric' | 'imperial'; timezone?: string; time?: '12h' | '24h'; version?: string } = {}) {
  const { service, asked } = stubService({ places: { lyon: [LYON] }, forecast: forecast });
  let now = NOW;
  const buddi = {
    db: {
      async query(sql: string) {
        if (sql.includes('from weather.place')) return { rows: opts.places ?? SAVED };
        if (sql.includes('from weather.settings')) return { rows: opts.units ? [{ units: opts.units }] : [] };
        throw new Error(`unexpected sql: ${sql}`);
      },
    },
    owner: { timezone: opts.timezone ?? 'Europe/Lyon', language: async () => 'en-GB', formats: async () => ({ time: opts.time ?? null, date: null }) },
    ...(opts.version ? { version: opts.version } : {}),
    clock: { now: () => now },
    http: undefined,
  } as unknown as BuddiHost;
  const queries = createPageQueries(service);
  const run = async (name: string, params: Record<string, unknown> = {}): Promise<any> => {
    const query = queries.find((q) => q.name === name)! as PageQuery;
    return query.produce(query.params.parse(params), { buddi } as never);
  };
  return { run, asked, later: (ms: number) => { now = new Date(now.getTime() + ms); } };
}

describe('the weather page', () => {
  it('is a rail page core accepts: tabs with the place pick, over a hero and the day in one panel', () => {
    // Registering is what checks a page: its shape, its queries, a tab bar's default, a panel's series.
    expect(() => new ToolRegistry().register(manifest)).not.toThrow();
    expect(weatherRailPage).toMatchObject({ id: 'weather', place: 'rail', title: 'Weather', icon: 'cloud' });
    const tabs = weatherRailPage.body.find((c) => c.kind === 'tabs')!;
    expect(tabs.kind === 'tabs' && tabs.tabs.map((t) => [t.id, t.label])).toEqual([['today', 'Today'], ['week', 'Week'], ['days', '10 days']]);
    expect(tabs.kind === 'tabs' && tabs.tabs[0]!.body.map((c) => c.kind)).toEqual(['hero', 'series-panel']);
    expect(tabs.kind === 'tabs' && tabs.tabs[1]!.body.map((c) => c.kind)).toEqual(['tiles', 'series-panel']);
  });

  it('answers now at a place, in the owner units, with the facts the hero shows', async () => {
    const { run } = setup();
    expect(await run('today')).toEqual({
      setUp: true, place: 'Home', name: 'Lyon, Auvergne-Rhône-Alpes, France',
      icon: 'partly-cloudy', now: '18°', sky: 'Partly cloudy', feels: '17°', highLow: '21° / 12°', wind: '12 km/h', rain: '0%',
      sunrise: '07:42', sunset: '19:31',
      hasSevere: true,
      severe: 'Thunderstorms at Home, from 16:00 on 2026-09-28 (local time). From the Open-Meteo forecast; it can still change.',
    });
    const imperial = await setup({ units: 'imperial' }).run('today', { place: 'work' });
    expect(imperial).toMatchObject({ place: 'Work', now: '64°', feels: '62°', highLow: '70° / 54°', wind: '7 mph' });
  });

  it('lists the next 24 hours from the hour it is now, and a picked day by its hours', async () => {
    const { run } = setup();
    const next = (await run('hours')).hours;
    expect(next).toHaveLength(24);
    expect(next[0]).toEqual({ date: '2026-09-28', time: 'Now', icon: 'partly-cloudy', value: '15°', rain: 'Rain 20%', temp: 15, chance: 20, wind: 10 });
    expect(next[6]).toMatchObject({ time: '16:00', icon: 'storm' });
    expect(next[23]).toMatchObject({ date: '2026-09-29', time: '09:00' });
    const tuesday = (await run('hours', { date: '2026-09-29' })).hours;
    expect(tuesday.map((h: { time: string }) => h.time)).toEqual(Array.from({ length: 24 }, (_, h) => `${String(h).padStart(2, '0')}:00`));
    // A clear night is the moon.
    expect(tuesday[2]).toMatchObject({ icon: 'moon-clear', value: '11°' });
    await expect(setup().run('hours', { date: 'Tuesday' })).rejects.toThrow();
  });

  it('writes the hours and the sun the owner way, and a partly cloudy night as the crescent over the cloud', async () => {
    const twelve = setup({ time: '12h', version: '1.22' });
    const next = (await twelve.run('hours')).hours;
    expect(next.slice(0, 4).map((h: { time: string }) => h.time)).toEqual(['Now', '11 AM', '12 PM', '1 PM']);
    expect(next[14]).toMatchObject({ time: '12 AM' });
    expect(await twelve.run('today')).toMatchObject({ sunrise: '7:42 AM', sunset: '7:31 PM' });
    // Every hour of the night wears the moon on a buddi that draws moon-cloud; partly cloudy at 22:00 here.
    const night = forecast();
    night.hours[22]!.code = 2;
    const { service } = stubService({ places: { lyon: [LYON] }, forecast: () => night });
    const buddi = { db: { async query(sql: string) { return { rows: sql.includes('weather.place') ? SAVED : [] }; } }, owner: { timezone: 'Europe/Paris', language: async () => 'en-US', formats: async () => ({ time: null, date: null }) }, clock: { now: () => NOW }, http: undefined, version: '1.22' } as unknown as BuddiHost;
    const hours = createPageQueries(service).find((q) => q.name === 'hours')!;
    const day = (await hours.produce(hours.params.parse({ date: '2026-09-28' }), { buddi } as never)) as { hours: Array<{ time: string; icon: string }> };
    // Auto in en-US: 12-hour.
    expect(day.hours[22]).toMatchObject({ time: '10 PM', icon: 'moon-cloud' });
    expect(day.hours[2]).toMatchObject({ time: '2 AM', icon: 'moon-clear' });
    expect(day.hours[12]).toMatchObject({ time: '12 PM', icon: 'partly-cloudy' });
  });

  it('lists seven days or ten, today first, and nothing else', async () => {
    const { run } = setup();
    const week = (await run('days', { count: '7' })).days;
    expect(week).toHaveLength(7);
    expect(week[0]).toEqual({ date: '2026-09-28', icon: 'partly-cloudy', value: '21° / 12°', label: 'Today', rain: 'Rain 0%', wind: 'Wind 12 km/h' });
    expect(week[1]).toMatchObject({ label: 'Tue 29', icon: 'rain', rain: 'Rain 10%' });
    expect((await run('days', { count: '10' })).days.map((d: { label: string }) => d.label)).toEqual(['Today', 'Tue 29', 'Wed 30', 'Thu 1', 'Fri 2', 'Sat 3', 'Sun 4', 'Mon 5', 'Tue 6', 'Wed 7']);
    await expect(run('days', { count: '8' })).rejects.toThrow();
    expect(shortDay('2026-10-04')).toBe('Sun 4');
  });

  it('asks once per place in ten minutes, whichever views are opened', async () => {
    const { run, asked, later } = setup();
    await run('today');
    await run('hours');
    await run('days', { count: '10' });
    expect(asked.forecast).toHaveLength(1);
    expect(asked.forecast[0]).toMatchObject({ days: 10, current: true, detailed: true });
    await run('today', { place: 'work' });
    expect(asked.forecast).toHaveLength(2);
    later(10 * 60_000);
    await run('hours');
    expect(asked.forecast).toHaveLength(3);
  });

  it('with nothing saved, is about the city the timezone names, and says so when it names none', async () => {
    const found = setup({ places: [], timezone: 'Europe/Lyon' });
    expect(await found.run('places')).toEqual({ places: [{ id: 'home', label: 'Home' }] });
    expect(await found.run('today')).toMatchObject({ setUp: true, place: 'Home', name: 'Lyon, Auvergne-Rhône-Alpes, France' });
    const none = setup({ places: [], timezone: 'UTC' });
    expect(await none.run('places')).toEqual({ places: [] });
    expect(await none.run('today')).toMatchObject({ setUp: false, hasSevere: false });
    expect(await none.run('days')).toEqual({ days: [] });
  });

  it('writes an hour in imperial for the chart as a number', () => {
    const hour = forecast().hours[14]!;
    expect(hourRow(hour, 'imperial', '14:00')).toMatchObject({ value: '63°', temp: 63, icon: 'partly-cloudy', wind: 6 });
  });

  it('draws the panel’s chart and its strip from the same hours: the temperature is the tiles’ value, point for point', async () => {
    const tabs = weatherRailPage.body.find((c) => c.kind === 'tabs')!;
    const panels = tabs.kind === 'tabs' ? tabs.tabs.flatMap((t) => t.body.filter((c) => c.kind === 'series-panel')) : [];
    expect(panels).toHaveLength(2);
    for (const units of ['metric', 'imperial'] as const) {
      const { run } = setup({ units });
      for (const panel of panels) {
        if (panel.kind !== 'series-panel') continue;
        expect(panel.series.map((s) => [s.id, s.unit, s.kind])).toEqual([['temp', 'temp', 'area'], ['rain', 'percent', 'bars'], ['wind', 'speed', 'area']]);
        const date = panel.query.params && 'date' in panel.query.params ? { date: '2026-09-29' } : {};
        const points = (await run(panel.query.query, date))[panel.points] as Array<Record<string, unknown>>;
        expect(points).toHaveLength(24);
        const temp = panel.series.find((s) => s.id === 'temp')!;
        const rain = panel.series.find((s) => s.id === 'rain')!;
        expect(points.map((p) => `${p[temp.y]}°`)).toEqual(points.map((p) => p[panel.tiles.value]));
        expect(points.map((p) => `Rain ${p[rain.y]}%`)).toEqual(points.map((p) => p[panel.tiles.lines![0]!]));
        expect(points.map((p) => p[panel.x])).toEqual(points.map((p) => p[panel.tiles.label]));
      }
    }
  });
});
