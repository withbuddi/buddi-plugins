/** Writing iCalendar: zones and DST, a new event, a change that keeps what it does not touch. */
import { describe, expect, it } from 'vitest';
import { parseIcs, occurrences } from './ics.js';
import { buildEvent, editEvent, eventFacts, foldLine, parseWhen, unfold, vtimezone } from './icalwrite.js';
import { repeatsText, whenText } from './write.js';

const NY = 'America/New_York';
const now = new Date('2026-10-03T12:00:00Z');

describe('times in a zone', () => {
  it('reads wall-clock time in the zone, and an explicit instant as given', () => {
    expect(parseWhen('2026-10-08T14:00', NY).toISOString()).toBe('2026-10-08T18:00:00.000Z');
    expect(parseWhen('2026-12-08 14:00', NY).toISOString()).toBe('2026-12-08T19:00:00.000Z');
    expect(parseWhen('2026-10-08T14:00Z', NY).toISOString()).toBe('2026-10-08T14:00:00.000Z');
    expect(parseWhen('2026-10-08T14:00+02:00', NY).toISOString()).toBe('2026-10-08T12:00:00.000Z');
    expect(() => parseWhen('next tuesday', NY)).toThrow(/not a time/);
    expect(() => parseWhen('2026-02-30T10:00', NY)).toThrow(/not a time/);
  });

  it('refuses the hour the clocks skip, and takes the first of the hour they repeat', () => {
    expect(() => parseWhen('2026-03-08T02:30', NY)).toThrow(/does not exist in America\/New_York: the clocks go forward/);
    // 01:30 on 1 Nov 2026 happens twice in New York: EDT first (05:30Z), then EST (06:30Z).
    expect(parseWhen('2026-11-01T01:30', NY).toISOString()).toBe('2026-11-01T05:30:00.000Z');
    expect(() => parseWhen('2026-03-29T02:30', 'Europe/Paris')).toThrow(/clocks go forward/);
  });

  it('builds a VTIMEZONE from the zone’s real changes, and one STANDARD for a zone without DST', () => {
    const ny = vtimezone(NY, new Date('2026-10-08T18:00:00Z'));
    expect(ny[0]).toBe('BEGIN:VTIMEZONE');
    expect(ny).toContain('TZID:America/New_York');
    // 2026: forward on 8 March at 02:00 EST, back on 1 November at 02:00 EDT.
    const i = ny.indexOf('DTSTART:20260308T020000');
    expect(ny[i - 1]).toBe('BEGIN:DAYLIGHT');
    expect(ny.slice(i, i + 3)).toEqual(['DTSTART:20260308T020000', 'TZOFFSETFROM:-0500', 'TZOFFSETTO:-0400']);
    const j = ny.indexOf('DTSTART:20261101T020000');
    expect(ny[j - 1]).toBe('BEGIN:STANDARD');
    expect(ny.slice(j, j + 3)).toEqual(['DTSTART:20261101T020000', 'TZOFFSETFROM:-0400', 'TZOFFSETTO:-0500']);
    expect(ny.filter((l) => l === 'BEGIN:DAYLIGHT')).toHaveLength(3); // 2025, 2026, 2027
    expect(vtimezone('Asia/Tokyo', now)).toEqual([
      'BEGIN:VTIMEZONE', 'TZID:Asia/Tokyo', 'BEGIN:STANDARD', 'DTSTART:19700101T000000', 'TZOFFSETFROM:+0900', 'TZOFFSETTO:+0900', 'END:STANDARD', 'END:VTIMEZONE',
    ]);
    const kolkata = vtimezone('Asia/Kolkata', now);
    expect(kolkata).toContain('TZOFFSETTO:+0530');
  });
});

describe('a new event', () => {
  it('is a whole calendar in its zone, which reads back at the same instants across a DST change', () => {
    const start = parseWhen('2026-11-02T09:00', NY); // the Monday after clocks went back
    const text = buildEvent({ uid: 'u-1', title: 'Dentist; bring X-rays, please', time: { allDay: false, start, end: new Date(start.getTime() + 3_600_000), tz: NY }, location: '12 Main St', notes: 'Line one\nline two', now });
    const lines = unfold(text);
    expect(lines).toContain('DTSTART;TZID=America/New_York:20261102T090000');
    expect(lines).toContain('DTEND;TZID=America/New_York:20261102T100000');
    expect(lines).toContain('SUMMARY:Dentist\\; bring X-rays\\, please');
    expect(lines).toContain('DESCRIPTION:Line one\\nline two');
    expect(lines).toContain('UID:u-1');
    expect(text.endsWith('END:VCALENDAR\r\n')).toBe(true);
    const [event] = parseIcs(text);
    expect((event!.start as Date).toISOString()).toBe('2026-11-02T14:00:00.000Z');
    expect(event!.summary).toBe('Dentist; bring X-rays, please');
  });

  it('writes UTC as UTC, and an all-day event as dates with the end the day after', () => {
    const at = new Date('2026-10-08T14:00:00Z');
    expect(unfold(buildEvent({ uid: 'u', title: 'x', time: { allDay: false, start: at, end: at, tz: 'UTC' }, now }))).toContain('DTSTART:20261008T140000Z');
    const allDay = unfold(buildEvent({ uid: 'u', title: 'Off', time: { allDay: true, startDate: '2026-10-08', endDate: '2026-10-10' }, now }));
    expect(allDay).toContain('DTSTART;VALUE=DATE:20261008');
    expect(allDay).toContain('DTEND;VALUE=DATE:20261010');
    expect(allDay.some((l) => l === 'BEGIN:VTIMEZONE')).toBe(false);
  });

  it('folds long lines at 75 octets without splitting a character', () => {
    const line = `SUMMARY:${'é'.repeat(60)}`;
    const folded = foldLine(line);
    for (const part of folded.split('\r\n')) expect(Buffer.byteLength(part)).toBeLessThanOrEqual(75);
    expect(unfold(folded)[0]).toBe(line);
  });
});

const SERIES = [
  'BEGIN:VCALENDAR', 'VERSION:2.0', 'PRODID:-//Apple Inc.//macOS 15//EN',
  'BEGIN:VTIMEZONE', 'TZID:Europe/Paris', 'BEGIN:STANDARD', 'DTSTART:19701025T030000', 'TZOFFSETFROM:+0200', 'TZOFFSETTO:+0100', 'RRULE:FREQ=YEARLY;BYMONTH=10;BYDAY=-1SU', 'END:STANDARD',
  'BEGIN:DAYLIGHT', 'DTSTART:19700329T020000', 'TZOFFSETFROM:+0100', 'TZOFFSETTO:+0200', 'RRULE:FREQ=YEARLY;BYMONTH=3;BYDAY=-1SU', 'END:DAYLIGHT', 'END:VTIMEZONE',
  'BEGIN:VEVENT', 'UID:weekly-1', 'DTSTAMP:20260901T000000Z', 'SEQUENCE:3', 'DTSTART;TZID=Europe/Paris:20261006T100000', 'DTEND;TZID=Europe/Paris:20261006T103000',
  'RRULE:FREQ=WEEKLY;INTERVAL=2', 'SUMMARY:1:1 with Ana', 'X-APPLE-TRAVEL-ADVISORY-BEHAVIOR:AUTOMATIC',
  'BEGIN:VALARM', 'ACTION:DISPLAY', 'TRIGGER:-PT15M', 'DESCRIPTION:Reminder', 'END:VALARM', 'END:VEVENT', 'END:VCALENDAR', '',
].join('\r\n');

describe('a change', () => {
  it('replaces only what it names, keeps alarms and a client’s own lines, and moves the sequence on', () => {
    const changed = editEvent(SERIES, 'weekly-1', { title: '1:1 with Ana (room 4)', location: 'Room 4' }, now);
    const lines = unfold(changed);
    expect(lines).toContain('SUMMARY:1:1 with Ana (room 4)');
    expect(lines).toContain('LOCATION:Room 4');
    expect(lines).toContain('SEQUENCE:4');
    expect(lines).toContain('DTSTAMP:20261003T120000Z');
    expect(lines).toContain('X-APPLE-TRAVEL-ADVISORY-BEHAVIOR:AUTOMATIC');
    expect(lines).toContain('TRIGGER:-PT15M');
    expect(lines).toContain('DESCRIPTION:Reminder'); // the alarm's, untouched
    expect(lines.filter((l) => l.startsWith('SEQUENCE'))).toHaveLength(1);
    expect(lines).toContain('RRULE:FREQ=WEEKLY;INTERVAL=2');
  });

  it('moves the time, adding the VTIMEZONE of a zone the object did not carry, and takes a place away', () => {
    const start = parseWhen('2026-10-06T11:00', NY);
    const withPlace = editEvent(SERIES, 'weekly-1', { location: 'Café' }, now);
    const moved = editEvent(withPlace, 'weekly-1', { time: { allDay: false, start, end: new Date(start.getTime() + 1_800_000), tz: NY }, location: null }, now);
    const lines = unfold(moved);
    expect(lines).toContain('DTSTART;TZID=America/New_York:20261006T110000');
    expect(lines.some((l) => l.startsWith('LOCATION'))).toBe(false);
    expect(lines).toContain('TZID:America/New_York');
    expect(lines).toContain('TZID:Europe/Paris');
    const occ = occurrences(parseIcs(moved), new Date('2026-10-01T00:00:00Z'), new Date('2026-10-31T00:00:00Z'), NY, 'Work');
    expect(occ.map((o) => o.start.toISOString())).toEqual(['2026-10-06T15:00:00.000Z', '2026-10-20T15:00:00.000Z']);
  });

  it('knows a series, its zone and its rule, and an event with invitees', () => {
    const facts = eventFacts(SERIES, 'weekly-1', NY);
    expect(facts).toMatchObject({ summary: '1:1 with Ana', tz: 'Europe/Paris', rule: 'FREQ=WEEKLY;INTERVAL=2', overrides: false, skips: false, invitees: false, allDay: false });
    expect(facts.start.toISOString()).toBe('2026-10-06T08:00:00.000Z');
    expect(repeatsText(facts.rule!)).toBe('Repeats every 2 weeks');
    expect(repeatsText('FREQ=DAILY')).toBe('Repeats daily');
    const invited = SERIES.replace('SUMMARY:1:1 with Ana', 'SUMMARY:1:1 with Ana\r\nATTENDEE;CN=Ana:mailto:ana@example.com');
    expect(eventFacts(invited, 'weekly-1', NY).invitees).toBe(true);
  });
});

describe('when, as the card says it', () => {
  const f24 = { time: '24h' as const, date: 'short' as const };
  it('in the owner’s format, naming a zone that is not theirs', () => {
    const start = parseWhen('2026-10-08T14:00', NY);
    const t = { allDay: false as const, start, end: new Date(start.getTime() + 3_600_000), tz: NY };
    expect(whenText(t, NY, f24)).toBe('Thu 8 Oct, 14:00–15:00');
    expect(whenText(t, NY, { time: '12h', date: 'long' })).toBe('Thursday, 8 October, 2:00 PM–3:00 PM');
    expect(whenText(t, NY, { time: '24h', date: 'iso' })).toBe('2026-10-08, 14:00–15:00');
    expect(whenText({ ...t, tz: 'Europe/Paris' }, NY, f24)).toBe('Thu 8 Oct, 20:00–21:00 (Europe/Paris)');
    expect(whenText({ ...t, end: new Date(start.getTime() + 12 * 3_600_000) }, NY, f24)).toBe('Thu 8 Oct, 14:00 – Fri 9 Oct, 02:00');
    expect(whenText({ allDay: true, startDate: '2026-10-08', endDate: '2026-10-09' }, NY, f24)).toBe('Thu 8 Oct, all day');
    expect(whenText({ allDay: true, startDate: '2026-10-08', endDate: '2026-10-11' }, NY, f24)).toBe('Thu 8 Oct – Sat 10 Oct, all day');
  });
});
