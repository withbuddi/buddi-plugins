/**
 * CalDAV against the fake server: discovery (principal, home on another
 * host, calendars with colours and rights), the time-range query, a write
 * guarded by its ETag (412 when stale), a delete. The http area here is a
 * stand-in that signs in itself; the DB suite goes through core's.
 */
import { describe, expect, it } from 'vitest';
import type { BuddiHost } from '@buddi/core/plugin';
import { DavError, StaleError, davSender, deleteObject, discover, findByUid, getObject, hostCovered, normaliseColor, objectHref, putObject, queryEvents } from './caldav.js';
import { parseXml, childOf, DAV } from './xml.js';
import { buildEvent } from './icalwrite.js';
import { fakeCaldav } from './testing/fake-caldav.js';

const now = new Date('2026-10-03T12:00:00Z');

function hostFor(server: ReturnType<typeof fakeCaldav>, password: string): Pick<BuddiHost, 'http' | 'network'> {
  const send = server.transport();
  const declared: Array<{ host: string; why: string }> = [];
  return {
    http: {
      async request(req) {
        const user = req.auth?.username ?? '';
        return send(req.url, {
          method: req.method ?? 'GET',
          headers: { ...(req.headers ?? {}), authorization: `Basic ${Buffer.from(`${user}:${password}`).toString('base64')}` },
          ...(req.body === undefined ? {} : { body: req.body }),
        });
      },
    },
    network: { declared: () => declared, declare: (hosts) => void declared.push(...hosts) },
  } as Pick<BuddiHost, 'http' | 'network'>;
}

const icloud = () =>
  fakeCaldav({
    host: 'caldav.icloud.com',
    homeHost: 'p52-caldav.icloud.com',
    user: 'sam@icloud.com',
    password: 'abcd-efgh-ijkl-mnop',
    calendars: [
      { path: '/123/calendars/work/', name: 'Work', color: '#1F6FEBFF' },
      { path: '/123/calendars/family/', name: 'Family & friends', color: '#E5534B' },
      { path: '/123/calendars/tasks/', name: 'Reminders', components: ['VTODO'] },
      { path: '/123/calendars/shared/', name: 'Shared', readOnly: true },
    ],
  });

const signIn = { hostPattern: '*.icloud.com', username: 'sam@icloud.com', secretName: 'Calendar sign-in: iCloud sam@icloud.com' };

describe('discovery', () => {
  it('finds the principal, follows the home to its numbered host, and lists calendars with colours and rights', async () => {
    const server = icloud();
    const found = await discover(davSender(hostFor(server, 'abcd-efgh-ijkl-mnop'), signIn), 'https://caldav.icloud.com/');
    expect(found.home).toBe('https://p52-caldav.icloud.com/123/calendars/');
    expect(found.calendars).toEqual([
      { url: 'https://p52-caldav.icloud.com/123/calendars/work/', name: 'Work', color: '#1f6feb', events: true, writable: true },
      { url: 'https://p52-caldav.icloud.com/123/calendars/family/', name: 'Family & friends', color: '#e5534b', events: true, writable: true },
      { url: 'https://p52-caldav.icloud.com/123/calendars/tasks/', name: 'Reminders', color: null, events: false, writable: true },
      { url: 'https://p52-caldav.icloud.com/123/calendars/shared/', name: 'Shared', color: null, events: true, writable: false },
    ]);
    expect(server.requests.map((r) => [r.method, new URL(r.url).host, r.headers.depth])).toEqual([
      ['PROPFIND', 'caldav.icloud.com', '0'],
      ['PROPFIND', 'caldav.icloud.com', '0'],
      ['PROPFIND', 'p52-caldav.icloud.com', '1'],
    ]);
  });

  it('tries .well-known/caldav and follows its redirect when the root says nothing', async () => {
    const server = fakeCaldav({ host: 'caldav.fastmail.com', user: 'sam@fastmail.com', password: 'pw', wellKnownOnly: true, calendars: [{ path: '/123/calendars/default/', name: 'Calendar', color: '#3a87ad' }] });
    const found = await discover(davSender(hostFor(server, 'pw'), { hostPattern: 'caldav.fastmail.com', username: 'sam@fastmail.com', secretName: 's' }), 'https://caldav.fastmail.com/');
    expect(found.calendars.map((c) => c.name)).toEqual(['Calendar']);
    expect(server.requests.some((r) => r.url.endsWith('/.well-known/caldav'))).toBe(true);
  });

  it('says a refused sign-in in words, and never follows a server to a host that is not the account’s', async () => {
    const server = icloud();
    await expect(discover(davSender(hostFor(server, 'wrong'), signIn), 'https://caldav.icloud.com/')).rejects.toThrow(/turned the sign-in down: check the user name, and that the password is an app-specific password/);
    const elsewhere = davSender(hostFor(server, 'abcd-efgh-ijkl-mnop'), { ...signIn, hostPattern: 'caldav.icloud.com' });
    await expect(discover(elsewhere, 'https://caldav.icloud.com/')).rejects.toThrow(/sent buddi to p52-caldav.icloud.com, which is not this account's server/);
    await expect(davSender(hostFor(server, 'x'), signIn)({ method: 'GET', url: 'http://caldav.icloud.com/' })).rejects.toThrow(/HTTPS only/);
  });

  it('matches hosts and colours the way servers write them', () => {
    expect(hostCovered('*.icloud.com', 'p52-caldav.icloud.com')).toBe(true);
    expect(hostCovered('*.icloud.com', 'icloud.com.evil.example')).toBe(false);
    expect(hostCovered('*.icloud.com', 'icloud.com')).toBe(false);
    expect(hostCovered('caldav.fastmail.com', 'CalDAV.Fastmail.com')).toBe(true);
    expect(normaliseColor('#AbC')).toBe('#aabbcc');
    expect(normaliseColor('#1F6FEBFF')).toBe('#1f6feb');
    expect(normaliseColor('red')).toBeNull();
  });
});

describe('events', () => {
  it('queries a range, writes with If-None-Match, changes only at the version read, and deletes', async () => {
    const server = icloud();
    const send = davSender(hostFor(server, 'abcd-efgh-ijkl-mnop'), signIn);
    const cal = 'https://p52-caldav.icloud.com/123/calendars/work/';
    const at = new Date('2026-10-08T18:00:00Z');
    const body = buildEvent({ uid: 'e-1', title: 'Dentist', time: { allDay: false, start: at, end: new Date(at.getTime() + 3_600_000), tz: 'America/New_York' }, now });
    const href = objectHref(cal, 'e-1');
    expect(href).toBe('https://p52-caldav.icloud.com/123/calendars/work/e-1.ics');
    const { etag } = await putObject(send, href, body, { create: true });
    expect(server.requests.at(-1)!.headers['if-none-match']).toBe('*');
    await expect(putObject(send, href, body, { create: true })).rejects.toThrow(/already in the calendar/);

    const inOctober = await queryEvents(send, cal, new Date('2026-10-01T00:00:00Z'), new Date('2026-11-01T00:00:00Z'));
    expect(inOctober.map((o) => [o.href, o.etag])).toEqual([[href, etag]]);
    expect(server.requests.at(-1)!.body).toContain('<c:time-range start="20261001T000000Z" end="20261101T000000Z"/>');
    expect(await queryEvents(send, cal, new Date('2026-12-01T00:00:00Z'), new Date('2027-01-01T00:00:00Z'))).toEqual([]);

    expect((await findByUid(send, cal, 'e-1'))?.href).toBe(href);
    expect(await findByUid(send, cal, 'e')).toBeNull(); // a substring is not the event
    const read = await getObject(send, href);
    expect(read?.etag).toBe(etag);

    // Someone changes it on their phone: the version buddi read is stale.
    server.put('/123/calendars/work/e-1.ics', body.replace('Dentist', 'Dentist (moved)'));
    await expect(putObject(send, href, body, { ifMatch: etag! })).rejects.toBeInstanceOf(StaleError);
    await expect(deleteObject(send, href, etag)).rejects.toBeInstanceOf(StaleError);
    const fresh = await getObject(send, href);
    expect(await deleteObject(send, href, fresh!.etag)).toBe('deleted');
    expect(await deleteObject(send, href, fresh!.etag)).toBe('gone');
    expect(await getObject(send, href)).toBeNull();
  });

  it('refuses a write to a calendar the server keeps read-only, with its status', async () => {
    const server = icloud();
    const send = davSender(hostFor(server, 'abcd-efgh-ijkl-mnop'), signIn);
    const err = await putObject(send, 'https://p52-caldav.icloud.com/123/calendars/shared/x.ics', 'BEGIN:VCALENDAR\r\nEND:VCALENDAR\r\n', { create: true }).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(DavError);
    expect((err as DavError).status).toBe(403);
  });
});

describe('xml', () => {
  it('reads any prefix by its namespace, CDATA and entities', () => {
    const doc = parseXml('<?xml version="1.0"?><x:multistatus xmlns:x="DAV:"><x:response><x:href>/a%20b/</x:href><!-- c --><x:status>a &amp; b &#233;<![CDATA[<raw>]]></x:status></x:response></x:multistatus>');
    const response = childOf(doc, DAV, 'response');
    expect(childOf(response, DAV, 'href')?.text).toBe('/a%20b/');
    expect(childOf(response, DAV, 'status')?.text).toBe('a & b é<raw>');
    expect(() => parseXml('<!DOCTYPE x [<!ENTITY a "b">]><x/>')).toThrow(/doctype/);
    expect(() => parseXml('not xml')).toThrow(/not XML/);
  });
});
