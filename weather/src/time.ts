/**
 * Times the owner's way, and what the dashboard can draw.
 *
 * An hour of the strip reads "18:00" on a 24-hour clock and "6 PM" on a
 * 12-hour one; a sunrise reads "07:42" or "7:42 AM". Which one: the
 * placement's own Times, else the owner's Profile (Settings → Profile), else —
 * Profile on Auto — what buddi resolved from the browser for a widget, else
 * what the owner's language reads, else 24-hour.
 */
import type { BuddiHost } from '@buddi/core/plugin';

export type TimeFormat = '12h' | '24h';

const isFormat = (value: unknown): value is TimeFormat => value === '12h' || value === '24h';

/** The language's own clock: "en-US" runs to 12, "fr" to 24. Undefined for no tag or an unknown one. */
function formatOfLanguage(tag: string | undefined): TimeFormat | undefined {
  if (!tag) return undefined;
  try {
    const cycle = new Intl.DateTimeFormat(tag, { hour: 'numeric' }).resolvedOptions().hourCycle;
    return cycle === undefined ? undefined : cycle.startsWith('h1') ? '12h' : '24h';
  } catch {
    return undefined;
  }
}

/** The format to write times in: `picked` (a placement's resolved Times) when it says, else the owner's. */
export async function ownerTimeFormat(buddi: Pick<BuddiHost, 'owner'>, picked?: unknown): Promise<TimeFormat> {
  if (isFormat(picked)) return picked;
  try {
    const formats = await buddi.owner.formats?.();
    if (isFormat(formats?.time)) return formats.time;
    return formatOfLanguage(await buddi.owner.language()) ?? '24h';
  } catch {
    return '24h';
  }
}

/**
 * `2026-09-28T18:00` as a strip's label: "18:00", or "6 PM" — compact on a
 * 12-hour clock, the minutes only when there are some ("6:30 PM").
 */
export function hourLabel(local: string, format: TimeFormat): string {
  if (local.length < 16) return '';
  const hh = Number(local.slice(11, 13));
  const mm = local.slice(14, 16);
  if (format === '24h' || !Number.isFinite(hh)) return local.slice(11, 16);
  const h12 = hh % 12 === 0 ? 12 : hh % 12;
  return `${h12}${mm === '00' ? '' : `:${mm}`} ${hh < 12 ? 'AM' : 'PM'}`;
}

/** `2026-09-28T07:42` as a time of day: "07:42" or "7:42 AM"; nothing for nothing. */
export function clockLabel(local: string | undefined, format: TimeFormat): string {
  if (!local || local.length < 16) return '';
  if (format === '24h') return local.slice(11, 16);
  const hh = Number(local.slice(11, 13));
  const h12 = hh % 12 === 0 ? 12 : hh % 12;
  return `${h12}:${local.slice(14, 16)} ${hh < 12 ? 'AM' : 'PM'}`;
}

/** Whether this buddi draws the `moon-cloud` glyph (host API 1.22); an older one leaves it off, so it gets `cloud`. */
export function drawsMoonCloud(version: string | undefined): boolean {
  const m = /^(\d+)\.(\d+)/.exec(version ?? '');
  if (!m) return false;
  const major = Number(m[1]);
  return major > 1 || (major === 1 && Number(m[2]) >= 22);
}
