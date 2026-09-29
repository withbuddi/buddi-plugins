/**
 * The Calendar place on the rail: today first, then the days after it, one
 * group per day, from the same ten-minute cache the tools read.
 *
 * One page query, `agenda { days?, calendars? }`, answers everything the page
 * draws: whether a calendar is linked, which ones (for the filter), each day's
 * events as rows (all-day first, then by time), a "Nothing." row for an empty
 * day, and a line naming a calendar that could not be read. `calendars` is the
 * filter's choice as the page sends it: ids joined by commas.
 */
import { z } from 'zod';
import type { PageDescriptor, PageQuery } from '@buddi/core/plugin';
import type { Occurrence } from './ics.js';
import { listCalendars } from './store.js';
import { NO_CALENDAR, gather } from './tools.js';
import { addDays, dateIn, dayLabel, timeIn, zonedTime } from './time.js';

/** Today and the seven days after it. */
export const AGENDA_DAYS = 8;

/** One row of the page: an event on a day, or the day's "Nothing.". */
export interface AgendaRow {
  id: string;
  /** The group it is drawn under: "Today · Mon 28 Sep". */
  day: string;
  date: string;
  time: string;
  title: string;
  where: string;
  calendar: string;
}

/** "Today · Mon 28 Sep", "Tomorrow · Tue 29 Sep", then "Wed 30 Sep". */
export function agendaDayLabel(date: string, index: number): string {
  if (index === 0) return `Today · ${dayLabel(date)}`;
  if (index === 1) return `Tomorrow · ${dayLabel(date)}`;
  return dayLabel(date);
}

/**
 * The time an occurrence takes on one day: "09:30–10:00", "All day", or, for
 * one that crosses midnight, "from 22:00" and "until 02:00".
 */
export function rangeOn(o: Occurrence, date: string, timezone: string): string {
  if (o.allDay) return 'All day';
  const startsBefore = dateIn(o.start, timezone) < date;
  const endsAfter = dateIn(o.end, timezone) > date;
  if (startsBefore && endsAfter) return 'All day';
  if (startsBefore) return `until ${timeIn(o.end, timezone)}`;
  if (endsAfter) return `from ${timeIn(o.start, timezone)}`;
  const start = timeIn(o.start, timezone);
  return o.end.getTime() === o.start.getTime() ? start : `${start}–${timeIn(o.end, timezone)}`;
}

const agendaParams = z
  .object({
    days: z.coerce.number().int().min(1).max(14).optional(),
    /** Calendar ids, joined by commas; every calendar when left out. */
    calendars: z.string().max(1000).optional(),
  })
  .strict();

/** "3 events over the next 8 days." — the line under the filter. */
function summaryOf(count: number, days: number): string {
  return `${count === 0 ? 'No' : count} ${count === 1 ? 'event' : 'events'} over the next ${days} days.`;
}

export const agendaQuery: PageQuery = {
  name: 'agenda',
  params: agendaParams,
  async produce(raw, ctx) {
    const params = agendaParams.parse(raw);
    const buddi = ctx.buddi!;
    const tz = buddi.owner.timezone;
    const count = params.days ?? AGENDA_DAYS;
    const linked = await listCalendars(buddi.db);
    const calendars = linked.map((r) => ({ id: r.id, name: r.name }));
    const base = { linked: linked.length > 0, many: linked.length > 1, calendars };
    if (linked.length === 0) return { ...base, message: NO_CALENDAR, events: [], summary: [], problem: '' };

    const asked = (params.calendars ?? '').split(',').map((id) => id.trim()).filter(Boolean);
    const known = asked.filter((id) => linked.some((r) => r.id === id));
    const only = known.length > 0 ? new Set(known) : undefined;
    const today = dateIn(buddi.clock.now(), tz);
    const found = await gather(buddi, zonedTime(today, '00:00', tz), zonedTime(addDays(today, count), '00:00', tz), only);
    const items = found?.items ?? [];

    const events: AgendaRow[] = [];
    let total = 0;
    for (let i = 0; i < count; i++) {
      const date = addDays(today, i);
      const day = agendaDayLabel(date, i);
      const from = zonedTime(date, '00:00', tz).getTime();
      const to = zonedTime(addDays(date, 1), '00:00', tz).getTime();
      const on = items
        .filter((o) => {
          const s = o.start.getTime();
          const e = o.end.getTime();
          return (s < to && e > from) || (s === e && s >= from && s < to);
        })
        .sort((a, b) => Number(b.allDay) - Number(a.allDay) || a.start.getTime() - b.start.getTime());
      if (on.length === 0) {
        events.push({ id: `${date}:none`, day, date, time: '', title: 'Nothing.', where: '', calendar: '' });
        continue;
      }
      total += on.length;
      on.forEach((o, n) =>
        events.push({
          id: `${date}:${n}`,
          day,
          date,
          time: rangeOn(o, date, tz),
          title: o.summary,
          where: o.location ?? '',
          calendar: o.calendar ?? '',
        }),
      );
    }
    return {
      ...base,
      message: '',
      events,
      summary: [{ id: 'summary', text: summaryOf(total, count) }],
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
    { kind: 'notice', text: 'Today and the week ahead, from your linked calendars.' },
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
      // parameter, which the day list below reads too.
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
      kind: 'list',
      when: { path: 'linked', equals: true },
      query: agendaRef,
      rows: 'events',
      key: 'id',
      groupBy: { key: 'day' },
      item: { title: { path: 'title' }, sub: { path: 'where' }, meta: [{ path: 'time' }, { path: 'calendar' }] },
      empty: 'Nothing.',
    },
  ],
};
