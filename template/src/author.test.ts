import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { manifest } from './index.js';

describe('manifest author', () => {
  it("names the same author as package.json, which is what the install card reads", () => {
    const pkg = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8')) as { author: { name: string } };
    expect(manifest.author?.name).toBe(pkg.author.name);
  });
});
