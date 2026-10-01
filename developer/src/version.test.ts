import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { manifest } from './index.js';

describe('manifest version', () => {
  it("is package.json's version", () => {
    const pkg = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8')) as { version: string };
    expect(manifest.version).toBe(pkg.version);
  });
});
