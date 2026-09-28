/**
 * The manifest, through core's own validation.
 *
 * `ToolRegistry.register` is what runs at startup: it derives a JSON Schema
 * from every zod input and refuses one no provider would accept, it refuses a
 * tool name that collides, and it parses every view descriptor. Registering
 * the manifest here is therefore the cheapest possible proof that this plugin
 * will load — and it needs no database.
 */
import { describe, expect, it } from 'vitest';
import { ToolRegistry } from '@buddi/core/testing';
import { manifest } from './index.js';

describe('template manifest', () => {
  it('registers in a tool registry', () => {
    const registry = new ToolRegistry();
    expect(() => registry.register(manifest)).not.toThrow();
    expect(registry.has('template.list_notes')).toBe(true);
  });

  it('namespaces every tool to the plugin', () => {
    for (const tool of manifest.tools) {
      expect(tool.name.startsWith(`${manifest.name}.`)).toBe(true);
    }
  });

  it('declares an executable tier, and describes every gated tool', () => {
    for (const tool of manifest.tools) {
      expect(['auto', 'gated', 'session']).toContain(tool.tier);
      if (tool.tier === 'gated') expect(typeof tool.describe).toBe('function');
    }
  });

  it('refuses a gated execute with no approved action id', async () => {
    const gated = manifest.tools.find((tool) => tool.tier === 'gated');
    expect(gated).toBeDefined();
    await expect(
      gated!.execute(
        { id: '00000000-0000-4000-8000-000000000000' },
        { db: null as never, ownerId: 'owner', now: () => new Date(), timezone: 'UTC' },
      ),
    ).rejects.toThrow(/action id/);
  });
});
