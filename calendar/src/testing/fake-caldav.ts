/**
 * For the suites: a CalDAV server in memory, spoken to through core's own
 * `http` area as a transport — so a test exercises the whole road: the
 * plugin names the user, core reads the app password from the vault and
 * builds `Authorization: Basic`, and this server checks it.
 *
 * It answers what the plugin asks: PROPFIND on the root (current principal),
 * the principal (calendar home) and the home (the calendars, with colours,
 * components and rights); REPORT calendar-query by time range or by UID;
 * GET; PUT guarded by If-Match / If-None-Match with a fresh ETag each write;
 * DELETE guarded by If-Match. A wrong password is 401; a stale ETag 412.
 */
import ical, { type VEvent } from 'node-ical';

export interface FakeCalendar {
  path: string;
  name: string;
  color?: string;
  /** `VEVENT`, `VTODO`, …; left out means VEVENT. */
  components?: string[];
  readOnly?: boolean;
}

export interface FakeRequest {
  method: string;
  url: string;
  headers: Record<string, string>;
  body: string;
}

export interface FakeCaldav {
  host: string;
  /** Every request, in order. */
  requests: FakeRequest[];
  /** The objects by path: their text and ETag. */
  objects: Map<string, { data: string; etag: string }>;
  /** Put an object as another client would, with a new ETag. */
  put(path: string, data: string): string;
  /** The transport factory core's `http` area takes. */
  transport: () => (url: string, init: { method?: string; headers?: Record<string, string>; body?: string | Buffer }) => Promise<FakeResponse>;
}

export interface FakeResponse {
  ok: boolean;
  status: number;
  statusText: string;
  headers: { get(name: string): string | null };
  text(): Promise<string>;
  json(): Promise<unknown>;
  arrayBuffer(): Promise<ArrayBuffer>;
}

const respond = (status: number, body = '', headers: Record<string, string> = {}): FakeResponse => {
  const lower = Object.fromEntries(Object.entries(headers).map(([k, v]) => [k.toLowerCase(), v]));
  return {
    ok: status >= 200 && status < 300,
    status,
    statusText: '',
    headers: { get: (name) => lower[name.toLowerCase()] ?? null },
    text: async () => body,
    json: async () => JSON.parse(body),
    arrayBuffer: async () => new TextEncoder().encode(body).buffer as ArrayBuffer,
  };
};

const esc = (s: string): string => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

/** `20261008T140000Z` → ms. */
const stamp = (s: string): number =>
  Date.UTC(Number(s.slice(0, 4)), Number(s.slice(4, 6)) - 1, Number(s.slice(6, 8)), Number(s.slice(9, 11)), Number(s.slice(11, 13)), Number(s.slice(13, 15)));

/** Whether an object has an occurrence in [from, to): a repeating one always counts, as a server's would loosely. */
function overlaps(data: string, from: number, to: number): boolean {
  const events = Object.values(ical.sync.parseICS(data)).filter((c): c is VEvent => (c as { type?: string }).type === 'VEVENT');
  return events.some((e) => {
    if (e.rrule) return true;
    const start = (e.start as Date).getTime();
    const end = e.end instanceof Date ? e.end.getTime() : start;
    return start < to && Math.max(end, start + 1) > from;
  });
}

export function fakeCaldav(options: {
  host: string;
  user: string;
  password: string;
  calendars: FakeCalendar[];
  /** Where the principal and home live; iCloud's home is on another, numbered host. */
  principal?: string;
  home?: string;
  /** The root has no principal; `/.well-known/caldav` redirects to it. */
  wellKnownOnly?: boolean;
  /** The host the calendar home is on, as iCloud's numbered `p52-caldav.icloud.com`. */
  homeHost?: string;
}): FakeCaldav {
  const principal = options.principal ?? '/123/principal/';
  const home = options.home ?? '/123/calendars/';
  const requests: FakeRequest[] = [];
  const objects = new Map<string, { data: string; etag: string }>();
  let version = 0;
  const nextEtag = (): string => `"v${++version}"`;
  const auth = `Basic ${Buffer.from(`${options.user}:${options.password}`).toString('base64')}`;

  const multistatus = (responses: string[]): FakeResponse =>
    respond(207, `<?xml version="1.0" encoding="utf-8"?>\n<multistatus xmlns="DAV:" xmlns:C="urn:ietf:params:xml:ns:caldav" xmlns:A="http://apple.com/ns/ical/">${responses.join('')}</multistatus>`, {
      'content-type': 'application/xml; charset=utf-8',
    });
  const ok = (href: string, props: string): string => `<response><href>${esc(href)}</href><propstat><prop>${props}</prop><status>HTTP/1.1 200 OK</status></propstat></response>`;
  const objectProps = (path: string): string => {
    const o = objects.get(path)!;
    return ok(path, `<getetag>${esc(o.etag)}</getetag><C:calendar-data><![CDATA[${o.data}]]></C:calendar-data>`);
  };

  const handle = (method: string, url: URL, headers: Record<string, string>, body: string): FakeResponse => {
    if (headers.authorization !== auth) return respond(401, 'Unauthorized', { 'www-authenticate': 'Basic realm="fake"' });
    const path = decodeURIComponent(url.pathname);
    if (method === 'PROPFIND') {
      if (path === '/' && options.wellKnownOnly) return respond(404);
      if (path === '/.well-known/caldav') return respond(301, '', { location: `https://${url.host}/` + principal.slice(1) });
      if (path === '/' || (path === principal && body.includes('current-user-principal'))) {
        return multistatus([ok(path, `<current-user-principal><href>${principal}</href></current-user-principal>`)]);
      }
      if (path === principal) {
        return multistatus([ok(path, `<C:calendar-home-set><href>https://${options.homeHost ?? options.host}:443${home}</href></C:calendar-home-set>`)]);
      }
      if (path === home) {
        const rows = [ok(home, '<resourcetype><collection/></resourcetype><displayname>Home</displayname>')];
        for (const cal of options.calendars) {
          const comps = (cal.components ?? ['VEVENT']).map((c) => `<C:comp name="${c}"/>`).join('');
          const rights = cal.readOnly ? '<privilege><read/></privilege>' : '<privilege><read/></privilege><privilege><write/></privilege>';
          rows.push(
            ok(
              cal.path,
              `<resourcetype><collection/><C:calendar/></resourcetype><displayname>${esc(cal.name)}</displayname>` +
                (cal.color ? `<A:calendar-color>${cal.color}</A:calendar-color>` : '') +
                `<C:supported-calendar-component-set>${comps}</C:supported-calendar-component-set>` +
                `<current-user-privilege-set>${rights}</current-user-privilege-set>`,
            ),
          );
        }
        return multistatus(rows);
      }
      return respond(404);
    }
    const calendar = options.calendars.find((c) => path === c.path);
    if (method === 'REPORT') {
      if (!calendar) return respond(404);
      const inside = [...objects.keys()].filter((p) => p.startsWith(calendar.path));
      const uid = /<c:text-match[^>]*>([^<]*)<\/c:text-match>/i.exec(body)?.[1];
      if (uid !== undefined) return multistatus(inside.filter((p) => objects.get(p)!.data.includes(uid.replace(/&amp;/g, '&'))).map(objectProps));
      const range = /<c:time-range start="([^"]+)" end="([^"]+)"/i.exec(body);
      const from = range ? stamp(range[1]!) : -Infinity;
      const to = range ? stamp(range[2]!) : Infinity;
      return multistatus(inside.filter((p) => overlaps(objects.get(p)!.data, from, to)).map(objectProps));
    }
    const owner = options.calendars.find((c) => path.startsWith(c.path));
    if (method === 'GET') {
      const o = objects.get(path);
      return o ? respond(200, o.data, { etag: o.etag, 'content-type': 'text/calendar' }) : respond(404);
    }
    if (method === 'PUT') {
      if (!owner) return respond(409);
      if (owner.readOnly) return respond(403);
      const existing = objects.get(path);
      if (headers['if-none-match'] === '*' && existing) return respond(412);
      if (headers['if-match'] && headers['if-match'] !== existing?.etag) return respond(412);
      const etag = nextEtag();
      objects.set(path, { data: body, etag });
      return respond(existing ? 204 : 201, '', { etag });
    }
    if (method === 'DELETE') {
      const existing = objects.get(path);
      if (!existing) return respond(404);
      if (headers['if-match'] && headers['if-match'] !== existing.etag) return respond(412);
      objects.delete(path);
      return respond(204);
    }
    return respond(405);
  };

  return {
    host: options.host,
    requests,
    objects,
    put(path, data) {
      const etag = nextEtag();
      objects.set(path, { data, etag });
      return etag;
    },
    transport: () => async (raw, init) => {
      const url = new URL(raw);
      const headers = Object.fromEntries(Object.entries(init.headers ?? {}).map(([k, v]) => [k.toLowerCase(), String(v)]));
      const body = init.body === undefined ? '' : String(init.body);
      const method = (init.method ?? 'GET').toUpperCase();
      requests.push({ method, url: raw, headers, body });
      // The hosts this server answers for: its own, and the one its home is on.
      if (url.hostname !== options.host && url.hostname !== options.homeHost) return respond(404);
      return handle(method, url, headers, body);
    },
  };
}
