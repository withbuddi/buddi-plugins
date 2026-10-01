/**
 * The Weather page in the rail: a saved place at a time, as the design kit's
 * Weather screen draws it — Today (now, large; then one panel of the next 24
 * hours: temperature, rain or wind as a chart with its values written on it,
 * over the hourly strip, one highlight between them), Week (seven days, the
 * picked one's hours in the same panel below) and 10 days — with a warning at
 * the top when something severe is coming there in the next 24 hours.
 *
 * Four read-only queries, every value already written in the owner's units.
 * One forecast per place feeds all of them, kept ten minutes: switching
 * views or places asks Open-Meteo at most once per place in that time. With
 * no place saved, home is the city the owner's timezone names, found but not
 * saved (a query does not write); a zone that names no city says so.
 */
import { z } from 'zod';
import type { BuddiHost, PageDescriptor, PageQuery } from '@buddi/core/plugin';
import { describeCode, glyphOf, MAX_FORECAST_DAYS, type Forecast, type Hour, type WeatherService } from './open-meteo.js';
import { cityOfZone, displayName, listPlaces, NO_HOME, unitsFor, type Place } from './places.js';
import { describeEvents, severeEvents } from './severe.js';
import { degrees, speed, type Units } from './units.js';
import { clockLabel, drawsMoonCloud, hourLabel, ownerTimeFormat } from './time.js';

export const PAGE_CACHE_MS = 10 * 60_000;

type PagePlace = Pick<Place, 'id' | 'label' | 'name' | 'latitude' | 'longitude'>;
type Host = Pick<BuddiHost, 'db' | 'owner' | 'http' | 'clock'>;

const capital = (text: string): string => text.charAt(0).toUpperCase() + text.slice(1);
const WEEKDAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];

/** `2026-09-29` → `Tue 29`, read as a calendar date wherever the gateway runs. */
export function shortDay(date: string): string {
  const at = new Date(`${date}T12:00:00Z`);
  return Number.isNaN(at.getTime()) ? date : `${WEEKDAYS[at.getUTCDay()]} ${at.getUTCDate()}`;
}


/** A temperature as the chart reads it: a number in the owner's units. */
export function inUnits(celsius: number, units: Units): number {
  return Math.round(units === 'imperial' ? (celsius * 9) / 5 + 32 : celsius);
}

/** A wind speed as the chart reads it: km/h or mph, a whole number. */
export function speedInUnits(kmh: number, units: Units): number {
  return Math.round(units === 'imperial' ? kmh / 1.609344 : kmh);
}

/**
 * One hour as a tile of the strip and as a point of the chart: the same row,
 * so they cannot disagree. `moonCloud`: whether this buddi draws a partly
 * cloudy night (host API 1.22).
 */
export function hourRow(h: Hour, units: Units, label: string, moonCloud = true) {
  const chance = h.precipitationChance ?? 0;
  return {
    date: h.local.slice(0, 10),
    time: label,
    icon: glyphOf(h.code, { ...(h.isDay === undefined ? {} : { isDay: h.isDay }), gustKmh: h.gustKmh, moonCloud }),
    value: degrees(h.temperatureC, units),
    rain: `Rain ${chance}%`,
    temp: inUnits(h.temperatureC, units),
    chance,
    wind: speedInUnits(h.windKmh, units),
  };
}

/** The place the page is about: the one picked, else home, else the timezone's city, found but not saved. */
async function placeFor(buddi: Host, service: WeatherService, id: string | undefined): Promise<PagePlace | null> {
  const places = await listPlaces(buddi);
  const picked = (id && places.find((p) => p.id === id)) || places.find((p) => p.isHome) || places[0];
  if (picked) return picked;
  const city = cityOfZone(buddi.owner.timezone);
  if (city === undefined) return null;
  const found = (await service.geocode(city, buddi.http))[0];
  return found ? { id: 'home', label: 'Home', name: displayName(found), latitude: found.latitude, longitude: found.longitude } : null;
}

/**
 * The four queries, over one cached forecast per place. `service` is the
 * port, so the tests run on a stub; the cache lives as long as the plugin.
 */
export function createPageQueries(service: WeatherService): PageQuery[] {
  const cache = new Map<string, { at: number; forecast: Forecast }>();
  const forecastOf = async (buddi: Host, place: PagePlace): Promise<Forecast> => {
    const key = `${place.latitude},${place.longitude}`;
    const now = buddi.clock.now().getTime();
    const hit = cache.get(key);
    if (hit && now - hit.at < PAGE_CACHE_MS) return hit.forecast;
    const forecast = await service.forecast(
      { latitude: place.latitude, longitude: place.longitude, days: MAX_FORECAST_DAYS, current: true, detailed: true },
      buddi.http,
    );
    cache.set(key, { at: now, forecast });
    return forecast;
  };
  /** The place, its forecast and the units — or null when there is no place to ask about. */
  const read = async (ctx: { buddi?: BuddiHost }, id: string | undefined) => {
    const buddi = ctx.buddi!;
    const place = await placeFor(buddi, service, id);
    if (!place) return null;
    const [{ units }, forecast, time] = await Promise.all([unitsFor(buddi), forecastOf(buddi, place), ownerTimeFormat(buddi)]);
    return { buddi, place, units, forecast, time, moonCloud: drawsMoonCloud(buddi.version) };
  };
  const placeParam = z.string().max(60).optional();

  return [
    {
      name: 'places',
      params: z.object({}),
      async produce(_params, ctx) {
        const places = await listPlaces(ctx.buddi!);
        if (places.length > 0) return { places: places.map((p) => ({ id: p.id, label: p.label })) };
        return { places: cityOfZone(ctx.buddi!.owner.timezone) === undefined ? [] : [{ id: 'home', label: 'Home' }] };
      },
    },
    {
      name: 'today',
      params: z.object({ place: placeParam }),
      async produce(params, ctx) {
        const got = await read(ctx, (params as { place?: string }).place);
        if (!got) return { setUp: false, message: NO_HOME, hasSevere: false };
        const { buddi, place, units, forecast, time, moonCloud } = got;
        const c = forecast.current;
        const day = forecast.days[0];
        const events = severeEvents(forecast.hours, buddi.clock.now());
        return {
          setUp: true,
          place: place.label,
          name: place.name,
          icon: c ? glyphOf(c.code, { ...(c.isDay === undefined ? {} : { isDay: c.isDay }), gustKmh: c.gustKmh, moonCloud }) : 'cloud',
          now: c ? degrees(c.temperatureC, units) : '',
          sky: c ? capital(describeCode(c.code)) : '',
          feels: c ? degrees(c.feelsLikeC, units) : '',
          highLow: day ? `${degrees(day.highC, units)} / ${degrees(day.lowC, units)}` : '',
          wind: c ? speed(c.windKmh, units) : '',
          rain: day?.precipitationChance === null || day === undefined ? '' : `${day.precipitationChance}%`,
          sunrise: clockLabel(day?.sunrise, time),
          sunset: clockLabel(day?.sunset, time),
          hasSevere: events.length > 0,
          severe: events.length > 0 ? describeEvents(events, place.label, units).text : '',
        };
      },
    },
    {
      name: 'days',
      params: z.object({
        place: placeParam,
        count: z.coerce.number().pipe(z.union([z.literal(7), z.literal(10)])).optional(),
      }),
      async produce(params, ctx) {
        const { place, count } = params as { place?: string; count?: 7 | 10 };
        const got = await read(ctx, place);
        if (!got) return { days: [] };
        const { units, forecast } = got;
        return {
          days: forecast.days.slice(0, count ?? 7).map((d, i) => ({
            date: d.date,
            icon: glyphOf(d.code, { gustKmh: d.gustKmh }),
            value: `${degrees(d.highC, units)} / ${degrees(d.lowC, units)}`,
            label: i === 0 ? 'Today' : shortDay(d.date),
            rain: `Rain ${d.precipitationChance ?? 0}%`,
            wind: `Wind ${speed(d.windKmh ?? d.gustKmh, units)}`,
          })),
        };
      },
    },
    {
      name: 'hours',
      params: z.object({ place: placeParam, date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional() }),
      async produce(params, ctx) {
        const { place, date } = params as { place?: string; date?: string };
        const got = await read(ctx, place);
        if (!got) return { hours: [] };
        const { units, forecast, time, moonCloud } = got;
        if (date !== undefined) {
          return { hours: forecast.hours.filter((h) => h.local.startsWith(date)).map((h) => hourRow(h, units, hourLabel(h.local, time), moonCloud)) };
        }
        // The next 24 hours, from the hour it is now at the place.
        const nowHour = forecast.current?.time.slice(0, 13);
        const from = Math.max(0, nowHour ? forecast.hours.findIndex((h) => h.local.startsWith(nowHour)) : 0);
        return {
          hours: forecast.hours.slice(from, from + 24).map((h, i) => hourRow(h, units, i === 0 ? 'Now' : hourLabel(h.local, time), moonCloud)),
        };
      },
    },
  ];
}

const placeRef = { place: { param: 'place' } } as const;

type SeriesPanel = Extract<PageDescriptor['body'][number], { kind: 'series-panel' }>;

/**
 * A day's hours in one panel: temperature, rain chance and wind as the tabs
 * of its chart, and the strip of the same hours under it.
 */
function dayPanel(title: string, query: SeriesPanel['query']): SeriesPanel {
  return {
    kind: 'series-panel',
    title,
    query,
    points: 'hours',
    x: 'time',
    series: [
      { id: 'temp', label: 'Temperature', y: 'temp', unit: 'temp', kind: 'area' },
      { id: 'rain', label: 'Rain', y: 'chance', unit: 'percent', kind: 'bars' },
      { id: 'wind', label: 'Wind', y: 'wind', unit: 'speed', kind: 'area' },
    ],
    tiles: { icon: { path: 'icon' }, value: 'value', label: 'time', lines: ['rain'] },
    labelEvery: 3,
    empty: 'No hours came back.',
  };
}

export const weatherRailPage: PageDescriptor = {
  id: 'weather',
  title: 'Weather',
  place: 'rail',
  icon: 'cloud',
  data: { query: 'today', params: placeRef },
  body: [
    { kind: 'notice', text: 'Your places: today by the hour, the week, and ten days ahead.' },
    { kind: 'notice', tone: 'warning', title: 'Severe weather', text: { path: 'severe' }, when: { path: 'hasSevere', equals: true } },
    { kind: 'notice', text: { path: 'message' }, when: { path: 'setUp', equals: false } },
    {
      kind: 'tabs',
      pick: { param: 'place', label: 'Place', optionsFrom: { query: { query: 'places' }, rows: 'places', value: 'id', label: 'label' } },
      default: 'today',
      tabs: [
        {
          id: 'today',
          label: 'Today',
          body: [
            {
              kind: 'hero',
              query: { query: 'today', params: placeRef },
              icon: { path: 'icon' },
              value: 'now',
              title: 'sky',
              facts: [
                { label: 'Feels like', path: 'feels' },
                { label: 'High / low', path: 'highLow' },
                { label: 'Wind', path: 'wind' },
                { label: 'Rain', path: 'rain' },
                { label: 'Sunrise', path: 'sunrise' },
                { label: 'Sunset', path: 'sunset' },
              ],
              empty: 'No forecast came back.',
            },
            dayPanel('Today', { query: 'hours', params: placeRef }),
          ],
        },
        {
          id: 'week',
          label: 'Week',
          body: [
            {
              kind: 'tiles',
              query: { query: 'days', params: { ...placeRef, count: { const: 7 } } },
              items: 'days',
              icon: { path: 'icon' },
              value: 'value',
              label: 'label',
              lines: ['rain', 'wind'],
              layout: 'row',
              select: { param: 'date', key: 'date' },
              empty: 'No forecast came back.',
            },
            dayPanel('By the hour', { query: 'hours', params: { ...placeRef, date: { param: 'date' } } }),
          ],
        },
        {
          id: 'days',
          label: '10 days',
          body: [
            {
              kind: 'tiles',
              query: { query: 'days', params: { ...placeRef, count: { const: 10 } } },
              items: 'days',
              icon: { path: 'icon' },
              value: 'value',
              label: 'label',
              lines: ['rain', 'wind'],
              layout: 'row',
              empty: 'No forecast came back.',
            },
          ],
        },
      ],
    },
  ],
};
