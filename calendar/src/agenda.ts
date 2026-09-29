/**
 * The Calendar place on the rail: the core `calendar` page component — a week
 * of hours, a month of days, or the days as a list — drawn from the same
 * ten-minute cache the tools read.
 *
 * One page query, `agenda { from?, to?, calendars? }`, answers everything the
 * page draws: whether a calendar is linked, which ones (for the filter), the
 * events between `from` and `to` (dates in the owner's zone, `to` the day
 * after the last; today and the six days after it when left out), each with
 * its calendar, that calendar's index as its `tone`, and its place, and a line
 * naming a calendar that could not be read. The page component asks again with
 * a new `from` and `to` as the owner moves through the weeks, and draws
 * "Nothing." on a day with nothing itself. `calendars` is the filter's choice
 * as the page sends it: ids joined by commas.
 */
import { z } from 'zod';
import type { PageDescriptor, PageQuery } from '@buddi/core/plugin';
import type { Occurrence } from './ics.js';
import { listCalendars } from './store.js';
import { NO_CALENDAR, gather } from './tools.js';
import { addDays, dateIn, dayLabel, zonedTime } from './time.js';

/** Today and the six days after it, when the page does not say. */
export const AGENDA_DAYS = 7;
/** The most the page may ask for at once: a month's six weeks, and room. */
export const AGENDA_MAX_DAYS = 62;

/** One event of the page, as the `calendar` component maps it. */
export interface AgendaEvent {
  id: string;
  title: string;
  /** An instant (ISO) for a timed event; a date for an all-day one. */
  start: string;
  /** For an all-day event, the day after its last. */
  end: string;
  allDay: boolean;
  calendar: string;
  /** The calendar's place in the linked list: which of the page's colours it wears. */
  tone: number;
  location: string;
}

const DATE = /^\d{4}-\d{2}-\d{2}$/;

const agendaParams = z
  .object({
    /** The first day shown, in the owner's zone; today when left out. */
    from: z.string().regex(DATE, 'a date, YYYY-MM-DD').optional(),
    /** The day after the last one shown; seven days on from `from` when left out. */
    to: z.string().regex(DATE, 'a date, YYYY-MM-DD').optional(),
    /** Calendar ids, joined by commas; every calendar when left out. */
    calendars: z.string().max(1000).optional(),
  })
  .strict();

/** How many days lie between two dates. */
function daysBetween(from: string, to: string): number {
  return Math.round((Date.parse(`${to}T00:00:00Z`) - Date.parse(`${from}T00:00:00Z`)) / 86_400_000);
}

/** "3 events over the next 7 days." — the line under the filter — or, for another range, "from … to …". */
function summaryOf(count: number, from: string, to: string, today: string): string {
  const events = `${count === 0 ? 'No' : count} ${count === 1 ? 'event' : 'events'}`;
  if (from === today) return `${events} over the next ${daysBetween(from, to)} days.`;
  return `${events} from ${dayLabel(from)} to ${dayLabel(addDays(to, -1))}.`;
}

/** An occurrence as the page's row. */
function toEvent(o: Occurrence, tone: number): AgendaEvent {
  const start = o.allDay && o.startDate ? o.startDate : o.start.toISOString();
  const end = o.allDay && o.endDate ? o.endDate : o.end.toISOString();
  return {
    // A recurring event repeats its uid: the start is what tells two apart.
    id: `${o.calendar}:${o.uid}:${start}`,
    title: o.summary,
    start,
    end,
    allDay: o.allDay,
    calendar: o.calendar,
    tone,
    location: o.location ?? '',
  };
}

export const agendaQuery: PageQuery = {
  name: 'agenda',
  params: agendaParams,
  async produce(raw, ctx) {
    const params = agendaParams.parse(raw);
    const buddi = ctx.buddi!;
    const tz = buddi.owner.timezone;
    const linked = await listCalendars(buddi.db);
    const calendars = linked.map((r) => ({ id: r.id, name: r.name }));
    const base = { linked: linked.length > 0, many: linked.length > 1, calendars };
    if (linked.length === 0) return { ...base, message: NO_CALENDAR, events: [], summary: [], problem: '' };

    const today = dateIn(buddi.clock.now(), tz);
    const from = params.from ?? today;
    const asked = params.to ?? addDays(from, AGENDA_DAYS);
    const span = daysBetween(from, asked);
    // A range the other way round is one day; a longer one is cut to what a month shows.
    const to = span < 1 ? addDays(from, 1) : span > AGENDA_MAX_DAYS ? addDays(from, AGENDA_MAX_DAYS) : asked;

    const chosen = (params.calendars ?? '').split(',').map((id) => id.trim()).filter(Boolean);
    const known = chosen.filter((id) => linked.some((r) => r.id === id));
    const only = known.length > 0 ? new Set(known) : undefined;
    const found = await gather(buddi, zonedTime(from, '00:00', tz), zonedTime(to, '00:00', tz), only);
    const tones = new Map(linked.map((r, index) => [r.name, index]));
    const events = (found?.items ?? []).map((o) => toEvent(o, tones.get(o.calendar) ?? 0));
    return {
      ...base,
      message: '',
      events,
      summary: [{ id: 'summary', text: summaryOf(events.length, from, to, today) }],
      problem: (found?.problems ?? []).join(' '),
    };
  },
};

/** The events on the page, and the filter's choice as their parameter. */
const agendaRef = { query: 'agenda', params: { calendars: { param: 'calendars' } } };

export const agendaPage: PageDescriptor = {
  id: 'agenda',
  title: 'Calendar',
  place: 'rail',
  icon: 'calendar',
  order: 20,
  data: { query: 'agenda' },
  body: [
    { kind: 'notice', text: 'Your linked calendars, by week, by month or as a list.' },
    {
      kind: 'section',
      when: { path: 'linked', equals: false },
      body: [
        { kind: 'notice', text: { path: 'message' } },
        { kind: 'link', label: 'Link a calendar', to: { page: 'settings' } },
      ],
    },
    { kind: 'notice', when: { path: 'problem', equals: '', not: true }, text: { path: 'problem' }, tone: 'warning' },
    {
      // A picker: the chosen calendars become the page's `calendars`
      // parameter, which the calendar below reads too.
      kind: 'search',
      when: { path: 'many', equals: true },
      auto: true,
      fields: [
        {
          name: 'calendars',
          label: 'Calendars',
          type: 'select',
          multiple: true,
          hint: 'Show only these. All of them when none is chosen.',
          optionsFrom: { query: { query: 'agenda' }, rows: 'calendars', value: 'id', label: 'name' },
        },
      ],
      query: agendaRef,
      rows: 'summary',
      results: { title: { path: 'text' } },
      empty: 'Nothing over the next days.',
    },
    {
      kind: 'calendar',
      when: { path: 'linked', equals: true },
      query: agendaRef,
      events: 'events',
      map: { id: 'id', title: 'title', start: 'start', end: 'end', allDay: 'allDay', calendar: 'calendar', tone: 'tone', location: 'location' },
      views: ['week', 'month', 'list'],
      default: 'week',
      empty: 'Nothing.',
    },
  ],
};
