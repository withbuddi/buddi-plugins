/** The manifest through core's own validation, and package.json and buddi.md saying the same. */
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { ToolRegistry } from '@buddi/core/testing';
import { parseViewDescriptors, type Component } from '@buddi/core/plugin';
import { manifest } from './index.js';
import { normaliseLink, providerOf } from './store.js';

const pkg = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8')) as {
  version: string; license: string; buddi: { name: string; uses: string[]; hostApi: string };
};

describe('calendar manifest', () => {
  it('registers: four read tools and three writes shown, the writes asked every time, the settings tools kept from models', () => {
    const registry = new ToolRegistry();
    expect(() => registry.register(manifest)).not.toThrow();
    expect(registry.list().map((t) => t.name).sort()).toEqual([
      'calendar.cancel_event', 'calendar.create_event', 'calendar.find', 'calendar.free', 'calendar.today', 'calendar.upcoming', 'calendar.update_event',
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
    for (const name of ['calendar.today', 'calendar.upcoming', 'calendar.find', 'calendar.free']) expect(tiers[name], name).toBe('auto');
    expect(manifest.tools.filter((t) => t.ownerOnly).map((t) => t.name)).toEqual([
      'calendar.add', 'calendar.remove', 'calendar.link_account', 'calendar.link_calendar', 'calendar.allow_changes', 'calendar.find_again', 'calendar.sign_out',
    ]);
  });

  it('needs host API 1.26 for its CalDAV sign-ins, and says what it uses and where it reads and writes', () => {
    expect(pkg.buddi.hostApi).toBe('^1.26');
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

  it('puts a Calendar place in the rail: week, month and list, a calendar filter, and Settings when none is linked', () => {
    const registry = new ToolRegistry();
    registry.register(manifest);
    const page = registry.pages().find((p) => p.id === 'agenda')!;
    expect(page).toMatchObject({ plugin: 'calendar', title: 'Calendar', place: 'rail', icon: 'calendar' });
    const calendar = page.body.find((c) => c.kind === 'calendar') as Extract<Component, { kind: 'calendar' }>;
    expect(calendar).toMatchObject({ views: ['week', 'month', 'list'], default: 'week', events: 'events', empty: 'Nothing.', when: { path: 'linked', equals: true } });
    expect(calendar.map).toEqual({ id: 'id', title: 'title', start: 'start', end: 'end', allDay: 'allDay', calendar: 'calendar', tone: 'tone', location: 'location' });
    expect(calendar.query).toEqual({ query: 'agenda', params: { calendars: { param: 'calendars' } } });
    // The not-linked notice and its link are as they were.
    const notLinked = page.body.find((c) => c.kind === 'section' && c.when?.equals === false) as Extract<Component, { kind: 'section' }>;
    expect(notLinked.body).toEqual([{ kind: 'notice', text: { path: 'message' } }, { kind: 'link', label: 'Link a calendar', to: { page: 'settings' } }]);
    const picker = page.body.find((c) => c.kind === 'search') as { when?: unknown; fields: Array<{ multiple?: boolean }> };
    expect(picker.when).toEqual({ path: 'many', equals: true });
    expect(picker.fields[0]!.multiple).toBe(true);
    expect(JSON.stringify(page.body)).toContain('{"page":"settings"}');
  });

  it('says how to make an app password and find a link in folds, and keeps both in the vault, not a keychain', () => {
    const body = manifest.pages![0]!.body;
    expect(body.filter((c) => c.kind === 'expand').map((c) => (c as { label: string }).label)).toEqual(['How to make an app password', 'How to find a private link']);
    expect(JSON.stringify(body)).toMatch(/buddi's vault/);
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
  const sections = page.body.filter((c) => c.kind === 'section') as Array<Extract<Component, { kind: 'section' }>>;

  it('lists the calendars with their colour and what agents may do, and links with an app password from a sheet', () => {
    const [calendars] = sections;
    const table = calendars!.body[0] as Extract<Component, { kind: 'table' }>;
    expect(table.columns[0]).toEqual({ key: 'name', label: 'Name', swatch: 'color' });
    expect(table.columns.map((c) => c.label)).toEqual(['Name', 'From', 'Agents may', 'Events', 'Last read', 'State', 'Problem']);
    expect(table.actions!.map((a) => [a.label, a.when])).toEqual([['Unlink', { path: 'kind', equals: 'account' }], ['Remove', { path: 'kind', equals: 'link' }]]);
    const forms = calendars!.body.filter((c) => c.kind === 'form') as Array<Extract<Component, { kind: 'form' }>>;
    expect(forms.map((f) => f.drawer!.button)).toEqual(['Add a calendar link', 'Link with an app password']);
    const linkForm = forms[1]!;
    expect(linkForm.fields.map((f) => [f.name, f.type])).toEqual([['service', 'select'], ['server', 'text'], ['username', 'text'], ['password', 'secret']]);
    expect(linkForm.fields[0]!.options!.map((o) => o.label)).toEqual(['iCloud', 'Fastmail', 'Another CalDAV server']);
    expect(linkForm.fields[1]!.when).toEqual({ path: 'service', equals: 'other' });
    expect(linkForm.submit).toMatchObject({ tool: 'calendar.link_account', label: 'Sign in and find calendars', then: 'close' });
  });

  it('offers the account calendars to link and allow changes on, only once there is an account', () => {
    const accounts = sections[1]!;
    expect(accounts).toMatchObject({ title: 'From your accounts', when: { path: 'hasAccounts', equals: true } });
    const found = accounts.body[0] as Extract<Component, { kind: 'table' }>;
    expect(found.actions!.map((a) => [a.label, a.when])).toEqual([
      ['Allow changes', { path: 'canAllow', equals: true }],
      ['Read only', { path: 'writable', equals: true }],
      ['Unlink', { path: 'linked', equals: true }],
      ['Link', { path: 'linked', equals: false }],
    ]);
    const list = accounts.body[1] as Extract<Component, { kind: 'table' }>;
    expect(list.actions!.map((a) => a.label)).toEqual(['Find calendars again', 'Sign out']);
  });
});
