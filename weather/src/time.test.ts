/**
 * Times the owner's way: the strip's compact hours, a sunrise, which format
 * (the placement's, the Profile, the language, 24-hour), and which buddi
 * draws a partly cloudy night.
 */
import { describe, expect, it } from 'vitest';
import type { BuddiHost } from '@buddi/core/plugin';
import { clockLabel, drawsMoonCloud, hourLabel, ownerTimeFormat } from './time.js';

const host = (time: '12h' | '24h' | null, language?: string): Pick<BuddiHost, 'owner'> =>
  ({ owner: { formats: async () => ({ time, date: null }), language: async () => language } }) as never;

describe('times the owner way', () => {
  it('labels an hour of the strip compactly on a 12-hour clock, as is on a 24-hour one', () => {
    expect(['2026-10-01T18:00', '2026-10-01T20:00', '2026-10-02T00:00', '2026-10-02T12:00', '2026-10-02T09:00'].map((l) => hourLabel(l, '12h')))
      .toEqual(['6 PM', '8 PM', '12 AM', '12 PM', '9 AM']);
    expect(hourLabel('2026-10-01T18:30', '12h')).toBe('6:30 PM');
    expect(hourLabel('2026-10-01T18:00', '24h')).toBe('18:00');
    expect(hourLabel('2026-10-02T00:00', '24h')).toBe('00:00');
  });

  it('writes a sunrise either way', () => {
    expect(clockLabel('2026-10-01T07:42', '12h')).toBe('7:42 AM');
    expect(clockLabel('2026-10-01T19:31', '12h')).toBe('7:31 PM');
    expect(clockLabel('2026-10-01T07:42', '24h')).toBe('07:42');
    expect(clockLabel(undefined, '12h')).toBe('');
  });

  it('takes the placement pick, else the Profile, else what the language reads, else 24-hour', async () => {
    expect(await ownerTimeFormat(host('24h'), '12h')).toBe('12h');
    expect(await ownerTimeFormat(host('12h'), null)).toBe('12h');
    expect(await ownerTimeFormat(host('24h'))).toBe('24h');
    expect(await ownerTimeFormat(host(null, 'en-US'))).toBe('12h');
    expect(await ownerTimeFormat(host(null, 'fr'))).toBe('24h');
    expect(await ownerTimeFormat(host(null))).toBe('24h');
    // A buddi before host API 1.19 has no formats().
    expect(await ownerTimeFormat({ owner: { language: async () => undefined } } as never)).toBe('24h');
  });

  it('knows which buddi draws moon-cloud', () => {
    expect(drawsMoonCloud('1.22')).toBe(true);
    expect(drawsMoonCloud('1.30')).toBe(true);
    expect(drawsMoonCloud('2.0')).toBe(true);
    expect(drawsMoonCloud('1.21')).toBe(false);
    expect(drawsMoonCloud(undefined)).toBe(false);
  });
});
