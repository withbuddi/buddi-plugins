/**
 * What counts as severe, as fixed thresholds over the next 24 hours of the
 * hourly forecast. Pure: the sentinel fetches, this decides.
 *
 * Open-Meteo publishes no official warnings, so these follow the common
 * orange-level lines of national services, in metric.
 */
import type { Hour } from './open-meteo.js';
import { depth, snow, speed, temperature, type Units } from './units.js';

export const HEAVY_RAIN_MM_PER_HOUR = 10;
export const HEAVY_RAIN_MM_PER_DAY = 30;
export const HEAVY_SNOW_CM_PER_DAY = 10;
export const EXTREME_HEAT_C = 35;
export const EXTREME_COLD_C = -15;
export const STRONG_GUST_KMH = 75;
export const WINDOW_HOURS = 24;

export type SevereKind = 'thunderstorm' | 'heavy-rain' | 'heavy-snow' | 'extreme-heat' | 'extreme-cold' | 'strong-wind';

export interface SevereEvent {
  kind: SevereKind;
  /** The first hour it holds, in the place's local time. */
  startsLocal: string;
  /** The date part of that hour: the day the event is about. */
  date: string;
  /** The worst figure, in metric. */
  peak: number;
}

const THUNDER = new Set([95, 96, 99]);
const HEAVY_RAIN_CODES = new Set([65, 82]);
const HEAVY_SNOW_CODES = new Set([75, 86]);

/** The events in the 24 hours after `now`, one per kind, earliest hour first. */
export function severeEvents(hours: readonly Hour[], now: Date): SevereEvent[] {
  const from = now.getTime() - 60 * 60 * 1000;
  const to = now.getTime() + WINDOW_HOURS * 60 * 60 * 1000;
  const window = hours.filter((h) => h.at.getTime() > from && h.at.getTime() <= to);
  const events: SevereEvent[] = [];
  const first = (kind: SevereKind, holds: (h: Hour) => boolean, peak: (hs: Hour[]) => number): void => {
    const matching = window.filter(holds);
    const start = matching[0];
    if (start) events.push({ kind, startsLocal: start.local, date: start.local.slice(0, 10), peak: peak(matching) });
  };
  first('thunderstorm', (h) => THUNDER.has(h.code), () => 0);
  const rainTotal = window.reduce((sum, h) => sum + h.precipitationMm, 0);
  first(
    'heavy-rain',
    (h) => h.precipitationMm >= HEAVY_RAIN_MM_PER_HOUR || HEAVY_RAIN_CODES.has(h.code) || (rainTotal >= HEAVY_RAIN_MM_PER_DAY && h.precipitationMm > 0),
    () => rainTotal,
  );
  const snowTotal = window.reduce((sum, h) => sum + h.snowfallCm, 0);
  first(
    'heavy-snow',
    (h) => HEAVY_SNOW_CODES.has(h.code) || (snowTotal >= HEAVY_SNOW_CM_PER_DAY && h.snowfallCm > 0),
    () => snowTotal,
  );
  first('extreme-heat', (h) => h.temperatureC >= EXTREME_HEAT_C, (hs) => Math.max(...hs.map((h) => h.temperatureC)));
  first('extreme-cold', (h) => h.temperatureC <= EXTREME_COLD_C, (hs) => Math.min(...hs.map((h) => h.temperatureC)));
  first('strong-wind', (h) => h.gustKmh >= STRONG_GUST_KMH, (hs) => Math.max(...hs.map((h) => h.gustKmh)));
  return events.sort((a, b) => a.startsLocal.localeCompare(b.startsLocal));
}

/** The key that makes one event one message: the place, the kind, the day. */
export function eventKey(placeId: string, event: SevereEvent): string {
  return `${placeId}:${event.kind}:${event.date}`;
}

/** One line for the owner: "Thunderstorm at Home from 16:00 on 2026-09-28." */
export function describeEvent(event: SevereEvent, placeLabel: string, units: Units): { title: string; text: string } {
  const when = `from ${event.startsLocal.slice(11, 16)} on ${event.date}`;
  const what = ((): string => {
    switch (event.kind) {
      case 'thunderstorm': return 'Thunderstorms';
      case 'heavy-rain': return `Heavy rain, about ${depth(event.peak, units)} in 24 hours`;
      case 'heavy-snow': return `Heavy snow, about ${snow(event.peak, units)} in 24 hours`;
      case 'extreme-heat': return `Extreme heat, up to ${temperature(event.peak, units)}`;
      case 'extreme-cold': return `Extreme cold, down to ${temperature(event.peak, units)}`;
      case 'strong-wind': return `Strong wind, gusts to ${speed(event.peak, units)}`;
    }
  })();
  return {
    title: `${what.split(',')[0]} at ${placeLabel} ${when}`,
    text: `${what} at ${placeLabel}, ${when} (local time). From the Open-Meteo forecast; it can still change.`,
  };
}

/** Several events at one place, as one message: the first names them all, then one line each. */
export function describeEvents(events: readonly SevereEvent[], placeLabel: string, units: Units): { title: string; text: string } {
  if (events.length === 1) return describeEvent(events[0]!, placeLabel, units);
  const lines = events.map((e) => describeEvent(e, placeLabel, units));
  const names = lines.map((l) => l.title.split(' at ')[0]!);
  const listed = `${names.slice(0, -1).join(', ')} and ${names[names.length - 1]!.toLowerCase()}`;
  const first = events[0]!;
  return {
    title: `${listed} at ${placeLabel} from ${first.startsLocal.slice(11, 16)} on ${first.date}`,
    text: lines.map((l) => l.text).join('\n'),
  };
}
