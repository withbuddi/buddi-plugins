/** The manifest through core's own validation, and package.json and buddi.md saying the same. */
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { ToolRegistry } from '@buddi/core/testing';
import { manifest } from './index.js';
import { starterHosts } from './starter.js';

const pkg = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8')) as {
  version: string; license: string; buddi: { name: string; uses: string[]; hostApi: string };
};

describe('news manifest', () => {
  it('registers, with six tools a model sees and the source manager\'s tools kept from models', () => {
    const registry = new ToolRegistry();
    expect(() => registry.register(manifest)).not.toThrow();
    expect(registry.list().map((t) => t.name).sort()).toEqual([
      'news.feedback', 'news.headlines', 'news.mark_told', 'news.search', 'news.story', 'news.topics',
    ]);
    for (const tool of manifest.tools) {
      expect(tool.name.startsWith('news.')).toBe(true);
      expect(tool.tier).toBe('auto');
    }
    expect(manifest.tools.filter((t) => t.ownerOnly).map((t) => t.name).sort()).toEqual([
      'news.add_source', 'news.add_topic', 'news.enable_starter', 'news.hide_story', 'news.mute_outlet', 'news.refresh',
      'news.remove_source', 'news.remove_topic', 'news.retry_source', 'news.set_settings', 'news.set_source', 'news.set_topic',
    ]);
    // What outlets wrote is someone else's text.
    expect(manifest.tools.filter((t) => t.untrusted === 'web').map((t) => t.name).sort()).toEqual(['news.headlines', 'news.search', 'news.story']);
  });

  it('exports headlines and story, has a setup and one timer', () => {
    expect(Object.keys(manifest.exports ?? {}).sort()).toEqual(['headlines', 'story']);
    expect(manifest.setup).toBeDefined();
    expect(manifest.sources?.map((s) => [s.id, s.every])).toEqual([['news.fetch', 60]]);
    expect(manifest.queries?.map((q) => q.name).sort()).toEqual(['logo', 'sources']);
  });

  it('declares what leaves the machine and what it uses, as package.json and buddi.md do', () => {
    expect(manifest.network?.map((n) => n.host)).toEqual(starterHosts());
    expect(manifest.network?.map((n) => n.host)).toEqual(expect.arrayContaining(['news.google.com', 'hn.algolia.com', 'feeds.bbci.co.uk', '*.lemonde.fr']));
    expect(manifest.uses).toEqual(pkg.buddi.uses);
    expect(pkg.buddi.name).toBe(manifest.name);
    expect(pkg.license).toBe('Apache-2.0');
    expect(manifest.version).toBe(pkg.version);
    expect(pkg.buddi.hostApi).toBe('^1.18');
    const md = readFileSync(new URL('../buddi.md', import.meta.url), 'utf8');
    expect(md).toMatch(/^Schema: news$/m);
    expect(md).toContain(`\nHosts: ${starterHosts().join(', ')}\n`);
  });
});
