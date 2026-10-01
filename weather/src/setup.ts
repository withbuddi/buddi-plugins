/**
 * Whether the weather can do anything yet, and the one export another plugin
 * may call (host API 1.18).
 *
 * `setup`: ready once there is a place — Home on the owner's profile, or one
 * kept here. Read-only, as buddi asks: home is only ever derived from the
 * timezone by a tool, which may write, so until then the Plugins row says
 * "Pick a place for the forecast" and opens Settings → Weather.
 *
 * `exports.forecast`: the forecast for one of the owner's places (by label or
 * id, home when none is named) or for coordinates, in the owner's units, for a
 * plugin that requires this one (a commute card, a garden). It reads, and
 * only reads: a place found by name is looked up and not saved.
 */
import { z } from 'zod';
import type { PluginExport, PluginSetup } from '@buddi/core/plugin';
import { describeCode, MAX_FORECAST_DAYS, type WeatherService } from './open-meteo.js';
import { displayName, listPlaces, unitsFor } from './places.js';
import { degrees } from './units.js';

export const weatherSetup: PluginSetup = {
  async produce(ctx) {
    const places = await listPlaces(ctx.buddi!);
    return places.length > 0 ? { ready: true } : { ready: false, note: 'Pick a place for the forecast.', page: 'settings' };
  },
};

const forecastParams = z
  .object({
    place: z.string().trim().min(1).max(120).optional(),
    latitude: z.number().min(-90).max(90).optional(),
    longitude: z.number().min(-180).max(180).optional(),
    days: z.number().int().min(1).max(MAX_FORECAST_DAYS).optional(),
  })
  .strict()
  .refine((p) => (p.latitude === undefined) === (p.longitude === undefined), { message: 'give both latitude and longitude, or neither' });

export interface ForecastExport {
  place: { label: string; name: string; latitude: number; longitude: number };
  units: 'metric' | 'imperial';
  timezone: string;
  current?: { temperature: string; sky: string; temperatureC: number; code: number };
  days: Array<{ date: string; high: string; low: string; sky: string; highC: number; lowC: number; precipitationChance: number | null; code: number }>;
}

export function createForecastExport(service: WeatherService): PluginExport {
  return {
    description: 'The forecast for one of the owner\'s places (by label or id, home when none is named) or for coordinates, in the owner\'s units.',
    params: forecastParams,
    async produce(params: z.infer<typeof forecastParams>, ctx): Promise<ForecastExport> {
      const buddi = ctx.buddi!;
      let place: ForecastExport['place'] | undefined;
      if (params.latitude !== undefined && params.longitude !== undefined) {
        place = { label: params.place ?? 'There', name: params.place ?? `${params.latitude.toFixed(2)}, ${params.longitude.toFixed(2)}`, latitude: params.latitude, longitude: params.longitude };
      } else {
        const places = await listPlaces(buddi);
        const wanted = params.place?.toLowerCase();
        const saved = wanted
          ? places.find((p) => p.label.toLowerCase() === wanted || p.id === wanted || p.id === `profile-${wanted}`) ??
            places.find((p) => p.name.toLowerCase().startsWith(wanted))
          : places.find((p) => p.isHome) ?? places[0];
        if (saved) place = saved;
        else if (params.place) {
          const found = (await service.geocode(params.place, buddi.http))[0];
          if (found) place = { label: found.name, name: displayName(found), latitude: found.latitude, longitude: found.longitude };
        }
      }
      if (!place) throw new Error(params.place ? `No place called "${params.place}".` : 'No place yet: the owner has not set Home.');
      const { units } = await unitsFor(buddi);
      const forecast = await service.forecast({ latitude: place.latitude, longitude: place.longitude, days: params.days ?? 3, current: true }, buddi.http);
      const c = forecast.current;
      return {
        place: { label: place.label, name: place.name, latitude: place.latitude, longitude: place.longitude },
        units,
        timezone: forecast.timezone,
        ...(c ? { current: { temperature: degrees(c.temperatureC, units), sky: describeCode(c.code), temperatureC: c.temperatureC, code: c.code } } : {}),
        days: forecast.days.map((d) => ({
          date: d.date,
          high: degrees(d.highC, units),
          low: degrees(d.lowC, units),
          sky: describeCode(d.code),
          highC: d.highC,
          lowC: d.lowC,
          precipitationChance: d.precipitationChance,
          code: d.code,
        })),
      };
    },
  };
}
