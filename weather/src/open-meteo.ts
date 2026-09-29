/**
 * Open-Meteo: a place name to coordinates, and coordinates to a forecast. No
 * key, and nothing leaves but the name typed and a latitude and longitude.
 *
 * Every request goes through `ctx.buddi.http` (the shared transport, behind
 * the address guard), never the global `fetch`. The service is a port
 * (`WeatherService`), so the tools and the sentinel are tested against a stub
 * that opens no socket; the parsing is pure and tested on recorded answers.
 *
 * Open-Meteo publishes no official weather warnings, so severe weather is
 * read from the hourly forecast against fixed thresholds (`severe.ts`).
 */
import type { HttpArea } from '@buddi/core/plugin';

export const GEOCODING_URL = 'https://geocoding-api.open-meteo.com/v1/search';
export const FORECAST_URL = 'https://api.open-meteo.com/v1/forecast';
export const FETCH_TIMEOUT_MS = 10_000;

/** One answer to a place search. */
export interface GeocodedPlace {
  name: string;
  latitude: number;
  longitude: number;
  timezone?: string;
  country?: string;
  admin1?: string;
}

/** Now, in metric: °C, km/h, mm. */
export interface Current {
  time: string;
  temperatureC: number;
  feelsLikeC: number;
  code: number;
  windKmh: number;
  gustKmh: number;
  precipitationMm: number;
  humidity: number;
  /** False at night at the place, when the service said. */
  isDay?: boolean;
}

/** One day, in metric. `date` is the place's local date. */
export interface Day {
  date: string;
  code: number;
  highC: number;
  lowC: number;
  precipitationMm: number;
  precipitationChance: number | null;
  gustKmh: number;
  /** The strongest sustained wind of the day, when asked for. */
  windKmh?: number;
  /** The place's local time, `YYYY-MM-DDTHH:MM`, when asked for. */
  sunrise?: string;
  sunset?: string;
}

/** One hour, in metric, with its instant. */
export interface Hour {
  /** The place's local time, `YYYY-MM-DDTHH:MM`. */
  local: string;
  at: Date;
  code: number;
  temperatureC: number;
  precipitationMm: number;
  snowfallCm: number;
  gustKmh: number;
  windKmh: number;
  /** Chance of rain, 0–100, when asked for. */
  precipitationChance?: number | null;
  /** False at night at the place, when asked for. */
  isDay?: boolean;
}

export interface Forecast {
  timezone: string;
  current?: Current;
  days: Day[];
  hours: Hour[];
}

export interface ForecastQuery {
  latitude: number;
  longitude: number;
  days: number;
  current?: boolean;
  hourly?: boolean;
  /** The page's fuller read: the chance of rain and day or night each hour, the day's wind, sunrise and sunset. */
  detailed?: boolean;
}

/** The furthest ahead a forecast is asked for: the page's ten days. */
export const MAX_FORECAST_DAYS = 10;

/** The seam to the network. */
export interface WeatherService {
  geocode(query: string, http: HttpArea | undefined): Promise<GeocodedPlace[]>;
  forecast(query: ForecastQuery, http: HttpArea | undefined): Promise<Forecast>;
}

/** WMO weather codes in the few words a person wants. */
export function describeCode(code: number | undefined): string {
  switch (code) {
    case 0: return 'clear';
    case 1: return 'mostly clear';
    case 2: return 'partly cloudy';
    case 3: return 'overcast';
    case 45: case 48: return 'fog';
    case 51: case 53: case 55: return 'drizzle';
    case 56: case 57: return 'freezing drizzle';
    case 61: return 'light rain';
    case 63: return 'rain';
    case 65: return 'heavy rain';
    case 66: case 67: return 'freezing rain';
    case 71: return 'light snow';
    case 73: return 'snow';
    case 75: return 'heavy snow';
    case 77: return 'snow grains';
    case 80: return 'light showers';
    case 81: return 'showers';
    case 82: return 'violent showers';
    case 85: return 'snow showers';
    case 86: return 'heavy snow showers';
    case 95: return 'thunderstorm';
    case 96: case 99: return 'thunderstorm with hail';
    default: return 'unknown';
  }
}

/** The dashboard's pinned sky glyphs: what a tile or a glance can wear. */
export type SkyGlyph = 'sun' | 'moon-clear' | 'partly-cloudy' | 'cloud' | 'fog' | 'drizzle' | 'rain' | 'snow' | 'storm' | 'wind';

/**
 * A WMO code as one of the dashboard's glyphs. A clear sky at night is the
 * moon; a dry day with gusts of 50 km/h or more is the wind, because that is
 * what the owner will notice.
 */
export function glyphOf(code: number | undefined, opts: { isDay?: boolean; gustKmh?: number } = {}): SkyGlyph {
  const dry = code === undefined || code <= 3;
  if (dry && (opts.gustKmh ?? 0) >= 50) return 'wind';
  switch (code) {
    case 0: case 1: return opts.isDay === false ? 'moon-clear' : 'sun';
    case 2: return 'partly-cloudy';
    case 3: return 'cloud';
    case 45: case 48: return 'fog';
    case 51: case 53: case 55: case 56: case 57: return 'drizzle';
    case 61: case 63: case 65: case 66: case 67: case 80: case 81: case 82: return 'rain';
    case 71: case 73: case 75: case 77: case 85: case 86: return 'snow';
    case 95: case 96: case 99: return 'storm';
    default: return 'cloud';
  }
}

const num = (value: unknown, fallback = Number.NaN): number =>
  typeof value === 'number' && Number.isFinite(value) ? value : fallback;

/** The search answer, shaped. Pure. */
export function toPlaces(payload: unknown): GeocodedPlace[] {
  const results = (payload as { results?: unknown[] } | null)?.results;
  if (!Array.isArray(results)) return [];
  return results.flatMap((raw) => {
    const r = raw as Record<string, unknown>;
    const latitude = num(r.latitude);
    const longitude = num(r.longitude);
    if (typeof r.name !== 'string' || !Number.isFinite(latitude) || !Number.isFinite(longitude)) return [];
    return [{
      name: r.name,
      latitude,
      longitude,
      ...(typeof r.timezone === 'string' ? { timezone: r.timezone } : {}),
      ...(typeof r.country === 'string' ? { country: r.country } : {}),
      ...(typeof r.admin1 === 'string' ? { admin1: r.admin1 } : {}),
    }];
  });
}

/** `2026-09-28T14:00` at a fixed offset, as an instant. */
function instant(local: string, offsetSeconds: number): Date {
  return new Date(Date.parse(`${local}:00Z`) - offsetSeconds * 1000);
}

/** The forecast answer, shaped. Pure. */
export function toForecast(payload: unknown): Forecast {
  const p = (payload ?? {}) as Record<string, any>;
  const offset = num(p.utc_offset_seconds, 0);
  const c = p.current as Record<string, unknown> | undefined;
  const current: Current | undefined = c && typeof c.time === 'string'
    ? {
        time: c.time,
        temperatureC: num(c.temperature_2m),
        feelsLikeC: num(c.apparent_temperature),
        code: num(c.weather_code, -1),
        windKmh: num(c.wind_speed_10m, 0),
        gustKmh: num(c.wind_gusts_10m, 0),
        precipitationMm: num(c.precipitation, 0),
        humidity: num(c.relative_humidity_2m),
        ...(c.is_day === 0 || c.is_day === 1 ? { isDay: c.is_day === 1 } : {}),
      }
    : undefined;
  const d = (p.daily ?? {}) as Record<string, unknown[] | undefined>;
  const days: Day[] = (d.time ?? []).map((date, i) => ({
    date: String(date),
    code: num(d.weather_code?.[i], -1),
    highC: num(d.temperature_2m_max?.[i]),
    lowC: num(d.temperature_2m_min?.[i]),
    precipitationMm: num(d.precipitation_sum?.[i], 0),
    precipitationChance: typeof d.precipitation_probability_max?.[i] === 'number' ? (d.precipitation_probability_max[i] as number) : null,
    gustKmh: num(d.wind_gusts_10m_max?.[i], 0),
    ...(typeof d.wind_speed_10m_max?.[i] === 'number' ? { windKmh: d.wind_speed_10m_max[i] as number } : {}),
    ...(typeof d.sunrise?.[i] === 'string' ? { sunrise: d.sunrise[i] as string } : {}),
    ...(typeof d.sunset?.[i] === 'string' ? { sunset: d.sunset[i] as string } : {}),
  }));
  const h = (p.hourly ?? {}) as Record<string, unknown[] | undefined>;
  const hours: Hour[] = (h.time ?? []).map((local, i) => ({
    local: String(local),
    at: instant(String(local), offset),
    code: num(h.weather_code?.[i], -1),
    temperatureC: num(h.temperature_2m?.[i]),
    precipitationMm: num(h.precipitation?.[i], 0),
    snowfallCm: num(h.snowfall?.[i], 0),
    gustKmh: num(h.wind_gusts_10m?.[i], 0),
    windKmh: num(h.wind_speed_10m?.[i], 0),
    ...(h.precipitation_probability ? { precipitationChance: typeof h.precipitation_probability[i] === 'number' ? (h.precipitation_probability[i] as number) : null } : {}),
    ...(h.is_day?.[i] === 0 || h.is_day?.[i] === 1 ? { isDay: h.is_day[i] === 1 } : {}),
  }));
  return { timezone: typeof p.timezone === 'string' ? p.timezone : 'UTC', ...(current ? { current } : {}), days, hours };
}

async function getJson(http: HttpArea | undefined, url: URL): Promise<unknown> {
  if (http === undefined) throw new Error('weather: no http area, so no forecast (the manifest declares uses: http)');
  const response = await http.request({
    url: url.toString(),
    headers: { accept: 'application/json' },
    signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
    idleTimeoutMs: FETCH_TIMEOUT_MS,
    maxBytes: 2_000_000,
  });
  if (!response.ok) throw new Error(`The weather service answered ${response.status}; try again in a while.`);
  return response.json();
}

export const openMeteo: WeatherService = {
  async geocode(query, http) {
    const url = new URL(GEOCODING_URL);
    url.searchParams.set('name', query.trim());
    url.searchParams.set('count', '5');
    url.searchParams.set('language', 'en');
    url.searchParams.set('format', 'json');
    return toPlaces(await getJson(http, url));
  },
  async forecast(query, http) {
    const url = new URL(FORECAST_URL);
    url.searchParams.set('latitude', query.latitude.toFixed(4));
    url.searchParams.set('longitude', query.longitude.toFixed(4));
    // The place's own zone: its days are its days.
    url.searchParams.set('timezone', 'auto');
    url.searchParams.set('forecast_days', String(Math.min(Math.max(query.days, 1), MAX_FORECAST_DAYS)));
    url.searchParams.set(
      'daily',
      'weather_code,temperature_2m_max,temperature_2m_min,precipitation_sum,precipitation_probability_max,wind_gusts_10m_max' +
        (query.detailed ? ',wind_speed_10m_max,sunrise,sunset' : ''),
    );
    if (query.current) {
      url.searchParams.set(
        'current',
        'temperature_2m,apparent_temperature,weather_code,wind_speed_10m,wind_gusts_10m,precipitation,relative_humidity_2m,is_day',
      );
    }
    if (query.hourly || query.detailed) {
      url.searchParams.set(
        'hourly',
        'weather_code,temperature_2m,precipitation,snowfall,wind_gusts_10m,wind_speed_10m' +
          (query.detailed ? ',precipitation_probability,is_day' : ''),
      );
    }
    return toForecast(await getJson(http, url));
  },
};
