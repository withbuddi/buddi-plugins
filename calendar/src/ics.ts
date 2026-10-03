/**
 * ICS to occurrences. `node-ical` (Apache-2.0) parses the file and expands
 * recurrence rules with their exceptions (EXDATE) and moved or changed
 * instances (RECURRENCE-ID), in each event's own zone (a TZID, a Windows zone
 * name from Outlook, or UTC). What comes out is one list of occurrences in a
 * window, as instants, with all-day events kept as dates.
 */
import ical, { type VEvent } from 'node-ical';
import { addDays, zonedTime } from './time.js';

export interface Occurrence {
  calendar: string;
  uid: string;
  summary: string;
  location?: string;
  description?: string;
  start: Date;
  end: Date;
  allDay: boolean;
  /** For an all-day event: its first date and the date after its last. */
  startDate?: string;
  endDate?: string;
  /** Counts against free time: timed, not cancelled, not marked free. */
  busy: boolean;
  /** The calendar's id, set by whoever gathered it. */
  calendarId?: string;
  /** Its calendar lets agents change events: it may be named to the write tools. */
  writable?: boolean;
  /** It is one occurrence of a repeating event. */
  recurring?: boolean;
}



/** The events of one file. A file that is not a calendar throws, saying so. */
export function parseIcs(text: string): VEvent[] {
  if (!/BEGIN:VCALENDAR/i.test(text.slice(0, 2048))) {
    throw new Error('That address did not answer with a calendar (no BEGIN:VCALENDAR).');
  }
  const data = ical.sync.parseICS(text);
  return Object.values(data).filter((c): c is VEvent => (c as { type?: string } | undefined)?.type === 'VEVENT');
}

/** A date-only value is local midnight in this process's zone: its local parts are the date. */
function localDate(d: Date): string {
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

const text = (value: unknown): string | undefined => {
  if (typeof value === 'string') return value.trim() || undefined;
  if (value && typeof value === 'object' && 'val' in value && typeof (value as { val: unknown }).val === 'string') {
    return ((value as { val: string }).val).trim() || undefined;
  }
  return undefined;
};

/**
 * Every occurrence that overlaps `[from, to)`, sorted by start. All-day events
 * are placed on their dates in the owner's zone.
 */
export function occurrences(events: readonly VEvent[], from: Date, to: Date, timezone: string, calendar: string): Occurrence[] {
  const out: Occurrence[] = [];
  // A day wider on each side: a date-only value is midnight in this process's
  // zone, not the owner's; the exact overlap is checked below.
  const wideFrom = new Date(from.getTime() - 86_400_000);
  const wideTo = new Date(to.getTime() + 86_400_000);
  for (const event of events) {
    if (!(event.start instanceof Date)) continue;
    let instances: ReturnType<typeof ical.expandRecurringEvent>;
    try {
      instances = ical.expandRecurringEvent(event, { from: wideFrom, to: wideTo, expandOngoing: true });
    } catch {
      continue;
    }
    for (const instance of instances) {
      const source = (instance.event ?? event) as VEvent;
      if (String(source.status ?? '').toUpperCase() === 'CANCELLED') continue;
      const allDay = instance.isFullDay === true;
      let start: Date;
      let end: Date;
      let startDate: string | undefined;
      let endDate: string | undefined;
      if (allDay) {
        startDate = localDate(instance.start);
        const lastExclusive = instance.end instanceof Date ? localDate(instance.end) : addDays(startDate, 1);
        endDate = lastExclusive > startDate ? lastExclusive : addDays(startDate, 1);
        start = zonedTime(startDate, '00:00', timezone);
        end = zonedTime(endDate, '00:00', timezone);
      } else {
        start = instance.start;
        end = instance.end instanceof Date && instance.end.getTime() > start.getTime() ? instance.end : start;
      }
      const overlaps = end.getTime() > from.getTime() && start.getTime() < to.getTime();
      const instant = end.getTime() === start.getTime() && start.getTime() >= from.getTime() && start.getTime() < to.getTime();
      if (!overlaps && !instant) continue;
      const summary = text(instance.summary) ?? text(source.summary) ?? '(no title)';
      const location = text(source.location);
      const description = text(source.description);
      out.push({
        calendar,
        uid: String(source.uid ?? event.uid ?? ''),
        summary,
        ...(location ? { location } : {}),
        ...(description ? { description } : {}),
        start,
        end,
        allDay,
        ...(startDate ? { startDate, endDate } : {}),
        busy: !allDay && String(source.transparency ?? '').toUpperCase() !== 'TRANSPARENT',
        ...(event.rrule ? { recurring: true } : {}),
      });
    }
  }
  return out.sort((a, b) => a.start.getTime() - b.start.getTime() || Number(b.allDay) - Number(a.allDay) || a.summary.localeCompare(b.summary));
}
