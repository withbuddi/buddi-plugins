/**
 * The glance beside Home's date: the next meeting today — "Next: Standup at
 * 09:30". Nothing once today's meetings are over, nothing for all-day events,
 * and nothing with no calendar linked. The calendars are read through the
 * same ten-minute cache the tools use.
 */
import type { HomeGlance, HomeGlanceContribution } from '@buddi/core/plugin';
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
