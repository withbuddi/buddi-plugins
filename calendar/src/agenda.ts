/**
 * The Calendar place on the rail: the core `calendar` page component — a week
 * of hours, a month of days, or the days as a list — drawn from the same
 * ten-minute cache the tools read.
 *
 * One page query, `agenda { from?, to?, calendars? }`, answers everything the
 * page draws: whether a calendar is linked, the events between `from` and `to`
 * (dates in the owner's zone, `to` the day after the last; today and the six
 * days after it when left out), each with its calendar, that calendar's index
 * as its `tone` and its own colour, its place and a map link for it, its
 * notes, and a link to it in its calendar's own app; and a line naming a
 * calendar that could not be read. The page component asks again with a new
 * `from` and `to` as the owner moves through the weeks, writes the count
 * beside the range, and opens an event in a sheet (host API 1.28) whose Move
 * or change… and Cancel… open the corner chat with the request written in.
 * `calendars` (ids joined by commas) still narrows the answer for a caller.
 */
import { z } from 'zod';
import type { PageDescriptor, PageQuery } from '@buddi/core/plugin';
import type { Occurrence } from './ics.js';
import { listCalendars } from './store.js';
import { NO_CALENDAR, gather } from './tools.js';
import { addDays, dateIn, zonedTime } from './time.js';

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
  /** The calendar's own colour, `#rrggbb`, or empty. */
  color: string;
  /** The place on a map, an https address, or empty. */
  mapHref: string;
  notes: string;
  /** "Open in Google Calendar" and where, or empty. */
  openLabel: string;
  openHref: string;
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

/** A place as a map search: an https address the owner follows, never fetched. A call link is left as words. */
export function mapHrefOf(location: string): string {
  const place = location.trim();
  if (place === '' || /^(zoom|teams|meet|google meet|microsoft teams|phone|call)$/i.test(place) || /^https?:\/\//i.test(place)) return '';
  return `https://www.google.com/maps/search/?api=1&query=${encodeURIComponent(place)}`;
}

/** Where an event can be opened in its own app: Google's event page, or the calendar app of the account. */
function openOf(o: Occurrence, provider: string): { openLabel: string; openHref: string } {
  if (o.link) return { openLabel: 'Open in Google Calendar', openHref: o.link };
  if (provider === 'iCloud') return { openLabel: 'Open in iCloud', openHref: 'https://www.icloud.com/calendar/' };
  if (provider === 'Fastmail') return { openLabel: 'Open in Fastmail', openHref: 'https://app.fastmail.com/calendar/' };
  return { openLabel: '', openHref: '' };
}

/** An occurrence as the page's row. */
function toEvent(o: Occurrence, tone: number, color = '', provider = ''): AgendaEvent {
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
    color,
    mapHref: mapHrefOf(o.location ?? ''),
    notes: o.description ?? '',
    ...openOf(o, provider),
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
    const base = { linked: linked.length > 0 };
    if (linked.length === 0) return { ...base, message: NO_CALENDAR, events: [], problem: '' };

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
    const byName = new Map(linked.map((r, index) => [r.name, { index, row: r }]));
    const events = (found?.items ?? []).map((o) => {
      const at = byName.get(o.calendar);
      return toEvent(o, at?.index ?? 0, at?.row.color ?? '', at?.row.provider ?? '');
    });
    return { ...base, message: '', events, problem: (found?.problems ?? []).join(' ') };
  },
};

/** The events the calendar shows: the page adds `from` and `to`. */
const agendaRef = { query: 'agenda' };

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
      // Adding a calendar lives in Settings → Calendar; this is the one way there from here.
      kind: 'section',
      when: { path: 'linked', equals: false },
      body: [
        { kind: 'notice', text: { path: 'message' } },
        { kind: 'link', label: 'Link a calendar', to: { page: 'settings' } },
      ],
    },
    { kind: 'notice', when: { path: 'problem', equals: '', not: true }, text: { path: 'problem' }, tone: 'warning' },
    {
      kind: 'calendar',
      when: { path: 'linked', equals: true },
      query: agendaRef,
      events: 'events',
      map: { id: 'id', title: 'title', start: 'start', end: 'end', allDay: 'allDay', calendar: 'calendar', tone: 'tone', location: 'location' },
      views: ['week', 'month', 'list'],
      default: 'week',
      count: true,
      sheet: {
        notes: 'notes',
        color: 'color',
        mapHref: 'mapHref',
        open: { label: 'openLabel', href: 'openHref' },
        asks: [
          { label: 'Move or change…', text: 'Move or change “{title}” ({when}) in {calendar}: ' },
          { label: 'Cancel…', text: 'Cancel “{title}” ({when}) in {calendar}.' },
        ],
      },
      empty: 'Nothing.',
    },
  ],
};
