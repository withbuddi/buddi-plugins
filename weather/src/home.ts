/**
 * Home's glance: the temperature and the sky at home, in the owner's units —
 * "18°C, overcast in Lyon" — opening the Weather page. It also carries the
 * card Home draws beside the greeting: the figure, the sky and the place, the
 * next twelve hours as a sparkline, today's high and low.
 *
 * Read-only, as Home asks: with no place saved there is no glance (home is
 * only ever derived from the timezone by a tool, which may write). Home reads
 * every fifteen seconds, so the answer is kept for ten minutes per place.
 */
import type { HomeGlance, HomeGlanceContribution } from '@buddi/core/plugin';
import { describeCode, glyphOf, type Forecast, type WeatherService } from './open-meteo.js';
import { listPlaces, unitsFor } from './places.js';
import { inUnits } from './page.js';
import { degrees, temperature } from './units.js';

/** How many hours the card's sparkline runs ahead. */
export const CARD_HOURS = 12;

const capital = (text: string): string => text.charAt(0).toUpperCase() + text.slice(1);

export const GLANCE_CACHE_MS = 10 * 60_000;

export function createWeatherGlance(service: WeatherService): HomeGlanceContribution {
  const cache = new Map<string, { at: number; forecast: Forecast }>();
  return {
    id: 'weather.now',
    title: 'Weather at home',
    placement: 'glance',
    async produce(ctx): Promise<HomeGlance | null> {
      const buddi = ctx.buddi!;
      const places = await listPlaces(buddi.db);
      const home = places.find((p) => p.isHome) ?? places[0];
      if (!home) return null;
      const { units } = await unitsFor(buddi);
      const key = `${home.latitude},${home.longitude}`;
      const now = buddi.clock.now().getTime();
      let hit = cache.get(key);
      if (!hit || now - hit.at >= GLANCE_CACHE_MS) {
        hit = { at: now, forecast: await service.forecast({ latitude: home.latitude, longitude: home.longitude, days: 2, current: true, hourly: true }, buddi.http) };
        cache.set(key, hit);
      }
      const c = hit.forecast.current;
      if (!c || !Number.isFinite(c.temperatureC)) return null;
      const city = home.name.split(',')[0]?.trim() || home.label;
      const { hours, days } = hit.forecast;
      // The next hours, from the hour it is now at the place.
      const nowHour = c.time.slice(0, 13);
      const from = Math.max(0, hours.findIndex((h) => h.local.startsWith(nowHour)));
      const points = hours.slice(from, from + CARD_HOURS).map((h) => inUnits(h.temperatureC, units)).filter(Number.isFinite);
      const day = days[0];
      return {
        icon: glyphOf(c.code, { ...(c.isDay === undefined ? {} : { isDay: c.isDay }), gustKmh: c.gustKmh }),
        text: `${temperature(c.temperatureC, units)}, ${describeCode(c.code)} in ${city}`,
        link: { route: { page: 'weather' } },
        card: {
          value: temperature(c.temperatureC, units),
          caption: `${capital(describeCode(c.code))} · ${city}`,
          ...(points.length >= 2 ? { trend: { label: `Next ${CARD_HOURS} hours`, points } } : {}),
          ...(day ? { foot: `High ${degrees(day.highC, units)} · Low ${degrees(day.lowC, units)}` } : {}),
        },
      };
    },
  };
}
