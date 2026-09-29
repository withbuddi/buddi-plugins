/**
 * How the canvas draws the day: one card per event — the time, the title, and
 * the day or the place under it. With no calendar linked the tools answer a
 * `message`, drawn as one card linking to Settings → Calendar.
 */
import type { ViewDescriptor } from '@buddi/core/plugin';

const map = (empty: string) => ({
  items: 'tiles',
  icon: { const: 'calendar' as const },
  value: 'time',
  label: 'title',
  lines: ['day', 'where'],
  empty,
  notice: { text: 'message', icon: 'calendar' as const, link: { page: 'settings' } },
});

export const calendarViews: ViewDescriptor[] = [
  { tool: 'calendar.today', renderer: 'tiles', title: 'Today', map: map('Nothing on today.') },
  { tool: 'calendar.upcoming', renderer: 'tiles', title: 'Coming up', map: map('Nothing coming up.') },
];
