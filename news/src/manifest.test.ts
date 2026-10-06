/** The manifest through core's own validation, and package.json and buddi.md saying the same. */
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { ToolRegistry } from '@buddi/core/testing';
import { parseWidgets } from '@buddi/core/plugin';
import { manifest, MODEL_HOSTS } from './index.js';
import { starterHosts } from './starter.js';

const pkg = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8')) as {
  version: string; license: string; buddi: { name: string; uses: string[]; hostApi: string };
};

describe('news manifest', () => {
  it('registers, with the tools a model sees, the source manager\'s kept from models, and muting an outlet gated', () => {
    const registry = new ToolRegistry();
    expect(() => registry.register(manifest)).not.toThrow();
    expect(registry.list().map((t) => t.name).sort()).toEqual([
      'news.edition_material', 'news.edition_save', 'news.feedback', 'news.headlines', 'news.mark_told', 'news.mute_outlet',
      'news.quiet_today', 'news.read', 'news.search', 'news.story', 'news.topics',
    ]);
    for (const tool of manifest.tools) {
      expect(tool.name.startsWith('news.')).toBe(true);
      expect(tool.tier).toBe(tool.name === 'news.mute_outlet' ? 'gated' : 'auto');
    }
    expect(manifest.tools.filter((t) => t.ownerOnly).map((t) => t.name).sort()).toEqual([
      'news.add_feed', 'news.add_source', 'news.add_topic', 'news.download_meaning', 'news.enable_starter', 'news.hide_story', 'news.refresh',
      'news.remove_source', 'news.remove_topic', 'news.retry_source', 'news.set_settings', 'news.set_source', 'news.set_topic',
    ]);
    // What outlets wrote is someone else's text.
    expect(manifest.tools.filter((t) => t.untrusted === 'web').map((t) => t.name).sort()).toEqual([
      'news.edition_material', 'news.headlines', 'news.read', 'news.search', 'news.story',
    ]);
  });

  it('asks the owner before an agent mutes an outlet, and not when the owner presses the button', async () => {
    const tool = manifest.tools.find((t) => t.name === 'news.mute_outlet')!;
    expect(await tool.tierFor!({ outlet: 'foxnews.com' }, { agentId: 'anchor' } as never)).toMatchObject({ tier: 'gated' });
    expect(await tool.tierFor!({ outlet: 'foxnews.com' }, { agentId: 'owner' } as never)).toEqual({ tier: 'auto' });
  });

  it('exports headlines, story and the edition material, has a setup, one timer, two pages and the widget', () => {
    expect(Object.keys(manifest.exports ?? {}).sort()).toEqual(['edition_material', 'headlines', 'story']);
    expect(manifest.setup).toBeDefined();
    expect(manifest.sources?.map((s) => [s.id, s.every])).toEqual([['news.fetch', 60]]);
    expect(manifest.queries?.map((q) => q.name).sort()).toEqual(['edition', 'meaning', 'news_settings', 'overview', 'source_rows', 'sources', 'stories', 'topic_rows', 'topics']);
    expect(manifest.pages?.map((p) => [p.id, p.place])).toEqual([['stories', 'rail'], ['sources', 'settings']]);
    expect(manifest.widgets?.map((w) => [w.id, w.sizes])).toEqual([['news.top', ['small', 'medium']]]);
    expect(manifest.optional).toEqual({ speech: '^0.1.3' });
  });

  it('gives the market a sample per size that core draws: three headlines small, five with outlets medium', () => {
    const [widget] = parseWidgets('news', manifest.widgets, { pages: manifest.pages!.map((p) => p.id), taken: () => false });
    expect(widget!.preview?.small).toMatchObject({ kind: 'list', wrap: true });
    expect(widget!.preview?.medium).toMatchObject({ kind: 'list', max: 5 });
    expect((widget!.preview?.medium as { rows: unknown[] }).rows).toHaveLength(5);
  });

  it('declares what leaves the machine and what it uses, as package.json and buddi.md do', () => {
    expect(manifest.network?.map((n) => n.host)).toEqual([...starterHosts(), ...MODEL_HOSTS]);
    expect(manifest.network?.map((n) => n.host)).toEqual(expect.arrayContaining(['news.google.com', 'hn.algolia.com', 'feeds.bbci.co.uk', '*.lemonde.fr']));
    expect(manifest.uses).toEqual(pkg.buddi.uses);
    expect(pkg.buddi.name).toBe(manifest.name);
    expect(pkg.license).toBe('Apache-2.0');
    expect(manifest.version).toBe(pkg.version);
    expect(pkg.buddi.hostApi).toBe('^1.27');
    const md = readFileSync(new URL('../buddi.md', import.meta.url), 'utf8');
    expect(md).toMatch(/^Schema: news$/m);
    expect(md).toContain(`\nHosts: ${[...starterHosts(), ...MODEL_HOSTS].join(', ')}\n`);
  });
});
