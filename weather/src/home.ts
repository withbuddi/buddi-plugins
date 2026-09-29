/**
 * The glance beside Home's date: the temperature and the sky at home, in the
 * owner's units — "18°C, overcast in Lyon" — opening Settings → Weather.
 *
 * Read-only, as Home asks: with no place saved there is no glance (home is
 * only ever derived from the timezone by a tool, which may write). Home reads
 * every fifteen seconds, so the answer is kept for ten minutes per place.
 */
import type { HomeGlance, HomeGlanceContribution } from '@buddi/core/plugin';
import { describeCode, glyphOf, type Forecast, type WeatherService } from './open-meteo.js';
import { listPlaces, unitsFor } from './places.js';
import { temperature } from './units.js';

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
        hit = { at: now, forecast: await service.forecast({ latitude: home.latitude, longitude: home.longitude, days: 1, current: true }, buddi.http) };
        cache.set(key, hit);
      }
      const c = hit.forecast.current;
      if (!c || !Number.isFinite(c.temperatureC)) return null;
      const city = home.name.split(',')[0]?.trim() || home.label;
      return {
        icon: glyphOf(c.code, { ...(c.isDay === undefined ? {} : { isDay: c.isDay }), gustKmh: c.gustKmh }),
        text: `${temperature(c.temperatureC, units)}, ${describeCode(c.code)} in ${city}`,
        link: { route: { page: 'settings' } },
      };
    },
  };
}
