/**
 * For the suites: Google's side, in memory.
 *
 * - The Calendar API, spoken to through core's own `http` area as its
 *   transport, so a test runs the whole road: the plugin names the secret,
 *   core reads the sign-in from the vault, asks the sign-in service for a
 *   fresh token and inserts `Authorization: Bearer`, and this API checks it —
 *   a token it did not issue last is 401. It answers `calendarList.list`,
 *   `events.list` (a time range, `singleEvents` expanding a weekly series),
 *   `events.get`, `insert` (409 on an id it has), `patch` and `delete`, each
 *   write guarded by `If-Match` and giving a fresh ETag.
 * - The sign-in service core is handed (`PluginSignInService`): a sign-in the
 *   test finishes as Google's loopback answer would (`answer`), or with a
 *   pasted address; a refresh that issues the next token; and, once the test
 *   says so (`revoke`), Google refusing it — `SignInExpiredError`.
 */
import { SignInExpiredError } from '@buddi/core/plugin';

export interface FakeEvent {
  id: string;
  etag: string;
  summary: string;
  location?: string;
  description?: string;
  htmlLink?: string;
  start: { date?: string; dateTime?: string; timeZone?: string };
  end: { date?: string; dateTime?: string; timeZone?: string };
  recurrence?: string[];
  attendees?: Array<{ email: string; self?: boolean }>;
  status?: string;
}

export interface FakeCalendarEntry {
  id: string;
  summary: string;
  backgroundColor?: string;
  accessRole: 'owner' | 'writer' | 'reader' | 'freeBusyReader';
  primary?: boolean;
}

export interface FakeGoogleRequest {
  method: string;
  url: URL;
  headers: Record<string, string>;
  body: string;
}

const respond = (status: number, data?: unknown, headers: Record<string, string> = {}) => {
  const body = data === undefined ? '' : JSON.stringify(data);
  const lower = Object.fromEntries(Object.entries(headers).map(([k, v]) => [k.toLowerCase(), v]));
  return {
    ok: status >= 200 && status < 300,
    status,
    statusText: '',
    headers: { get: (name: string) => lower[name.toLowerCase()] ?? null },
    text: async () => body,
    json: async () => JSON.parse(body),
    arrayBuffer: async () => new TextEncoder().encode(body).buffer as ArrayBuffer,
  };
};

export function fakeGoogle(opts: { calendars: FakeCalendarEntry[] }) {
  let issued = 0;
  let etags = 0;
  const nextEtag = (): string => `"${++etags}"`;
  const state = {
    /** The token the API accepts now. */
    valid: '',
    /** Every request, in order. */
    requests: [] as FakeGoogleRequest[],
    calendars: opts.calendars,
    events: new Map<string, FakeEvent[]>(opts.calendars.map((c) => [c.id, []])),
    /** Google refuses every refresh from now on. */
    revoked: false,
    /** The calendar list answers 503: a sign-in that cannot read what it signed in to. */
    calendarsFail: false,
    refreshes: 0,
    signIns: new Map<string, { plugin: string; save(envelope: string): Promise<void>; state: 'waiting' | 'signed-in' | 'failed' }>(),
    finished: [] as Array<{ id: string; pasted: string }>,
  };

  const issue = (): string => {
    state.valid = `ya29.token-${++issued}`;
    return state.valid;
  };

  /** Put an event as another client would. */
  function put(calendarId: string, event: Omit<FakeEvent, 'etag'>): FakeEvent {
    const list = state.events.get(calendarId)!;
    const kept = { ...event, etag: nextEtag() };
    const i = list.findIndex((e) => e.id === event.id);
    if (i >= 0) list[i] = kept;
    else list.push(kept);
    return kept;
  }

  /** The occurrences of a weekly series in a window, as `singleEvents` gives them. */
  function expand(e: FakeEvent, from: number, to: number): Array<Record<string, unknown>> {
    if (!e.recurrence?.some((r) => /FREQ=WEEKLY/.test(r))) return [e as unknown as Record<string, unknown>];
    const out: Array<Record<string, unknown>> = [];
    const start = Date.parse(e.start.dateTime!);
    const length = Date.parse(e.end.dateTime!) - start;
    for (let at = start; at < to; at += 7 * 86_400_000) {
      if (at + length <= from) continue;
      out.push({
        ...e,
        id: `${e.id}_${new Date(at).toISOString().replace(/[-:]/g, '').slice(0, 15)}Z`,
        recurringEventId: e.id,
        recurrence: undefined,
        start: { dateTime: new Date(at).toISOString(), timeZone: e.start.timeZone },
        end: { dateTime: new Date(at + length).toISOString(), timeZone: e.end.timeZone },
      });
    }
    return out;
  }

  const timeOf = (t: FakeEvent['start']): number => (t.date ? Date.parse(`${t.date}T00:00:00Z`) : Date.parse(t.dateTime!));

  async function handle(method: string, url: URL, headers: Record<string, string>, body: string) {
    if (url.hostname !== 'www.googleapis.com') return respond(404, { error: { code: 404 } });
    if (headers.authorization !== `Bearer ${state.valid}` || state.valid === '') return respond(401, { error: { code: 401, status: 'UNAUTHENTICATED' } });
    const path = url.pathname.replace(/^\/calendar\/v3/, '');
    if (method === 'GET' && path === '/users/me/calendarList') {
      if (state.calendarsFail) return respond(503, { error: { code: 503, status: 'UNAVAILABLE', message: 'Backend Error' } });
      return respond(200, { items: state.calendars.map((c) => ({ ...c })) });
    }
    const m = /^\/calendars\/([^/]+)\/events(?:\/([^/]+))?$/.exec(path);
    if (!m) return respond(404, { error: { code: 404 } });
    const calendarId = decodeURIComponent(m[1]!);
    const eventId = m[2] === undefined ? undefined : decodeURIComponent(m[2]);
    const list = state.events.get(calendarId);
    if (!list) return respond(404, { error: { code: 404 } });
    const found = eventId === undefined ? undefined : list.find((e) => e.id === eventId);
    const ifMatch = headers['if-match'];
    if (method === 'GET' && eventId === undefined) {
      const from = Date.parse(url.searchParams.get('timeMin')!);
      const to = Date.parse(url.searchParams.get('timeMax')!);
      const items = list
        .filter((e) => e.status !== 'cancelled')
        .flatMap((e) => (url.searchParams.get('singleEvents') === 'true' ? expand(e, from, to) : [e as unknown as Record<string, unknown>]))
        .filter((e) => timeOf(e.start as FakeEvent['start']) < to && timeOf(e.end as FakeEvent['end']) > from);
      return respond(200, { items });
    }
    if (method === 'GET') return found ? respond(200, found, { etag: found.etag }) : respond(404, { error: { code: 404 } });
    if (method === 'POST') {
      const event = JSON.parse(body) as Omit<FakeEvent, 'etag'>;
      if (list.some((e) => e.id === event.id)) return respond(409, { error: { code: 409, errors: [{ reason: 'duplicate' }] } });
      const kept = put(calendarId, event);
      return respond(200, kept, { etag: kept.etag });
    }
    if (!found) return respond(404, { error: { code: 404 } });
    if (ifMatch !== undefined && ifMatch !== found.etag) return respond(412, { error: { code: 412, errors: [{ reason: 'conditionNotMet' }] } });
    if (method === 'PATCH') {
      const changes = JSON.parse(body) as Partial<FakeEvent>;
      const kept = put(calendarId, { ...found, ...changes, id: found.id });
      return respond(200, kept, { etag: kept.etag });
    }
    if (method === 'DELETE') {
      state.events.set(calendarId, list.filter((e) => e.id !== found.id));
      return respond(204);
    }
    return respond(405);
  }

  return {
    state,
    put,
    issue,
    /** Google's answer arriving on the loopback port: the sign-in's tokens saved by core. */
    async answer(id: string): Promise<void> {
      const signIn = state.signIns.get(id)!;
      await signIn.save(JSON.stringify({ version: 1, state: 'ready', accessToken: issue(), refreshToken: '1//refresh', expiresAt: Date.now() + 3600_000 }));
      signIn.state = 'signed-in';
    },
    /** The access token stops working at Google, as one does after an hour. */
    expireToken(): void {
      state.valid = `ya29.unknown-${issued}`;
    },
    /** The owner revoked buddi, or testing mode's seven days ran out. */
    revoke(): void {
      state.revoked = true;
      state.valid = '';
    },
    transport: () => async (url: string, init: { method?: string; headers?: Record<string, string>; body?: string | Buffer }) => {
      const headers = Object.fromEntries(Object.entries(init.headers ?? {}).map(([k, v]) => [k.toLowerCase(), v]));
      const body = init.body === undefined ? '' : String(init.body);
      const parsed = new URL(url);
      state.requests.push({ method: init.method ?? 'GET', url: parsed, headers, body });
      return handle(init.method ?? 'GET', parsed, headers, body);
    },
    /** What core is handed as `signIns`. */
    service: {
      async begin(input: { plugin: string; save(envelope: string): Promise<void> }) {
        const id = `signin-${state.signIns.size + 1}`;
        state.signIns.set(id, { plugin: input.plugin, save: input.save, state: 'waiting' });
        return { id, authorizeUrl: `https://accounts.google.com/o/oauth2/v2/auth?state=${id}`, redirectUri: 'http://127.0.0.1:50123/', expiresAt: Date.parse('2100-01-01T00:00:00Z') };
      },
      status(plugin: string, id: string) {
        const s = state.signIns.get(id);
        return s && s.plugin === plugin ? { state: s.state } : undefined;
      },
      async finish(plugin: string, id: string, pasted: string) {
        state.finished.push({ id, pasted });
        const s = state.signIns.get(id);
        if (!s || s.plugin !== plugin) return { state: 'expired' as const, problem: 'That sign-in is over. Start again.' };
        if (!pasted.includes(`state=${id}`)) throw new Error('That address is from another sign-in. Paste the one from the tab this sign-in opened.');
        await s.save(JSON.stringify({ version: 1, state: 'ready', accessToken: issue(), refreshToken: '1//refresh', expiresAt: Date.now() + 3600_000 }));
        s.state = 'signed-in';
        return { state: 'signed-in' as const };
      },
      cancel(_plugin: string, id: string) {
        state.signIns.delete(id);
      },
      async fresh(vault: { get(n: string): Promise<string | null>; set(n: string, v: string): Promise<void> }, ref: string, secret: string, o: { rejected?: string } = {}) {
        const envelope = JSON.parse((await vault.get(ref)) ?? '{}') as { accessToken: string };
        if (o.rejected === undefined || o.rejected !== envelope.accessToken) return { accessToken: envelope.accessToken, refreshed: false };
        if (state.revoked) throw new SignInExpiredError(secret);
        state.refreshes++;
        const next = { ...envelope, accessToken: issue() };
        await vault.set(ref, JSON.stringify(next));
        return { accessToken: next.accessToken, refreshed: true };
      },
    },
  };
}

export type FakeGoogle = ReturnType<typeof fakeGoogle>;
