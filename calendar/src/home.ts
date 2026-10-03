/**
 * The glance beside Home's date: the next meeting today — "Next: Standup at
 * 09:30", or "at 9:30 AM" when the owner reads 12-hour. Nothing once today's meetings are over, nothing for all-day events,
 * and nothing with no calendar linked. The calendars are read through the
 * same ten-minute cache the tools use.
 */
import type { HomeGlance, HomeGlanceContribution, ToolContext, WidgetBody, WidgetDefinition } from '@buddi/core/plugin';
import { HOME_GLANCE_MAX_TEXT, gather } from './tools.js';
import { listCalendars } from './store.js';
import { addDays, dateIn, dayLabel, timeIn, zonedTime } from './time.js';

export const nextMeetingGlance: HomeGlanceContribution = {
  id: 'calendar.next',
  title: 'Next meeting today',
  placement: 'glance',
  async produce(ctx): Promise<HomeGlance | null> {
    const buddi = ctx.buddi!;
    const tz = buddi.owner.timezone;
    const now = buddi.clock.now();
    const date = dateIn(now, tz);
    const found = await gather(buddi, now, zonedTime(addDays(date, 1), '00:00', tz));
    const next = found?.items.find((o) => !o.allDay && o.start.getTime() >= now.getTime());
    if (!next) return null;
    const at = ` at ${clockIn(next.start, tz, await glanceFormat(buddi))}`;
    const room = HOME_GLANCE_MAX_TEXT - 'Next: '.length - at.length;
    const title = next.summary.length > room ? `${next.summary.slice(0, room - 1).trimEnd()}…` : next.summary;
    return { icon: 'calendar', text: `Next: ${title}${at}` };
  },
};

/**
 * The glance's time format: the owner's Profile, else — on Auto, where a
 * glance has no browser to ask — what their language reads, else 24-hour.
 */
export async function glanceFormat(buddi: Pick<NonNullable<ToolContext['buddi']>, 'owner'>): Promise<'12h' | '24h'> {
  try {
    const time = (await buddi.owner.formats?.())?.time;
    if (time === '12h' || time === '24h') return time;
    const tag = await buddi.owner.language();
    if (!tag) return '24h';
    return new Intl.DateTimeFormat(tag, { hour: 'numeric' }).resolvedOptions().hourCycle?.startsWith('h1') ? '12h' : '24h';
  } catch {
    return '24h';
  }
}

/** How many minutes Home keeps the day before asking again; the calendars themselves are cached for ten. */
export const TODAY_REFRESH_S = 300;

/** How far ahead an empty window looks for the next thing, to say when it is. */
export const NEXT_LOOKAHEAD_DAYS = 14;

/** "14:00", or "2:00 PM" when the placement (or the owner's Profile) reads 12-hour. */
export function clockIn(d: Date, timezone: string, format: unknown): string {
  if (format !== '12h') return timeIn(d, timezone);
  return new Intl.DateTimeFormat('en-US', { timeZone: timezone, hour: 'numeric', minute: '2-digit', hourCycle: 'h12' }).format(d);
}

const WINDOW_WORDS: Record<string, { empty: string; more: string }> = {
  '1': { empty: 'Free for the rest of today.', more: 'later today' },
  '2': { empty: 'Nothing else today or tomorrow.', more: 'by tomorrow night' },
  '7': { empty: 'A free week ahead.', more: 'this week' },
};

/**
 * Coming up (host API 1.17; settings since 1.19): what is left of the window
 * — today, two days or a week — as rows: the title, the day when it is not
 * today and where, the time or "All day", and how many more. Each placement
 * picks its calendars (none: all), how far ahead and its time format (the
 * owner's Profile by default). Read through the same cache as the tools; an
 * empty window says when the next thing is; with no calendar linked it says
 * where to link one.
 */
export const todayWidget: WidgetDefinition = {
  id: 'calendar.today',
  title: 'Coming up',
  sizes: ['medium', 'small'],
  refreshSeconds: TODAY_REFRESH_S,
  link: { page: 'agenda' },
  settings: [
    {
      key: 'calendars',
      kind: 'multiselect',
      label: 'Calendars',
      hint: 'None ticked: all of them.',
      options: async (ctx) => (await listCalendars(ctx.buddi!.db)).map((row) => ({ value: row.id, label: row.name })),
    },
    {
      key: 'days',
      kind: 'select',
      label: 'How far ahead',
      default: '2',
      options: [{ value: '1', label: 'Today' }, { value: '2', label: 'Two days' }, { value: '7', label: 'A week' }],
    },
    { key: 'time', kind: 'timeFormat', label: 'Times' },
  ],
  // Sample data for withbuddi.com and Browse (read by `buddi plugins describe`, never by the running host).
  preview: {
    medium: {
      kind: 'list',
      rows: [
        { title: 'Dinner with Ana', sub: 'Le Kitchen Café', side: '20:00' },
        { title: 'Team standup', sub: 'Tomorrow · Zoom', side: '09:30' },
        { title: 'Dentist', sub: 'Tomorrow · Dr Morel', side: '16:00' },
      ],
      more: '2 more by tomorrow night',
    },
    small: { kind: 'list', rows: [{ title: 'Dinner with Ana', side: '20:00' }, { title: 'Team standup', side: '09:30' }, { title: 'Dentist', side: '16:00' }] },
  },
  async produce(ctx, request): Promise<WidgetBody | null> {
    const buddi = ctx.buddi!;
    const settings = request.settings ?? {};
    const tz = buddi.owner.timezone;
    const now = buddi.clock.now();
    const today = dateIn(now, tz);
    const days = settings.days === '1' || settings.days === '7' ? Number(settings.days) : 2;
    const end = addDays(today, days);
    const linked = await listCalendars(buddi.db);
    const picked = Array.isArray(settings.calendars) ? new Set(settings.calendars as string[]) : new Set<string>();
    // Calendars since unlinked are no choice at all: every calendar, rather than an empty card.
    const only = [...picked].some((id) => linked.some((row) => row.id === id)) ? picked : undefined;
    const found = await gather(buddi, zonedTime(today, '00:00', tz), zonedTime(end, '00:00', tz), only);
    if (!found) return { kind: 'text', icon: 'calendar', text: 'Link a calendar on Settings → Calendar to see your day here.' };
    const dayOf = (o: (typeof found.items)[number]): string => (o.allDay ? o.startDate! : dateIn(o.start, tz));
    const ahead = found.items.filter((o) => {
      const day = dayOf(o);
      if (o.allDay) return (day >= today && day < end) || (o.startDate! < today && o.endDate! > today);
      return o.end.getTime() > now.getTime() && day >= today && day < end;
    });
    const words = WINDOW_WORDS[String(days)]!;
    if (ahead.length === 0) {
      // Say when the next thing is, so an empty card still answers "when am I busy?".
      const later = await gather(buddi, zonedTime(end, '00:00', tz), zonedTime(addDays(end, NEXT_LOOKAHEAD_DAYS), '00:00', tz), only);
      const next = later?.items[0];
      const when = next ? `${dayLabel(dayOf(next))}${next.allDay ? '' : ` ${clockIn(next.start, tz, settings.time)}`}` : '';
      return { kind: 'text', icon: 'calendar', text: words.empty, ...(next ? { sub: `Next: ${next.summary}, ${when}` } : {}) };
    }
    const tomorrow = addDays(today, 1);
    const rows = ahead.slice(0, 3).map((o) => {
      const day = dayOf(o);
      const label = day === today || (o.allDay && o.startDate! < today) ? undefined : day === tomorrow ? 'Tomorrow' : dayLabel(day).split(' ')[0];
      const sub = [label, o.location].filter(Boolean).join(' · ');
      return { title: o.summary, ...(sub ? { sub } : {}), side: o.allDay ? 'All day' : clockIn(o.start, tz, settings.time) };
    });
    const more = ahead.length - rows.length;
    return { kind: 'list', rows, ...(more > 0 ? { more: `${more} more ${words.more}` } : {}) };
  },
};
