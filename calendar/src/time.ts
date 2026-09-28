/**
 * Dates and times in the owner's zone, with nothing but `Intl`: a local date
 * and clock for an instant, and the instant for a local date and clock.
 */

const parts = (d: Date, timezone: string): Record<string, string> =>
  Object.fromEntries(
    new Intl.DateTimeFormat('en-GB', {
      timeZone: timezone,
      year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit',
      hourCycle: 'h23',
    })
      .formatToParts(d)
      .map((p) => [p.type, p.value]),
  );

/** `YYYY-MM-DD` in the zone. */
export function dateIn(d: Date, timezone: string): string {
  const p = parts(d, timezone);
  return `${p.year}-${p.month}-${p.day}`;
}

/** `HH:MM` in the zone. */
export function timeIn(d: Date, timezone: string): string {
  const p = parts(d, timezone);
  return `${p.hour}:${p.minute}`;
}

/** The zone's offset from UTC at an instant, in milliseconds. */
function offsetAt(d: Date, timezone: string): number {
  const p = parts(d, timezone);
  const asUtc = Date.UTC(Number(p.year), Number(p.month) - 1, Number(p.day), Number(p.hour), Number(p.minute), Number(p.second));
  return asUtc - Math.floor(d.getTime() / 1000) * 1000;
}

/** The instant that is `date` at `time` (`HH:MM`) in the zone. */
export function zonedTime(date: string, time: string, timezone: string): Date {
  const [y, m, d] = date.split('-').map(Number) as [number, number, number];
  const [hh, mm] = time.split(':').map(Number) as [number, number];
  const guess = Date.UTC(y, m - 1, d, hh, mm);
  // Twice: once for the offset near the guess, once more across a DST edge.
  let at = guess - offsetAt(new Date(guess), timezone);
  at = guess - offsetAt(new Date(at), timezone);
  return new Date(at);
}

/** `date` plus `days`, as a date. */
export function addDays(date: string, days: number): string {
  const [y, m, d] = date.split('-').map(Number) as [number, number, number];
  return new Date(Date.UTC(y, m - 1, d + days)).toISOString().slice(0, 10);
}

const WEEKDAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

/** "Mon 28 Sep", the same on every ICU. */
export function dayLabel(date: string): string {
  const [y, m, d] = date.split('-').map(Number) as [number, number, number];
  const weekday = new Date(Date.UTC(y, m - 1, d)).getUTCDay();
  return `${WEEKDAYS[weekday]} ${d} ${MONTHS[m - 1]}`;
}

/** `today`, `tomorrow` or `YYYY-MM-DD`, as a date in the zone; undefined when it is none of those. */
export function parseDay(text: string, now: Date, timezone: string): string | undefined {
  const t = text.trim().toLowerCase();
  const today = dateIn(now, timezone);
  if (t === 'today') return today;
  if (t === 'tomorrow') return addDays(today, 1);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(t)) return undefined;
  const [y, m, d] = t.split('-').map(Number) as [number, number, number];
  const back = new Date(Date.UTC(y, m - 1, d)).toISOString().slice(0, 10);
  return back === t ? t : undefined;
}

/** "1 h 30", "45 min". */
export function duration(ms: number): string {
  const minutes = Math.round(ms / 60_000);
  const h = Math.floor(minutes / 60);
  const m = minutes % 60;
  if (h === 0) return `${m} min`;
  return m === 0 ? `${h} h` : `${h} h ${String(m).padStart(2, '0')}`;
}
