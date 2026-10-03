/**
 * Times as the owner reads them, in their zone: "06:10", "4 h ago",
 * "this morning", "yesterday evening", "Thursday evening", "Tue 08:00". The
 * page and the widget draw text the plugin already wrote; nothing here is a
 * date the browser formats.
 */

/** Local parts of an instant in a zone. */
function parts(at: Date, zone: string): { y: number; m: number; d: number; h: number; min: number; weekday: string; day: string } {
  const f = new Intl.DateTimeFormat('en-GB', {
    timeZone: zone, year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hourCycle: 'h23', weekday: 'long',
  });
  const p = Object.fromEntries(f.formatToParts(at).map((x) => [x.type, x.value]));
  return {
    y: Number(p.year), m: Number(p.month), d: Number(p.day), h: Number(p.hour), min: Number(p.minute), weekday: p.weekday ?? '',
    day: `${p.year}-${p.month}-${p.day}`,
  };
}

const pad = (n: number): string => String(n).padStart(2, '0');

/** "06:10" (24-hour), or "6:10 AM" when the owner reads 12-hour times. */
export function clock(at: Date, zone: string, format: '12h' | '24h' | null = null): string {
  const p = parts(at, zone);
  if (format === '12h') return `${p.h % 12 === 0 ? 12 : p.h % 12}:${pad(p.min)} ${p.h < 12 ? 'AM' : 'PM'}`;
  return `${pad(p.h)}:${pad(p.min)}`;
}

/** The calendar day an instant falls on in a zone, `YYYY-MM-DD`. */
export function dayOf(at: Date, zone: string): string {
  return parts(at, zone).day;
}

/** Days between two local dates, `b - a`. */
function daysBetween(a: string, b: string): number {
  return Math.round((Date.parse(`${b}T00:00:00Z`) - Date.parse(`${a}T00:00:00Z`)) / 86_400_000);
}

/** "45 min ago", "4 h ago", "2 d ago"; "just now" under a minute. */
export function ago(at: Date, now: Date): string {
  const minutes = Math.max(0, Math.floor((now.getTime() - at.getTime()) / 60_000));
  if (minutes < 1) return 'just now';
  if (minutes < 60) return `${minutes} min ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 48) return `${hours} h ago`;
  return `${Math.floor(hours / 24)} d ago`;
}

/** The short age a widget row carries: "45 min", "4 h", "2 d". */
export function shortAgo(at: Date, now: Date): string {
  return ago(at, now).replace(/ ago$/, '').replace('just now', 'now');
}

/** Morning before noon, afternoon before six, evening after; night before five in the morning. */
function partOfDay(hour: number): 'night' | 'morning' | 'afternoon' | 'evening' {
  if (hour < 5) return 'night';
  if (hour < 12) return 'morning';
  if (hour < 18) return 'afternoon';
  return 'evening';
}

/**
 * When something happened, in words: "this morning", "this evening",
 * "last night", "yesterday evening", "Thursday evening", and past a week
 * "on 24 Sep".
 */
export function whenWords(at: Date, now: Date, zone: string): string {
  const a = parts(at, zone);
  const n = parts(now, zone);
  const days = daysBetween(a.day, n.day);
  const part = partOfDay(a.h);
  if (days === 0) return part === 'night' ? 'last night' : `this ${part}`;
  if (days === 1) return part === 'night' ? 'on the night before last' : part === 'evening' ? 'yesterday evening' : `yesterday ${part}`;
  if (days < 7) return `${a.weekday} ${part === 'night' ? 'night' : part}`;
  return `on ${a.d} ${new Intl.DateTimeFormat('en-GB', { timeZone: zone, month: 'short' }).format(at)}`;
}

/** "06:10" today, "yesterday 18:05", "Thu 14:20" this week, "24 Sep 09:00" before. */
export function stamp(at: Date, now: Date, zone: string, format: '12h' | '24h' | null = null): string {
  const a = parts(at, zone);
  const days = daysBetween(a.day, parts(now, zone).day);
  const time = clock(at, zone, format);
  if (days === 0) return time;
  if (days === 1) return `yesterday ${time}`;
  if (days < 7) return `${a.weekday.slice(0, 3)} ${time}`;
  return `${a.d} ${new Intl.DateTimeFormat('en-GB', { timeZone: zone, month: 'short' }).format(at)} ${time}`;
}

/** "Sat 10 Oct": a day a mute lasts until. */
export function shortDate(at: Date, zone: string): string {
  return new Intl.DateTimeFormat('en-GB', { timeZone: zone, weekday: 'short', day: 'numeric', month: 'short' }).format(at).replace(',', '');
}

/** How far a zone's wall clock is ahead of UTC at an instant, in ms. */
function offsetMs(at: Date, zone: string): number {
  const p = parts(at, zone);
  return Date.UTC(p.y, p.m - 1, p.d, p.h, p.min) - Math.floor(at.getTime() / 60_000) * 60_000;
}

/** The local midnight that began the day `now` falls on, as an instant (the offset read at midnight, for DST). */
export function startOfDay(now: Date, zone: string): Date {
  const p = parts(now, zone);
  const midnight = Date.UTC(p.y, p.m - 1, p.d);
  const guess = midnight - offsetMs(now, zone);
  return new Date(midnight - offsetMs(new Date(guess), zone));
}

/** The next local midnight after `now`, as an instant. */
export function endOfDay(now: Date, zone: string): Date {
  return startOfDay(new Date(startOfDay(now, zone).getTime() + 26 * 3600_000), zone);
}

/** "FR" for French alone, "EN · FR" for both, nothing for English alone (the kit's rule). */
export function languageMark(languages: readonly string[]): string | undefined {
  const set = new Set(languages.map((l) => l.slice(0, 2).toLowerCase()));
  if (set.size > 1) return [...set].sort().map((l) => l.toUpperCase()).join(' · ');
  return set.has('fr') ? 'FR' : undefined;
}

/** "French", "English". */
export function languageName(language: string): string {
  return language.startsWith('fr') ? 'French' : 'English';
}
