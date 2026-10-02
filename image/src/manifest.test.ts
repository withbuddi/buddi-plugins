/** The manifest through core's own validation, and what it proposes. */
import { describe, expect, it } from 'vitest';
import { ToolRegistry, parseViewDescriptors } from '@buddi/core/testing';
import { manifest } from './index.js';
import { BACKENDS, backendFor } from './backends/index.js';

describe('image manifest', () => {
  it('registers, namespaced, with the settings tool kept from models', () => {
    const registry = new ToolRegistry();
    expect(() => registry.register(manifest)).not.toThrow();
    expect(registry.list().map((t) => t.name)).toEqual(['image.generate']);
    for (const tool of manifest.tools) expect(tool.name.startsWith('image.')).toBe(true);
    const generate = manifest.tools.find((t) => t.name === 'image.generate')!;
    expect(generate.tier).toBe('auto');
    expect(typeof generate.tierFor).toBe('function');
    expect(typeof generate.describe).toBe('function');
    expect(generate.producesArtifacts).toBe(true);
  });

  it('draws the result with the image renderer, by library id', () => {
    expect(manifest.views).toEqual([
      { tool: 'image.generate', renderer: 'image', title: 'Image', map: { src: 'id', title: { path: 'name' }, caption: { path: 'prompt' }, captionLabel: { const: 'Prompt' } } },
    ]);
    expect(() => parseViewDescriptors(manifest.views!, { plugin: 'image', tools: manifest.tools.map((t) => t.name) })).not.toThrow();
  });

  it('proposes no agent: the Illustrator comes from the catalogue; the prompt skill stays', () => {
    expect(manifest.agents ?? []).toEqual([]);
    expect(manifest.skills?.map((s) => s.name)).toEqual(['writing-an-image-prompt']);
    const skill = manifest.skills![0]!.body;
    expect(skill).toMatch(/"I asked for a flat-vector\s+fox…", never "I generated/);
    // A style that matters is said twice, with what to avoid.
    expect(skill).toMatch(/State the style at the start \*and\* again at the end/);
    expect(skill).toMatch(/no painterly texture, no photographic lighting/);
  });

  it('has backends for codex, openai, gemini and openai-compatible, and none for anthropic', () => {
    expect(BACKENDS.map((b) => b.kind).sort()).toEqual(['codex', 'gemini', 'openai', 'openai-compatible']);
    expect(backendFor({ kind: 'codex' })?.kind).toBe('codex');
    expect(backendFor({ kind: 'openai', baseUrl: 'https://api.openai.com/v1' })?.kind).toBe('openai');
    expect(backendFor({ kind: 'openai-compatible', baseUrl: 'https://generativelanguage.googleapis.com/v1beta/openai' })?.kind).toBe('gemini');
    expect(backendFor({ kind: 'openai-compatible', baseUrl: 'https://generativelanguage.googleapis.com.evil.test/v1' })?.kind).toBe('openai-compatible');
    expect(backendFor({ kind: 'openai-compatible', baseUrl: 'http://127.0.0.1:8080/v1' })?.kind).toBe('openai-compatible');
    // An older host lists no address: a Gemini account is then plain compatible.
    expect(backendFor({ kind: 'openai-compatible' })?.kind).toBe('openai-compatible');
    expect(backendFor({ kind: 'anthropic' })).toBeUndefined();
    expect(backendFor({ kind: 'constructor' as never })).toBeUndefined();
  });
});
