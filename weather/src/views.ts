/**
 * How the canvas draws the weather: the forecast as one card per day, now as
 * one card. The tools write every value already formatted in the owner's
 * units (`tiles` in `tools.ts`); this only says which field goes where. A
 * tool that is not set up answers a `message`, drawn as one card that links
 * to Settings → Weather.
 */
import type { ViewDescriptor } from '@buddi/core/plugin';

const notice = { text: 'message', icon: 'partly-cloudy', link: { page: 'settings' } } as const;

const tiles = {
  items: 'tiles',
  icon: { path: 'icon' },
  value: 'value',
  label: 'label',
  lines: ['sky', 'rain'],
  empty: 'No forecast came back.',
  notice,
} as const;

export const weatherViews: ViewDescriptor[] = [
  { tool: 'weather.forecast', renderer: 'tiles', title: 'Forecast', map: { ...tiles, lines: [...tiles.lines] } },
  { tool: 'weather.now', renderer: 'tiles', title: 'Weather now', map: { ...tiles, lines: [...tiles.lines] } },
];
