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
  it('registers, with four read tools shown and the settings tools kept from models', () => {
    const registry = new ToolRegistry();
    expect(() => registry.register(manifest)).not.toThrow();
    expect(registry.list().map((t) => t.name).sort()).toEqual(['calendar.find', 'calendar.free', 'calendar.today', 'calendar.upcoming']);
    for (const tool of manifest.tools) expect(tool.tier).toBe('auto');
    expect(manifest.tools.filter((t) => t.ownerOnly).map((t) => t.name)).toEqual(['calendar.add', 'calendar.remove']);
  });

  it('needs host API 1.11 for its calendar page, tiles and glance, and says what it uses and where it reads', () => {
    expect(pkg.buddi.hostApi).toBe('^1.11');
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

  it('says how to find the link in a fold, and keeps the link in the vault, not a keychain', () => {
    const body = manifest.pages![0]!.body;
    expect(body.some((c) => c.kind === 'expand' && c.label === 'How to find the link')).toBe(true);
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
