/**
 * The ICS reading on fixtures shaped like each provider's export: a Google
 * work calendar (weekly recurrence with an exception and a moved instance,
 * all-day and multi-day events, a cancelled one, events in two zones and
 * UTC), an iCloud family calendar (weekly until a date, a yearly all-day
 * birthday) and an Outlook one (Windows zone names, a counted recurrence).
 */
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { occurrences, parseIcs } from './ics.js';
import { freeSlots, line } from './tools.js';
import { addDays, dateIn, parseDay, timeIn, zonedTime } from './time.js';

const fixture = (name: string) => readFileSync(new URL(`./fixtures/${name}`, import.meta.url), 'utf8');
const NY = 'America/New_York';
const day = (date: string, tz = NY) => [zonedTime(date, '00:00', tz), zonedTime(addDays(date, 1), '00:00', tz)] as const;

describe('a Google calendar', () => {
  const events = parseIcs(fixture('google-work.ics'));

  it('reads a day in the owner\'s zone: the all-day event, the moved instance, both zones, no cancelled', () => {
    const [from, to] = day('2026-09-28');
    const today = occurrences(events, from, to, NY, 'Work').map((o) => line(o, NY, false));
    expect(today).toEqual([
      'all day: Company offsite',
      '11:00–11:30 Team standup (moved) (Room 4)',
      '14:00–15:00 Call with Paris office',
      '15:00–16:00 Dentist (12 Main St)',
    ]);
  });

  it('expands the weekly standup, skipping the excepted date', () => {
    const [from] = day('2026-09-29');
    const [, to] = day('2026-10-07');
    const standups = occurrences(events, from, to, NY, 'Work').filter((o) => o.summary.startsWith('Team standup'));
    // Wed 30 Sep is excepted; Mon 5 Oct and Wed 7 Oct stand.
    expect(standups.map((o) => `${dateIn(o.start, NY)} ${timeIn(o.start, NY)}`)).toEqual(['2026-10-05 09:30', '2026-10-07 09:30']);
    expect(standups[0]).toMatchObject({ location: 'Zoom', busy: true, allDay: false });
  });

  it('keeps a multi-day all-day event on its dates, and marks all-day events not busy', () => {
    const [from, to] = day('2026-10-02');
    const [trip] = occurrences(events, from, to, NY, 'Work');
    expect(trip).toMatchObject({ summary: 'Trip to Boston', allDay: true, startDate: '2026-10-01', endDate: '2026-10-03', busy: false });
    expect(line(trip!, NY, false, true)).toBe('Thu 1 Oct all day until Fri 2 Oct: Trip to Boston');
    expect(occurrences(events, ...day('2026-10-03'), NY, 'Work').some((o) => o.summary === 'Trip to Boston')).toBe(false);
  });

  it('shows the same instants in another zone', () => {
    const paris = 'Europe/Paris';
    const [from, to] = day('2026-09-28', paris);
    const lines = occurrences(events, from, to, paris, 'Work').map((o) => line(o, paris, false));
    expect(lines).toContain('17:00–17:30 Team standup (moved) (Room 4)');
    expect(lines).toContain('20:00–21:00 Call with Paris office');
    expect(lines).toContain('21:00–22:00 Dentist (12 Main St)');
  });
});

describe('an iCloud calendar', () => {
  const events = parseIcs(fixture('icloud-family.ics'));

  it('repeats weekly in London time across the clock change, until its end date', () => {
    const [from] = day('2026-10-19');
    const [, to] = day('2026-11-03');
    const lessons = occurrences(events, from, to, NY, 'Family').filter((o) => o.summary === 'Swimming lesson');
    // 17:00 in London: 12:00 in New York while both are on summer time, 13:00 in the week between their changes, 12:00 after.
    expect(lessons.map((o) => `${dateIn(o.start, NY)} ${timeIn(o.start, NY)}`)).toEqual([
      '2026-10-20 12:00', '2026-10-27 13:00', '2026-11-03 12:00',
    ]);
    expect(occurrences(events, ...day('2026-12-22'), NY, 'Family').filter((o) => o.summary === 'Swimming lesson')).toEqual([]);
  });

  it('brings a yearly all-day birthday back on its date', () => {
    const [bday] = occurrences(events, ...day('2026-09-29'), NY, 'Family').filter((o) => o.allDay);
    expect(bday).toMatchObject({ summary: "Sam's birthday", startDate: '2026-09-29', busy: false });
  });
});

describe('an Outlook calendar', () => {
  it('reads a Windows zone name and a counted recurrence', () => {
    const events = parseIcs(fixture('outlook.ics'));
    const [from] = day('2026-09-28');
    const [, to] = day('2026-10-31');
    const reviews = occurrences(events, from, to, NY, 'Outlook');
    // 16:00 in Paris is 10:00 in New York; three Mondays, then it stops.
    expect(reviews.map((o) => `${dateIn(o.start, NY)} ${timeIn(o.start, NY)}`)).toEqual([
      '2026-09-28 10:00', '2026-10-05 10:00', '2026-10-12 10:00',
    ]);
  });
});

describe('parsing', () => {
  it('refuses what is not a calendar, in words', () => {
    expect(() => parseIcs('<html>Sign in</html>')).toThrow(/did not answer with a calendar/);
  });
});

describe('free time', () => {
  it('is the gaps between busy spans, overlaps merged, short gaps dropped', () => {
    const at = (t: string) => zonedTime('2026-09-28', t, NY);
    const slots = freeSlots(
      [
        { start: at('09:30'), end: at('10:00') },
        { start: at('09:45'), end: at('11:00') },
        { start: at('11:10'), end: at('12:00') },
        { start: at('17:00'), end: at('19:00') },
      ],
      at('09:00'),
      at('18:00'),
    );
    expect(slots.map((s) => `${timeIn(s.start, NY)}–${timeIn(s.end, NY)}`)).toEqual(['09:00–09:30', '12:00–17:00']);
  });

  it('reads today, tomorrow and a date in the owner\'s zone', () => {
    const now = new Date('2026-09-29T02:00:00Z'); // still the 28th in New York
    expect(parseDay('today', now, NY)).toBe('2026-09-28');
    expect(parseDay('tomorrow', now, NY)).toBe('2026-09-29');
    expect(parseDay('2026-02-30', now, NY)).toBeUndefined();
  });
});
