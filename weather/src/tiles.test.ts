/** The canvas side of the weather: glyphs from WMO codes, a day as a card, and the views passing core's checks. */
import { describe, expect, it } from 'vitest';
import { parseViewDescriptors } from '@buddi/core/plugin';
import { glyphOf } from './open-meteo.js';
import { dayTile, weekdayOf } from './tools.js';
import { manifest } from './index.js';

describe('weather tiles', () => {
  it('maps the WMO codes onto the pinned glyphs', () => {
    expect([0, 1, 2, 3, 45, 53, 57, 63, 81, 73, 86, 95, 99, 42].map((code) => glyphOf(code))).toEqual([
      'sun', 'sun', 'partly-cloudy', 'cloud', 'fog', 'drizzle', 'drizzle', 'rain', 'rain', 'snow', 'snow', 'storm', 'storm', 'cloud',
    ]);
    expect(glyphOf(0, { isDay: false })).toBe('moon-clear');
    expect(glyphOf(2, { gustKmh: 60 })).toBe('wind');
    expect(glyphOf(63, { gustKmh: 60 })).toBe('rain');
  });

  it('writes a day in the owner units, rain only when there is some', () => {
    const day = { date: '2026-09-29', code: 61, highC: 18, lowC: 12.6, precipitationMm: 5, precipitationChance: 80, gustKmh: 20 };
    expect(dayTile(day, 'imperial', weekdayOf(day.date))).toEqual({ icon: 'rain', value: '64° / 55°', label: 'Tuesday', sky: 'Light rain', rain: '80% chance · 0.20 in' });
    expect(dayTile({ ...day, code: 0, precipitationMm: 0, precipitationChance: 0 }, 'metric', 'Today')).toEqual({ icon: 'sun', value: '18° / 13°', label: 'Today', sky: 'Clear' });
  });

  it('declares tile views for now and the forecast that core accepts, and a glance', () => {
    expect(manifest.views?.map((v) => [v.tool, v.renderer])).toEqual([['weather.forecast', 'tiles'], ['weather.now', 'tiles']]);
    expect(() => parseViewDescriptors(manifest.views!, { plugin: 'weather', tools: manifest.tools.map((t) => t.name), pages: ['settings'] })).not.toThrow();
    expect(manifest.home?.map((h) => [h.id, h.placement])).toEqual([['weather.now', 'glance']]);
  });
});
