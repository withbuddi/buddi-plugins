/**
 * Metric or imperial, and the few numbers a person reads, written plainly.
 * Everything is fetched in metric and converted here, so the rules in
 * `severe.ts` have one set of thresholds.
 */
export type Units = 'metric' | 'imperial';

/** Where Fahrenheit and miles are what people read. */
const IMPERIAL_REGIONS = new Set(['US', 'LR', 'MM', 'PR', 'GU', 'VI', 'AS', 'MP', 'BS', 'BZ', 'KY', 'PW', 'FM', 'MH']);

/** The zones of the United States, for an owner whose language names no region. */
const US_ZONE = /^(America\/(New_York|Chicago|Denver|Los_Angeles|Phoenix|Anchorage|Juneau|Sitka|Nome|Yakutat|Metlakatla|Adak|Boise|Detroit|Indiana\/.+|Kentucky\/.+|North_Dakota\/.+|Menominee)|Pacific\/Honolulu|US\/.+)$/;

/**
 * The owner's units when they chose none: the region of the language they
 * answer in (`en-US`), else the zone they live in, else metric.
 */
export function defaultUnits(language: string | undefined, timezone: string): Units {
  const region = language?.split(/[-_]/)[1]?.toUpperCase();
  if (region !== undefined && region.length === 2) return IMPERIAL_REGIONS.has(region) ? 'imperial' : 'metric';
  return US_ZONE.test(timezone) ? 'imperial' : 'metric';
}

const round = (n: number): number => Math.round(n);

export function temperature(celsius: number, units: Units): string {
  if (!Number.isFinite(celsius)) return '?';
  return units === 'imperial' ? `${round(celsius * 9 / 5 + 32)}°F` : `${round(celsius)}°C`;
}

export function speed(kmh: number, units: Units): string {
  return units === 'imperial' ? `${round(kmh / 1.609344)} mph` : `${round(kmh)} km/h`;
}

export function depth(mm: number, units: Units): string {
  if (units === 'imperial') {
    const inches = mm / 25.4;
    return `${inches < 1 ? inches.toFixed(2) : inches.toFixed(1)} in`;
  }
  return `${mm < 10 ? mm.toFixed(1) : round(mm)} mm`;
}

export function snow(cm: number, units: Units): string {
  return units === 'imperial' ? `${(cm / 2.54).toFixed(1)} in` : `${cm < 10 ? cm.toFixed(1) : round(cm)} cm`;
}
