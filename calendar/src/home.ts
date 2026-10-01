/**
 * The glance beside Home's date: the next meeting today — "Next: Standup at
 * 09:30". Nothing once today's meetings are over, nothing for all-day events,
 * and nothing with no calendar linked. The calendars are read through the
 * same ten-minute cache the tools use.
 */
import type { HomeGlance, HomeGlanceContribution, WidgetBody, WidgetDefinition } from '@buddi/core/plugin';
import { HOME_GLANCE_MAX_TEXT, gather } from './tools.js';
import { addDays, dateIn, timeIn, zonedTime } from './time.js';

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
    const at = ` at ${timeIn(next.start, tz)}`;
    const room = HOME_GLANCE_MAX_TEXT - 'Next: '.length - at.length;
    const title = next.summary.length > room ? `${next.summary.slice(0, room - 1).trimEnd()}…` : next.summary;
    return { icon: 'calendar', text: `Next: ${title}${at}` };
  },
};

/** How many minutes Home keeps the day before asking again; the calendars themselves are cached for ten. */
export const TODAY_REFRESH_S = 300;

/**
 * The Today widget (host API 1.17): what is left of today, then tomorrow, as
 * rows — the title, where (and "Tomorrow" for tomorrow's), the time or "All
 * day" — and how many more. Read through the same cache as the tools; with no
 * calendar linked it says where to link one.
 */
export const todayWidget: WidgetDefinition = {
  id: 'calendar.today',
  title: 'Today',
  sizes: ['medium', 'small'],
  refreshSeconds: TODAY_REFRESH_S,
  link: { page: 'agenda' },
  async produce(ctx): Promise<WidgetBody | null> {
    const buddi = ctx.buddi!;
    const tz = buddi.owner.timezone;
    const now = buddi.clock.now();
    const today = dateIn(now, tz);
    const tomorrow = addDays(today, 1);
    const found = await gather(buddi, zonedTime(today, '00:00', tz), zonedTime(addDays(today, 2), '00:00', tz));
    if (!found) return { kind: 'text', icon: 'calendar', text: 'Link a calendar on Settings → Calendar to see your day here.' };
    const dayOf = (o: (typeof found.items)[number]): string => (o.allDay ? o.startDate! : dateIn(o.start, tz));
    const ahead = found.items.filter((o) => {
      const day = dayOf(o);
      if (o.allDay) return day === today || day === tomorrow || (o.startDate! < today && o.endDate! > today);
      return o.end.getTime() > now.getTime() && (day === today || day === tomorrow);
    });
    if (ahead.length === 0) {
      return { kind: 'text', icon: 'calendar', text: 'Nothing else today or tomorrow.' };
    }
    const rows = ahead.slice(0, 3).map((o) => {
      const later = dayOf(o) === tomorrow;
      const sub = [later ? 'Tomorrow' : undefined, o.location].filter(Boolean).join(' · ');
      return { title: o.summary, ...(sub ? { sub } : {}), side: o.allDay ? 'All day' : timeIn(o.start, tz) };
    });
    const more = ahead.length - rows.length;
    return { kind: 'list', rows, ...(more > 0 ? { more: `${more} more by tomorrow night` } : {}) };
  },
};
