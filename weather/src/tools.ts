/**
 * The three tools a model sees: now, the forecast, and the saved places. All
 * `auto` and read-only; the answers are short plain strings, because they are
 * read aloud in a brief or a chat line, not drawn as a table.
 */
import { z } from 'zod';
import type { ToolDefinition } from '@buddi/core/plugin';
import { describeCode, type WeatherService } from './open-meteo.js';
import { ensurePlaces, resolvePlace, unitsFor } from './places.js';
import { depth, speed, temperature } from './units.js';

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
}

export function createNowTool(service: WeatherService): ToolDefinition<z.infer<typeof nowInput>, NowOutput> {
  return {
    name: 'weather.now',
    description:
      'The weather right now at one of the owner\'s places (home when none is named) or any city: temperature, ' +
      'sky, wind, and today\'s high and low. Use it when the owner asks about the weather now or today.',
    tier: 'auto',
    input: nowInput,
    async execute(input, ctx) {
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
      return { place: `${place.label} (${place.name})`, now, today, ...(note ? { note } : {}) };
    },
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
}

export function createForecastTool(service: WeatherService): ToolDefinition<z.infer<typeof forecastInput>, ForecastOutput> {
  return {
    name: 'weather.forecast',
    description:
      'The forecast day by day for one of the owner\'s places (home when none is named) or any city, up to 7 days: ' +
      'high, low, sky, rain and strong wind. Use it before suggesting anything outdoors or when the owner asks about the coming days.',
    tier: 'auto',
    input: forecastInput,
    async execute(input, ctx) {
      const buddi = ctx.buddi!;
      const { place, note } = await resolvePlace(buddi, service, input.place);
      const { units } = await unitsFor(buddi);
      const forecast = await service.forecast({ latitude: place.latitude, longitude: place.longitude, days: input.days ?? 3 }, buddi.http);
      const days = forecast.days.slice(0, input.days ?? 3).map((d) => {
        const rain = d.precipitationMm >= 1 ? `, ${depth(d.precipitationMm, units)} rain` : '';
        const chance = d.precipitationChance !== null && d.precipitationChance >= 30 ? ` (${d.precipitationChance}%)` : '';
        const wind = d.gustKmh >= 50 ? `, gusts ${speed(d.gustKmh, units)}` : '';
        return `${d.date}: ${describeCode(d.code)}, ${temperature(d.lowC, units)} to ${temperature(d.highC, units)}${rain}${chance}${wind}`;
      });
      return { place: `${place.label} (${place.name})`, days, ...(note ? { note } : {}) };
    },
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
