/**
 * The three tools a model sees: now, the forecast, and the saved places. All
 * `auto` and read-only; the answers are short plain strings, because they are
 * read aloud in a brief or a chat line. Beside them `tiles` carries the same
 * days as data the canvas draws (`views.ts`): a glyph, "64° / 55°" in the
 * owner's units, the weekday, the sky and the rain.
 *
 * With no place saved and a timezone that names no city, a tool is not set
 * up rather than broken: it answers `{ setUp: false, message }`, which the
 * canvas draws as one card linking to Settings → Weather.
 */
import { z } from 'zod';
import type { ToolDefinition } from '@buddi/core/plugin';
import { describeCode, glyphOf, type Day, type SkyGlyph, type WeatherService } from './open-meteo.js';
import { ensurePlaces, NO_HOME, resolvePlace, unitsFor } from './places.js';
import { degrees, depth, speed, temperature, type Units } from './units.js';
import { drawsMoonCloud } from './time.js';

/** What a tool answers when there is no place to ask about yet. */
export interface NotSetUp {
  setUp: false;
  message: string;
}

/** Run `answer`, or say the plugin is not set up when that is why it could not. */
async function unlessNotSetUp<T>(answer: () => Promise<T>): Promise<T | NotSetUp> {
  try {
    return await answer();
  } catch (err) {
    if (err instanceof Error && err.message === NO_HOME) return { setUp: false, message: NO_HOME };
    throw err;
  }
}

/** One card on the canvas. Every field already formatted. */
export interface WeatherTile {
  icon: SkyGlyph;
  value: string;
  label: string;
  sky: string;
  rain?: string;
}

const capital = (text: string): string => text.charAt(0).toUpperCase() + text.slice(1);

/** `2026-09-29` → `Tuesday`, read as a calendar date wherever the gateway runs. */
export function weekdayOf(date: string): string {
  const at = Date.parse(`${date}T12:00:00Z`);
  return Number.isNaN(at) ? date : new Date(at).toLocaleDateString('en-US', { weekday: 'long', timeZone: 'UTC' });
}

/** "60% · 2.0 mm", "60%", "2.0 mm", or nothing for a dry day. */
function rainLine(chance: number | null, mm: number, units: Units): string | undefined {
  const parts = [chance !== null && chance > 0 ? `${chance}% chance` : '', mm >= 0.1 ? depth(mm, units) : ''].filter(Boolean);
  return parts.length > 0 ? parts.join(' · ') : undefined;
}

export function dayTile(d: Day, units: Units, label: string): WeatherTile {
  const rain = rainLine(d.precipitationChance, d.precipitationMm, units);
  return {
    icon: glyphOf(d.code, { gustKmh: d.gustKmh }),
    value: `${degrees(d.highC, units)} / ${degrees(d.lowC, units)}`,
    label,
    sky: capital(describeCode(d.code)),
    ...(rain ? { rain } : {}),
  };
}

const placeField = z
  .string()
  .max(120)
  .optional()
  .describe('A saved place (home, work, …) or any city. Home when left out.');

const nowInput = z.object({ place: placeField }).strict();

export interface NowOutput {
  place: string;
  now: string;
  today: string;
  note?: string;
  /** One card: the temperature now, for the canvas. */
  tiles: WeatherTile[];
}

export function createNowTool(service: WeatherService): ToolDefinition<z.infer<typeof nowInput>, NowOutput | NotSetUp> {
  return {
    name: 'weather.now',
    description:
      'The weather right now at one of the owner\'s places (home when none is named) or any city: temperature, ' +
      'sky, wind, and today\'s high and low. Use it when the owner asks about the weather now or today.',
    tier: 'auto',
    input: nowInput,
    execute: (input, ctx) => unlessNotSetUp(async () => {
      const buddi = ctx.buddi!;
      const { place, note } = await resolvePlace(buddi, service, input.place);
      const { units } = await unitsFor(buddi);
      const forecast = await service.forecast({ latitude: place.latitude, longitude: place.longitude, days: 1, current: true }, buddi.http);
      const c = forecast.current;
      const day = forecast.days[0];
      const now = c
        ? `${temperature(c.temperatureC, units)} (feels ${temperature(c.feelsLikeC, units)}), ${describeCode(c.code)}, ` +
          `wind ${speed(c.windKmh, units)}${c.gustKmh >= c.windKmh + 15 ? `, gusts ${speed(c.gustKmh, units)}` : ''}` +
          `${c.precipitationMm > 0 ? `, ${depth(c.precipitationMm, units)} in the last hour` : ''}`
        : 'not available';
      const today = day
        ? `high ${temperature(day.highC, units)}, low ${temperature(day.lowC, units)}, ${describeCode(day.code)}` +
          `${day.precipitationChance !== null ? `, ${day.precipitationChance}% chance of rain` : ''}`
        : 'not available';
      const tiles: WeatherTile[] = c
        ? [{
            icon: glyphOf(c.code, { ...(c.isDay === undefined ? {} : { isDay: c.isDay }), gustKmh: c.gustKmh, moonCloud: drawsMoonCloud(buddi.version) }),
            value: temperature(c.temperatureC, units),
            label: place.label,
            sky: `${capital(describeCode(c.code))}, feels ${degrees(c.feelsLikeC, units)}`,
            ...(day ? { rain: `High ${degrees(day.highC, units)}, low ${degrees(day.lowC, units)}` } : {}),
          }]
        : [];
      return { place: `${place.label} (${place.name})`, now, today, ...(note ? { note } : {}), tiles };
    }),
  };
}

const forecastInput = z
  .object({
    place: placeField,
    days: z.coerce.number().int().min(1).max(7).optional().describe('Days ahead, starting today. 3 when left out, at most 7.'),
  })
  .strict();

export interface ForecastOutput {
  place: string;
  days: string[];
  note?: string;
  /** The same days as cards, for the canvas. */
  tiles: WeatherTile[];
}

export function createForecastTool(service: WeatherService): ToolDefinition<z.infer<typeof forecastInput>, ForecastOutput | NotSetUp> {
  return {
    name: 'weather.forecast',
    description:
      'The forecast day by day for one of the owner\'s places (home when none is named) or any city, up to 7 days: ' +
      'high, low, sky, rain and strong wind. Use it before suggesting anything outdoors or when the owner asks about the coming days.',
    tier: 'auto',
    input: forecastInput,
    execute: (input, ctx) => unlessNotSetUp(async () => {
      const buddi = ctx.buddi!;
      const { place, note } = await resolvePlace(buddi, service, input.place);
      const { units } = await unitsFor(buddi);
      const forecast = await service.forecast({ latitude: place.latitude, longitude: place.longitude, days: input.days ?? 3 }, buddi.http);
      const wanted = forecast.days.slice(0, input.days ?? 3);
      const days = wanted.map((d) => {
        const rain = d.precipitationMm >= 1 ? `, ${depth(d.precipitationMm, units)} rain` : '';
        const chance = d.precipitationChance !== null && d.precipitationChance >= 30 ? ` (${d.precipitationChance}%)` : '';
        const wind = d.gustKmh >= 50 ? `, gusts ${speed(d.gustKmh, units)}` : '';
        return `${d.date}: ${describeCode(d.code)}, ${temperature(d.lowC, units)} to ${temperature(d.highC, units)}${rain}${chance}${wind}`;
      });
      const tiles = wanted.map((d, i) => dayTile(d, units, i === 0 ? 'Today' : weekdayOf(d.date)));
      return { place: `${place.label} (${place.name})`, days, ...(note ? { note } : {}), tiles };
    }),
  };
}

export function createPlacesTool(service: WeatherService): ToolDefinition<Record<string, never>, { places: string[]; units: string }> {
  return {
    name: 'weather.places',
    description: 'The places the owner saved for the weather, which one is home, and the units they read.',
    tier: 'auto',
    input: z.object({}).strict() as unknown as z.ZodType<Record<string, never>>,
    async execute(_input, ctx) {
      const buddi = ctx.buddi!;
      const { places } = await ensurePlaces(buddi, service);
      const { units } = await unitsFor(buddi);
      return {
        places: places.map((p) => `${p.label}: ${p.name}${p.isHome ? ' (home)' : ''}`),
        units,
      };
    },
  };
}
