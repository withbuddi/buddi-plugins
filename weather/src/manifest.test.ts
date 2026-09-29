/** The manifest through core's own validation, and package.json saying the same. */
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { ToolRegistry } from '@buddi/core/testing';
import { manifest } from './index.js';

const pkg = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8')) as {
  version: string; license: string; buddi: { name: string; uses: string[]; hostApi: string };
};

describe('weather manifest', () => {
  it('registers, with the three read tools shown and the settings tools kept from models', () => {
    const registry = new ToolRegistry();
    expect(() => registry.register(manifest)).not.toThrow();
    expect(registry.list().map((t) => t.name).sort()).toEqual(['weather.forecast', 'weather.now', 'weather.places']);
    for (const tool of manifest.tools) {
      expect(tool.name.startsWith('weather.')).toBe(true);
      expect(tool.tier).toBe('auto');
    }
    expect(manifest.tools.filter((t) => t.ownerOnly).map((t) => t.name).sort()).toEqual([
      'weather.add_place', 'weather.remove_place', 'weather.set_home', 'weather.set_units',
    ]);
  });

  it('declares what leaves the machine and what it uses, as package.json and buddi.md do', () => {
    expect(manifest.network?.map((n) => n.host)).toEqual(['geocoding-api.open-meteo.com', 'api.open-meteo.com']);
    expect(manifest.uses).toEqual(pkg.buddi.uses);
    expect(pkg.buddi.name).toBe(manifest.name);
    expect(pkg.license).toBe('Apache-2.0');
    expect(manifest.version).toBe(pkg.version);
    const md = readFileSync(new URL('../buddi.md', import.meta.url), 'utf8');
    expect(md).toMatch(/^Schema: weather$/m);
    expect(md).toMatch(/^Hosts: geocoding-api\.open-meteo\.com, api\.open-meteo\.com$/m);
  });

  it('has one sentinel, every three hours, a rail page and a settings page', () => {
    expect(manifest.sentinels?.map((s) => [s.id, s.every])).toEqual([['weather.severe', 10_800]]);
    expect(manifest.pages?.map((p) => [p.id, p.place, p.icon])).toEqual([['weather', 'rail', 'cloud'], ['settings', 'settings', 'globe']]);
    // The rail page draws a series panel: the first host that draws one is 1.13.
    expect(pkg.buddi.hostApi).toBe('^1.13');
  });
});
