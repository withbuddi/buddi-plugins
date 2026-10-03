/**
 * Home's glance and widget: the temperature and the sky at home, in the
 * owner's units, opening the Weather page.
 *
 * The glance is the line beside the date — "18°C, overcast in Lyon". The
 * widget (host API 1.17) is the panel in Home's Widgets section, under the
 * same id, so the line steps aside while the widget is on Home; since 1.19
 * each placement picks its place (home by default, "Weather · Work"
 * otherwise) and its units (the plugin's by default): small, the
 * figure, the sky and the place, the next twelve hours as a sparkline and
 * today's high and low; medium, the same headline over a strip of the next
 * hours, each with the moon at night and its hour the owner's way ("6 PM" or
 * "18:00": the placement's Times, else the Profile). The glance still sends that small panel as its `card`, which is what
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
import { degrees, temperature, type Units } from './units.js';
import { drawsMoonCloud, hourLabel, ownerTimeFormat, type TimeFormat } from './time.js';

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

/** Which place and units a reading is for: a placement's settings, or home in the plugin's units. */
interface ReadFor {
  /** A place id from `listPlaces` (`profile-work`, a place of the plugin's own); home when blank or gone. */
  place?: string;
  units?: Units;
  /** The strip's hours; the owner's when left out. */
  time?: TimeFormat;
}

/** The weather now at a place, from a forecast kept for ten minutes per place; null with no place saved. */
function createHomeReader(service: WeatherService): (ctx: ToolContext, want?: ReadFor) => Promise<HomeNow | null> {
  const cache = new Map<string, { at: number; forecast: Forecast }>();
  return async (ctx, want = {}) => {
    const buddi = ctx.buddi!;
    const places = await listPlaces(buddi);
    const home = (want.place ? places.find((p) => p.id === want.place) : undefined) ?? places.find((p) => p.isHome) ?? places[0];
    if (!home) return null;
    const units = want.units ?? (await unitsFor(buddi)).units;
    const time = want.time ?? (await ownerTimeFormat(buddi));
    const moonCloud = drawsMoonCloud(buddi.version);
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
      icon: glyphOf(c.code, { ...(c.isDay === undefined ? {} : { isDay: c.isDay }), gustKmh: c.gustKmh, moonCloud }),
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
          label: hourLabel(h.local, time),
          icon: glyphOf(h.code, { ...(h.isDay === undefined ? {} : { isDay: h.isDay }), gustKmh: h.gustKmh, moonCloud }),
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
    title: 'Weather',
    sizes: ['small', 'medium'],
    refreshSeconds: GLANCE_CACHE_MS / 1000,
    link: { page: 'weather' },
    // Since host API 1.19: each placement picks its place and units ("Weather · Work").
    settings: [
      {
        key: 'place',
        kind: 'select',
        label: 'Place',
        inTitle: true,
        default: '',
        hint: 'Your places from Settings → Profile, and those you keep on the Weather page.',
        options: async (ctx) => {
          const places = await listPlaces(ctx.buddi!);
          return [{ value: '', label: 'Home' }, ...places.filter((p) => !p.isHome).map((p) => ({ value: p.id, label: p.label }))];
        },
      },
      {
        key: 'units',
        kind: 'select',
        label: 'Units',
        default: '',
        options: [{ value: '', label: 'As on Weather' }, { value: 'metric', label: '°C' }, { value: 'imperial', label: '°F' }],
      },
      // The hours under a medium widget: "6 PM" or "18:00". Handed over resolved: this pick, else the Profile.
      { key: 'time', kind: 'timeFormat', label: 'Times' },
    ],
    // Sample data for withbuddi.com and Browse (read by `buddi plugins describe`, never by the running host).
    preview: {
      small: { kind: 'stat', icon: 'sun', value: '18°C', caption: 'Sunny · Lyon', trend: { label: 'Next 12 hours', points: [18, 19, 21, 22, 22, 21, 19, 17, 15, 14, 13, 13] }, foot: 'High 22° · Low 11°' },
      medium: {
        kind: 'strip', icon: 'sun', value: '18°C', caption: 'Sunny · Lyon',
        items: [
          { label: '15:00', icon: 'sun', value: '21°' }, { label: '17:00', icon: 'sun', value: '22°' }, { label: '19:00', icon: 'partly-cloudy', value: '19°' },
          { label: '21:00', icon: 'moon-clear', value: '16°' }, { label: '23:00', icon: 'moon-cloud', value: '14°' }, { label: '01:00', icon: 'moon-clear', value: '13°' },
        ],
      },
    },
    async produce(ctx, request): Promise<WidgetBody | null> {
      const { size } = request;
      const settings = request.settings ?? {};
      const units = settings.units === 'metric' || settings.units === 'imperial' ? settings.units : undefined;
      const time = await ownerTimeFormat(ctx.buddi!, settings.time);
      const now = await read(ctx, { ...(typeof settings.place === 'string' && settings.place ? { place: settings.place } : {}), ...(units ? { units } : {}), time });
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
