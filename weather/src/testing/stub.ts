/** A weather service that opens no socket: canned places and forecasts, and what it was asked. */
import type { Forecast, ForecastQuery, GeocodedPlace, Hour, WeatherService } from '../open-meteo.js';

export const PARIS: GeocodedPlace = { name: 'Paris', latitude: 48.8534, longitude: 2.3488, timezone: 'Europe/Paris', country: 'France', admin1: 'Île-de-France' };
export const LYON: GeocodedPlace = { name: 'Lyon', latitude: 45.7485, longitude: 4.8467, timezone: 'Europe/Paris', country: 'France', admin1: 'Auvergne-Rhône-Alpes' };

/** Hours from `start` (UTC), each shaped by `shape(i)`. */
export function hoursFrom(start: Date, count: number, shape: (i: number) => Partial<Hour> = () => ({})): Hour[] {
  return Array.from({ length: count }, (_, i) => {
    const at = new Date(start.getTime() + i * 3_600_000);
    return {
      local: at.toISOString().slice(0, 16),
      at,
      code: 1,
      temperatureC: 18,
      precipitationMm: 0,
      snowfallCm: 0,
      gustKmh: 20,
      windKmh: 10,
      ...shape(i),
    };
  });
}

export function stubService(opts: { places?: Record<string, GeocodedPlace[]>; forecast?: (q: ForecastQuery) => Forecast } = {}) {
  const asked: { geocode: string[]; forecast: ForecastQuery[] } = { geocode: [], forecast: [] };
  const service: WeatherService = {
    async geocode(query) {
      asked.geocode.push(query);
      return opts.places?.[query.toLowerCase()] ?? [];
    },
    async forecast(query) {
      asked.forecast.push(query);
      return opts.forecast?.(query) ?? {
        timezone: 'Europe/Paris',
        current: { time: '2026-09-28T14:00', temperatureC: 17.6, feelsLikeC: 16.2, code: 61, windKmh: 12, gustKmh: 35, precipitationMm: 0.4, humidity: 80 },
        days: [
          { date: '2026-09-28', code: 61, highC: 19.4, lowC: 11.8, precipitationMm: 3.2, precipitationChance: 70, gustKmh: 35 },
          { date: '2026-09-29', code: 2, highC: 21, lowC: 12, precipitationMm: 0, precipitationChance: 10, gustKmh: 20 },
          { date: '2026-09-30', code: 95, highC: 24, lowC: 15, precipitationMm: 12, precipitationChance: 90, gustKmh: 60 },
        ],
        hours: [],
      };
    },
  };
  return { service, asked };
}
