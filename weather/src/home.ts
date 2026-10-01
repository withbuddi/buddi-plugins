/**
 * Home's glance and widget: the temperature and the sky at home, in the
 * owner's units, opening the Weather page.
 *
 * The glance is the line beside the date — "18°C, overcast in Lyon". The
 * widget (host API 1.17) is the panel in Home's Widgets section, under the
 * same id, so the line steps aside while the widget is on Home: small, the
 * figure, the sky and the place, the next twelve hours as a sparkline and
 * today's high and low; medium, the same headline over a strip of the next
 * hours. The glance still sends that small panel as its `card`, which is what
 * a buddi from before widgets draws beside the greeting.
 *
 * Read-only, as Home asks: with no place saved there is nothing (home is only
 * ever derived from the timezone by a tool, which may write). Home reads often,
 * so the forecast is kept for ten minutes per place, shared by both.
 */
import type { HomeGlance, HomeGlanceContribution, ToolContext, WidgetBody, WidgetDefinition } from '@buddi/core/plugin';
import { describeCode, glyphOf, type Forecast, type WeatherService } from './open-meteo.js';
import { listPlaces, unitsFor } from './places.js';
import { inUnits } from './page.js';
import { degrees, temperature } from './units.js';

/** How many hours the card's sparkline runs ahead. */
export const CARD_HOURS = 12;

const capital = (text: string): string => text.charAt(0).toUpperCase() + text.slice(1);

export const GLANCE_CACHE_MS = 10 * 60_000;

/** The strip's tiles on a medium widget: every other hour, six of them. */
export const STRIP_TILES = 6;

interface HomeNow {
  icon: HomeGlance['icon'];
  text: string;
  card: NonNullable<HomeGlance['card']>;
  tiles: Array<{ label: string; icon: HomeGlance['icon']; value: string }>;
}

/** The weather at home now, from a forecast kept for ten minutes per place; null with no place saved. */
function createHomeReader(service: WeatherService): (ctx: ToolContext) => Promise<HomeNow | null> {
  const cache = new Map<string, { at: number; forecast: Forecast }>();
  return async (ctx) => {
    const buddi = ctx.buddi!;
    const places = await listPlaces(buddi);
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
    const ahead = hours.slice(from, from + CARD_HOURS);
    const points = ahead.map((h) => inUnits(h.temperatureC, units)).filter(Number.isFinite);
    const day = days[0];
    return {
      icon: glyphOf(c.code, { ...(c.isDay === undefined ? {} : { isDay: c.isDay }), gustKmh: c.gustKmh }),
      text: `${temperature(c.temperatureC, units)}, ${describeCode(c.code)} in ${city}`,
      card: {
        value: temperature(c.temperatureC, units),
        caption: `${capital(describeCode(c.code))} · ${city}`,
        ...(points.length >= 2 ? { trend: { label: `Next ${CARD_HOURS} hours`, points } } : {}),
        ...(day ? { foot: `High ${degrees(day.highC, units)} · Low ${degrees(day.lowC, units)}` } : {}),
      },
      tiles: ahead
        .filter((_, i) => i % 2 === 0)
        .slice(0, STRIP_TILES)
        .filter((h) => Number.isFinite(h.temperatureC))
        .map((h) => ({
          label: h.local.slice(11, 16),
          icon: glyphOf(h.code, { ...(h.isDay === undefined ? {} : { isDay: h.isDay }), gustKmh: h.gustKmh }),
          value: degrees(h.temperatureC, units),
        })),
    };
  };
}

export function createWeatherHome(service: WeatherService): { glance: HomeGlanceContribution; widget: WidgetDefinition } {
  const read = createHomeReader(service);
  const glance: HomeGlanceContribution = {
    id: 'weather.now',
    title: 'Weather at home',
    placement: 'glance',
    async produce(ctx): Promise<HomeGlance | null> {
      const now = await read(ctx);
      if (!now) return null;
      return { icon: now.icon, text: now.text, link: { route: { page: 'weather' } }, card: now.card };
    },
  };
  const widget: WidgetDefinition = {
    id: 'weather.now',
    title: 'Weather at home',
    sizes: ['small', 'medium'],
    refreshSeconds: GLANCE_CACHE_MS / 1000,
    link: { page: 'weather' },
    async produce(ctx, { size }): Promise<WidgetBody | null> {
      const now = await read(ctx);
      if (!now) return { kind: 'text', icon: 'sun', text: 'Add your Home on Settings → Profile to see it here.' };
      if (size === 'medium' && now.tiles.length >= 2) {
        return { kind: 'strip', icon: now.icon, value: now.card.value, ...(now.card.caption ? { caption: now.card.caption } : {}), items: now.tiles };
      }
      return { kind: 'stat', icon: now.icon, ...now.card };
    },
  };
  return { glance, widget };
}

/** The glance alone, as before widgets. */
export function createWeatherGlance(service: WeatherService): HomeGlanceContribution {
  return createWeatherHome(service).glance;
}
