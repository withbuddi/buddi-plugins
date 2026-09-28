/** The Open-Meteo answers, shaped; the requests, as sent through the http area. No network. */
import { describe, expect, it } from 'vitest';
import type { HttpArea, HttpRequest } from '@buddi/core/plugin';
import { describeCode, openMeteo, toForecast, toPlaces } from './open-meteo.js';

/** Trimmed from a real geocoding answer. */
const GEOCODE = {
  results: [
    { id: 2988507, name: 'Paris', latitude: 48.85341, longitude: 2.3488, elevation: 42, feature_code: 'PPLC', country_code: 'FR', timezone: 'Europe/Paris', population: 2138551, country: 'France', admin1: 'Île-de-France' },
    { id: 4717560, name: 'Paris', latitude: 33.66094, longitude: -95.55551, timezone: 'America/Chicago', country: 'United States', admin1: 'Texas' },
    { id: 1, name: 'Broken' },
  ],
  generationtime_ms: 0.7,
};

/** Trimmed from a real forecast answer with timezone=auto. */
const FORECAST = {
  latitude: 48.86, longitude: 2.3399997, timezone: 'Europe/Paris', timezone_abbreviation: 'GMT+2', utc_offset_seconds: 7200,
  current: { time: '2026-09-28T14:00', interval: 900, temperature_2m: 17.6, apparent_temperature: 16.2, weather_code: 61, wind_speed_10m: 12.4, wind_gusts_10m: 35.3, precipitation: 0.4, relative_humidity_2m: 80 },
  daily: {
    time: ['2026-09-28', '2026-09-29'],
    weather_code: [61, 95],
    temperature_2m_max: [19.4, 22.1],
    temperature_2m_min: [11.8, 13.0],
    precipitation_sum: [3.2, 14.5],
    precipitation_probability_max: [70, 95],
    wind_gusts_10m_max: [35.3, 80.2],
  },
  hourly: {
    time: ['2026-09-28T14:00', '2026-09-28T15:00'],
    weather_code: [61, 95],
    temperature_2m: [17.6, 17.1],
    precipitation: [0.4, 12.1],
    snowfall: [0, 0],
    wind_gusts_10m: [35.3, 78],
    wind_speed_10m: [12.4, 30],
  },
};

function recordingHttp(answer: unknown, status = 200): { http: HttpArea; sent: HttpRequest[] } {
  const sent: HttpRequest[] = [];
  return {
    sent,
    http: {
      async request(req) {
        sent.push(req);
        return {
          ok: status < 400, status, statusText: '', headers: { get: () => null },
          text: async () => JSON.stringify(answer), json: async () => answer, arrayBuffer: async () => new ArrayBuffer(0),
        };
      },
    },
  };
}

describe('open-meteo', () => {
  it('shapes places, dropping a result without coordinates', () => {
    expect(toPlaces(GEOCODE)).toEqual([
      { name: 'Paris', latitude: 48.85341, longitude: 2.3488, timezone: 'Europe/Paris', country: 'France', admin1: 'Île-de-France' },
      { name: 'Paris', latitude: 33.66094, longitude: -95.55551, timezone: 'America/Chicago', country: 'United States', admin1: 'Texas' },
    ]);
    expect(toPlaces({})).toEqual([]);
    expect(toPlaces(null)).toEqual([]);
  });

  it('shapes a forecast, with each hour at its instant', () => {
    const f = toForecast(FORECAST);
    expect(f.timezone).toBe('Europe/Paris');
    expect(f.current).toMatchObject({ temperatureC: 17.6, code: 61, gustKmh: 35.3 });
    expect(f.days[1]).toEqual({ date: '2026-09-29', code: 95, highC: 22.1, lowC: 13, precipitationMm: 14.5, precipitationChance: 95, gustKmh: 80.2 });
    // 14:00 at UTC+2 is 12:00Z.
    expect(f.hours[0]!.at.toISOString()).toBe('2026-09-28T12:00:00.000Z');
    expect(f.hours[1]).toMatchObject({ local: '2026-09-28T15:00', code: 95, precipitationMm: 12.1, gustKmh: 78 });
  });

  it('asks through the http area, with no key, and says a failure plainly', async () => {
    const geo = recordingHttp(GEOCODE);
    expect((await openMeteo.geocode(' Paris ', geo.http))[0]?.name).toBe('Paris');
    const g = new URL(geo.sent[0]!.url);
    expect(g.host).toBe('geocoding-api.open-meteo.com');
    expect(g.searchParams.get('name')).toBe('Paris');

    const fc = recordingHttp(FORECAST);
    await openMeteo.forecast({ latitude: 48.85341, longitude: 2.3488, days: 3, current: true, hourly: true }, fc.http);
    const u = new URL(fc.sent[0]!.url);
    expect(u.host).toBe('api.open-meteo.com');
    expect(u.searchParams.get('latitude')).toBe('48.8534');
    expect(u.searchParams.get('timezone')).toBe('auto');
    expect(u.searchParams.get('forecast_days')).toBe('3');
    expect(u.searchParams.get('current')).toContain('temperature_2m');
    expect(u.searchParams.get('hourly')).toContain('snowfall');
    expect(fc.sent[0]!.auth).toBeUndefined();

    await expect(openMeteo.forecast({ latitude: 1, longitude: 1, days: 1 }, recordingHttp({}, 503).http)).rejects.toThrow(/answered 503/);
    await expect(openMeteo.geocode('x', undefined)).rejects.toThrow(/no http area/);
  });

  it('names the WMO codes in a few words', () => {
    expect(describeCode(0)).toBe('clear');
    expect(describeCode(65)).toBe('heavy rain');
    expect(describeCode(96)).toBe('thunderstorm with hail');
    expect(describeCode(undefined)).toBe('unknown');
  });
});
