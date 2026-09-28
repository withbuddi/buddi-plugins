/** The thresholds, the one-event-one-key rule, and the units. Pure. */
import { describe, expect, it } from 'vitest';
import { describeEvent, eventKey, severeEvents } from './severe.js';
import { defaultUnits, depth, speed, temperature } from './units.js';
import { hoursFrom } from './testing/stub.js';

const NOW = new Date('2026-09-28T06:00:00Z');

describe('severe weather in the next 24 hours', () => {
  it('finds nothing on an ordinary day', () => {
    expect(severeEvents(hoursFrom(NOW, 30), NOW)).toEqual([]);
  });

  it('finds a thunderstorm, strong wind and heavy rain, each once, from its first hour', () => {
    const hours = hoursFrom(NOW, 30, (i) =>
      i === 10 ? { code: 95, gustKmh: 90, precipitationMm: 14 } : i === 11 ? { code: 95, gustKmh: 80, precipitationMm: 6 } : {});
    const events = severeEvents(hours, NOW);
    expect(events.map((e) => e.kind).sort()).toEqual(['heavy-rain', 'strong-wind', 'thunderstorm']);
    const wind = events.find((e) => e.kind === 'strong-wind')!;
    expect(wind).toMatchObject({ startsLocal: '2026-09-28T16:00', date: '2026-09-28', peak: 90 });
    expect(events.find((e) => e.kind === 'heavy-rain')!.peak).toBe(20);
  });

  it('counts a day of steady rain and snow by their totals', () => {
    expect(severeEvents(hoursFrom(NOW, 24, () => ({ precipitationMm: 1.5 })), NOW).map((e) => e.kind)).toEqual(['heavy-rain']);
    expect(severeEvents(hoursFrom(NOW, 24, () => ({ snowfallCm: 0.5, temperatureC: -2 })), NOW).map((e) => e.kind)).toEqual(['heavy-snow']);
    expect(severeEvents(hoursFrom(NOW, 24, () => ({ precipitationMm: 0.5 })), NOW)).toEqual([]);
  });

  it('finds extreme heat and cold at their thresholds', () => {
    expect(severeEvents(hoursFrom(NOW, 24, (i) => ({ temperatureC: i === 8 ? 36.5 : 30 })), NOW)[0]).toMatchObject({ kind: 'extreme-heat', peak: 36.5 });
    expect(severeEvents(hoursFrom(NOW, 24, () => ({ temperatureC: -16 })), NOW)[0]).toMatchObject({ kind: 'extreme-cold' });
    expect(severeEvents(hoursFrom(NOW, 24, () => ({ temperatureC: 34.9 })), NOW)).toEqual([]);
  });

  it('looks only 24 hours ahead', () => {
    expect(severeEvents(hoursFrom(NOW, 40, (i) => (i === 30 ? { code: 95 } : {})), NOW)).toEqual([]);
  });

  it('keys an event by place, kind and day, so eight looks are one message', () => {
    const hours = hoursFrom(NOW, 30, (i) => (i === 10 ? { code: 95 } : {}));
    const early = severeEvents(hours, NOW)[0]!;
    const later = severeEvents(hours, new Date(NOW.getTime() + 3 * 3_600_000))[0]!;
    expect(eventKey('home', early)).toBe('home:thunderstorm:2026-09-28');
    expect(eventKey('home', later)).toBe(eventKey('home', early));
  });

  it('says it in one line, in the owner\'s units', () => {
    const event = { kind: 'strong-wind' as const, startsLocal: '2026-09-28T16:00', date: '2026-09-28', peak: 90 };
    expect(describeEvent(event, 'Home', 'metric').title).toBe('Strong wind at Home from 16:00 on 2026-09-28');
    expect(describeEvent(event, 'Home', 'imperial').text).toMatch(/gusts to 56 mph/);
  });
});

describe('units', () => {
  it('defaults from the language region, then the zone', () => {
    expect(defaultUnits('en-US', 'Europe/Paris')).toBe('imperial');
    expect(defaultUnits('fr', 'America/New_York')).toBe('imperial');
    expect(defaultUnits('en-GB', 'America/New_York')).toBe('metric');
    expect(defaultUnits(undefined, 'Europe/Paris')).toBe('metric');
    expect(defaultUnits(undefined, 'America/Toronto')).toBe('metric');
  });

  it('writes numbers plainly', () => {
    expect(temperature(17.6, 'metric')).toBe('18°C');
    expect(temperature(0, 'imperial')).toBe('32°F');
    expect(speed(100, 'imperial')).toBe('62 mph');
    expect(depth(3.24, 'metric')).toBe('3.2 mm');
    expect(depth(25.4, 'imperial')).toBe('1.0 in');
  });
});
