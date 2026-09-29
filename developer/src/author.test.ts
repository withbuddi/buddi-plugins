import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { manifest } from './index.js';

describe('manifest author', () => {
  it("is withbuddi, as package.json's author says, which is what the install card reads", () => {
    const pkg = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8')) as { author: unknown };
    expect(manifest.author).toEqual({ name: 'withbuddi', url: 'https://withbuddi.com' });
    expect(pkg.author).toEqual(manifest.author);
  });
});
