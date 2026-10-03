/** The manifest through core's own validation, and package.json and buddi.md saying the same. */
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { ToolRegistry } from '@buddi/core/testing';
import { parseViewDescriptors, type Component } from '@buddi/core/plugin';
import { parseWidgets } from '@buddi/core/plugin';
import { manifest } from './index.js';
import { normaliseLink, providerOf } from './store.js';
import { mapHrefOf } from './agenda.js';

const pkg = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8')) as {
  version: string; license: string; buddi: { name: string; uses: string[]; hostApi: string };
};

describe('calendar manifest', () => {
  it('registers: five read tools and three writes shown, the writes asked every time, the settings tools kept from models', () => {
    const registry = new ToolRegistry();
    expect(() => registry.register(manifest)).not.toThrow();
    expect(registry.list().map((t) => t.name).sort()).toEqual([
      'calendar.calendars', 'calendar.cancel_event', 'calendar.create_event', 'calendar.find', 'calendar.free', 'calendar.today', 'calendar.upcoming', 'calendar.update_event',
    ]);
    const tiers = Object.fromEntries(manifest.tools.map((t) => [t.name, t.tier]));
    for (const name of ['calendar.create_event', 'calendar.update_event', 'calendar.cancel_event']) {
      expect(tiers[name], name).toBe('gated');
      const tool = manifest.tools.find((t) => t.name === name)!;
      expect(tool.describe, name).toBeTypeOf('function');
      expect(tool.reusableApproval, name).toBeUndefined();
      // The limits are said where a model reads them.
      expect(tool.description, name).toMatch(/approves it on a card/);
      expect(tool.description, name).toMatch(/invit/);
    }
    expect(manifest.tools.find((t) => t.name === 'calendar.create_event')!.description).toMatch(/no repeating events/);
    expect(manifest.tools.find((t) => t.name === 'calendar.update_event')!.description).toMatch(/whole series/);
    expect(manifest.tools.find((t) => t.name === 'calendar.cancel_event')!.description).toMatch(/series: true/);
    for (const name of ['calendar.today', 'calendar.upcoming', 'calendar.find', 'calendar.free', 'calendar.calendars']) expect(tiers[name], name).toBe('auto');
    for (const name of ['calendar.create_event', 'calendar.update_event', 'calendar.cancel_event']) {
      expect(manifest.tools.find((t) => t.name === name)!.description, name).toMatch(/Pick the calendar from calendar\.calendars; with one writable calendar, use it without asking\./);
    }
    expect(manifest.tools.filter((t) => t.ownerOnly).map((t) => t.name)).toEqual([
      'calendar.add', 'calendar.remove', 'calendar.link_account', 'calendar.link_calendar', 'calendar.allow_changes', 'calendar.set_access', 'calendar.find_again', 'calendar.sign_out',
      'calendar.google_sign_in', 'calendar.google_finish', 'calendar.google_cancel', 'calendar.google_dismiss',
    ]);
  });

  it('needs host API 1.28 for its Google sign-ins, and says what it uses and where it reads and writes', () => {
    expect(pkg.buddi.hostApi).toBe('^1.28');
    expect(manifest.uses).toEqual(['http', 'secrets', 'owner:notify']);
    expect(manifest.network!.map((n) => n.host)).toContain('www.googleapis.com');
    expect(manifest.uses).toEqual(pkg.buddi.uses);
    expect(pkg.buddi.name).toBe('calendar');
    expect(pkg.license).toBe('Apache-2.0');
    expect(manifest.version).toBe(pkg.version);
    const md = readFileSync(new URL('../buddi.md', import.meta.url), 'utf8');
    expect(md).toMatch(/^Schema: calendar$/m);
    expect(md).toMatch(new RegExp(`^Hosts: ${manifest.network!.map((n) => n.host.replace(/[.*]/g, '\\$&')).join(', ')}$`, 'm'));
  });
});

describe('the dashboard', () => {
  it('draws today and the coming days as tiles core accepts, and glances at the next meeting', () => {
    expect(manifest.views?.map((v) => [v.tool, v.renderer])).toEqual([['calendar.today', 'tiles'], ['calendar.upcoming', 'tiles']]);
    expect(() => parseViewDescriptors(manifest.views!, { plugin: 'calendar', tools: manifest.tools.map((t) => t.name), pages: ['settings'] })).not.toThrow();
    expect(manifest.home?.map((h) => [h.id, h.placement])).toEqual([['calendar.next', 'glance']]);
    expect(manifest.widgets?.map((w) => w.id)).toEqual(['calendar.today']);
  });

  it('gives the market a sample per size that core draws', () => {
    const [widget] = parseWidgets('calendar', manifest.widgets, { pages: manifest.pages!.map((p) => p.id), taken: () => false });
    expect(widget!.preview?.medium).toMatchObject({ kind: 'list', more: '2 more by tomorrow night' });
    expect(widget!.preview?.small).toMatchObject({ kind: 'list', rows: [{ title: 'Dinner with Ana', side: '20:00' }, expect.anything(), expect.anything()] });
  });

  it('puts a Calendar place in the rail: week, month and list, the count beside the dates, an event’s sheet, and Settings only when none is linked', () => {
    const registry = new ToolRegistry();
    registry.register(manifest);
    const page = registry.pages().find((p) => p.id === 'agenda')!;
    expect(page).toMatchObject({ plugin: 'calendar', title: 'Calendar', place: 'rail', icon: 'calendar' });
    const calendar = page.body.find((c) => c.kind === 'calendar') as Extract<Component, { kind: 'calendar' }>;
    expect(calendar).toMatchObject({ views: ['week', 'month', 'list'], default: 'week', events: 'events', empty: 'Nothing.', count: true, when: { path: 'linked', equals: true } });
    expect(calendar.map).toEqual({ id: 'id', title: 'title', start: 'start', end: 'end', allDay: 'allDay', calendar: 'calendar', tone: 'tone', location: 'location' });
    expect(calendar.query).toEqual({ query: 'agenda' });
    expect(calendar.sheet).toEqual({
      notes: 'notes',
      color: 'color',
      mapHref: 'mapHref',
      open: { label: 'openLabel', href: 'openHref' },
      asks: [
        { label: 'Move or change…', text: 'Move or change “{title}” ({when}) in {calendar}: ' },
        { label: 'Cancel…', text: 'Cancel “{title}” ({when}) in {calendar}.' },
      ],
    });
    // No strips above the grid: no calendar picker, no count line, no Add — Settings → Calendar holds that.
    expect(page.body.map((c) => c.kind)).toEqual(['notice', 'section', 'notice', 'calendar']);
    const notLinked = page.body.find((c) => c.kind === 'section' && c.when?.equals === false) as Extract<Component, { kind: 'section' }>;
    expect(notLinked.body).toEqual([{ kind: 'notice', text: { path: 'message' } }, { kind: 'link', label: 'Link a calendar', to: { page: 'settings' } }]);
  });

  it('opens an event’s place on a map, but never a call or an address', () => {
    expect(mapHrefOf('Café Lou, Lyon')).toBe('https://www.google.com/maps/search/?api=1&query=Caf%C3%A9%20Lou%2C%20Lyon');
    expect(mapHrefOf('Zoom')).toBe('');
    expect(mapHrefOf('https://meet.google.com/abc')).toBe('');
    expect(mapHrefOf('  ')).toBe('');
  });

  it('says what buddi asks Google for, how to make an app password and find a link in folds, and keeps all in the vault, not a keychain', () => {
    const body = manifest.pages![0]!.body;
    expect(body.filter((c) => c.kind === 'expand').map((c) => (c as { label: string }).label)).toEqual(['What buddi asks Google for', 'How to make an app password', 'How to find a private link']);
    expect(JSON.stringify(body)).toMatch(/seven days/);
    expect(JSON.stringify(body)).toMatch(/buddi's vault|its vault/);
    expect(JSON.stringify(body)).not.toMatch(/keychain/);
  });
});

describe('a link', () => {
  it('is kept as HTTPS, webcal read as https, and never with a password in it', () => {
    expect(normaliseLink(' webcal://p12-caldav.icloud.com/published/2/MTIzNDU2Nzg5 ')).toEqual({
      link: 'https://p12-caldav.icloud.com/published/2/MTIzNDU2Nzg5',
      host: 'p12-caldav.icloud.com',
    });
    expect(() => normaliseLink('http://calendar.google.com/calendar/ical/x/basic.ics')).toThrow(/HTTPS only/);
    expect(() => normaliseLink('https://me:pw@calendar.google.com/x.ics')).toThrow(/without a user name/);
    expect(() => normaliseLink('https://calendar.google.com/')).toThrow(/a site, not a calendar link/);
    expect(() => normaliseLink('my calendar')).toThrow(/not a web address/);
  });

  it('names its provider', () => {
    expect(providerOf('calendar.google.com')).toBe('Google');
    expect(providerOf('p12-caldav.icloud.com')).toBe('iCloud');
    expect(providerOf('outlook.office365.com')).toBe('Outlook');
    expect(providerOf('cal.example.org')).toBe('Calendar link');
  });
});

describe('Settings → Calendar', () => {
  const registry = new ToolRegistry();
  registry.register(manifest);
  const page = registry.pages().find((p) => p.id === 'settings')!;
  type Section = Extract<Component, { kind: 'section' }>;
  const sections = page.body.filter((c) => c.kind === 'section') as Section[];
  const card = sections.find((c) => c.title === 'Sign in with Google')!;
  const calendars = sections.find((c) => c.title === 'Calendars')!;
  const list = calendars.body[0] as Extract<Component, { kind: 'list' }>;
  const repeat = card.body[0] as Extract<Component, { kind: 'repeat' }>;

  /** The page's own `when` and `where`, as the dashboard reads them. */
  const read = (data: unknown, path: string): unknown => path.split('.').reduce<unknown>((v, k) => (v as Record<string, unknown> | undefined)?.[k], data);
  const holds = (data: unknown, c?: { path: string; equals?: unknown; in?: unknown[]; not?: true }): boolean => {
    if (!c) return true;
    const v = read(data, c.path);
    const m = c.in ? c.in.includes(v) : v === c.equals;
    return c.not ? !m : m;
  };
  const shown = (items: Component[], data: unknown, where: 'local' | 'remote' = 'local'): string[] =>
    items
      .filter((c) => holds(data, c.when) && (c.where === undefined || c.where === where))
      .map((c) => (c.kind === 'notice' ? `notice:${typeof c.text === 'string' ? 'text' : 'path' in c.text ? c.text.path : 'const'}` : c.kind === 'button' ? `button:${c.action.label}` : c.kind === 'link' ? `link:${c.label}` : c.kind === 'form' ? `form:${c.submit.label}` : c.kind));

  it('reads plainly: one short notice, one Calendars section with one menu, the help folded', () => {
    expect(page.body[0]).toEqual({ kind: 'notice', text: 'Choose what your agents may do with each calendar. Before any change, they ask you on a card. Links, passwords and sign-ins stay in buddi’s vault.' });
    expect(calendars.actions).toHaveLength(1);
    const menu = calendars.actions![0] as Extract<Component, { kind: 'menu' }>;
    expect(menu).toMatchObject({ label: 'Add a calendar', tone: 'accent' });
    expect(menu.items.map((i) => [i.label, i.hint, i.open ?? i.action?.tool])).toEqual([
      ['Sign in with Google', 'Read and change your Google calendars', 'calendar.google_sign_in'],
      ['Link with an app password', 'iCloud, Fastmail or another CalDAV server', 'app-password'],
      ['Paste a private link', 'Any calendar, read only', 'private-link'],
    ]);
    expect(menu.items[0]!.when).toEqual({ path: 'googleAvailable', equals: true });
    const drawers = calendars.body.filter((c) => c.kind === 'form') as Array<Extract<Component, { kind: 'form' }>>;
    expect(drawers.map((f) => [f.drawer!.id, f.drawer!.button, f.submit.tool])).toEqual([
      ['app-password', undefined, 'calendar.link_account'],
      ['private-link', undefined, 'calendar.add'],
    ]);
    expect(drawers[0]!.fields.map((f) => [f.name, f.type])).toEqual([['service', 'select'], ['server', 'text'], ['username', 'text'], ['password', 'secret']]);
    expect(page.body.filter((c) => c.kind === 'expand').map((c) => (c as { label: string }).label)).toEqual(['What buddi asks Google for', 'How to make an app password', 'How to find a private link']);
  });

  it('lists every calendar once, grouped by account, with one three-way choice and the account’s actions on its head', () => {
    expect(list).toMatchObject({ rows: 'calendars', key: 'id', groupBy: { key: 'group', label: 'groupLabel', aside: 'groupAside', asideTone: 'groupTone' } });
    expect(list.item).toMatchObject({ title: { path: 'name' }, sub: { path: 'line' }, swatch: 'color', status: { text: { path: 'problem' }, tone: 'critical' } });
    const choice = list.item.choice!;
    expect(choice).toMatchObject({ tool: 'calendar.set_access', value: 'access', args: { id: { row: 'id' }, access: { choice: true } } });
    expect(choice.options.map((o) => [o.value, o.label])).toEqual([['off', 'Not linked'], ['read', 'Read'], ['change', 'Read and change']]);
    // Not linked only for an account's calendar; Read and change greyed with why where it cannot change.
    expect(choice.options[0]!.when).toEqual({ path: 'kind', equals: 'account' });
    expect(choice.options[2]).toMatchObject({ disabledWhen: { path: 'readOnly', equals: true }, hint: '{why}' });
    expect(list.groupBy!.actions!.map((a) => [a.label, a.tool, a.menu === true, a.when])).toEqual([
      ['Sign in again', 'calendar.google_sign_in', false, { path: 'expired', equals: true }],
      ['Find calendars again', 'calendar.find_again', true, { path: 'canFind', equals: true }],
      ['Remove account…', 'calendar.sign_out', true, { path: 'kind', equals: 'account' }],
    ]);
    expect(list.actions!.map((a) => [a.label, a.tool, a.menu, a.when])).toEqual([['Remove…', 'calendar.remove', true, { path: 'kind', equals: 'link' }]]);
  });

  it('draws the sign-in card for each state: waiting (and the paste only from another computer), received, done, failed — and none without a sign-in', () => {
    const page0 = { hasGoogleSignIn: false, hasSignedOut: false };
    expect(shown(page.body, page0)).toEqual(['notice:text', 'section', 'expand', 'expand', 'expand']);
    const at = (state: string) => ({ hasGoogleSignIn: true, googleSignIn: { id: 'si', url: 'https://accounts.google.com/x', state } });
    expect(shown(page.body, at('waiting'))).toEqual(['notice:text', 'section', 'section', 'expand', 'expand', 'expand']);
    expect(shown(card.actions!, at('waiting'))).toEqual(['button:Cancel', 'link:Continue to Google']);
    expect(shown(card.actions!, at('received'))).toEqual([]);
    expect(shown(card.actions!, at('done'))).toEqual([]);
    expect(shown(card.actions!, at('failed'))).toEqual(['button:Cancel']);
    const row = (state: string) => ({ id: 'si', state });
    expect(shown(repeat.body, row('waiting'))).toEqual(['notice:line']);
    expect(shown(repeat.body, row('waiting'), 'remote')).toEqual(['notice:line', 'form:Finish signing in']);
    expect(shown(repeat.body, row('received'))).toEqual([]);
    expect(shown(repeat.body, row('done'))).toEqual(['notice:note']);
    expect(shown(repeat.body, row('failed'))).toEqual(['notice:problem']);
    expect((repeat.body[2] as Extract<Component, { kind: 'notice' }>).action).toMatchObject({ tool: 'calendar.google_dismiss', label: 'Done' });
    expect((repeat.body[3] as Extract<Component, { kind: 'notice' }>).action).toMatchObject({ tool: 'calendar.google_sign_in', label: 'Try again' });
    expect(shown(page.body, { hasSignedOut: true, signedOut: 'x' })).toContain('notice:signedOut');
  });

  it('finishes the sign-in by itself: asks every two seconds while it waits, then runs Finish once Google answered', () => {
    expect(repeat).toMatchObject({ query: { query: 'sign_in' }, rows: 'rows', key: 'id' });
    expect(repeat.poll).toEqual({
      seconds: 2,
      while: { path: 'waiting', equals: true },
      finish: {
        when: { path: 'state', equals: 'received' },
        action: { tool: 'calendar.google_finish', label: 'Finish signing in', busy: 'Signed in. Reading your calendars…', then: 'refresh', args: { id: { row: 'id' } } },
      },
    });
  });
});
