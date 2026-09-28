/**
 * The manifest's version, read from this plugin's own package.json when the
 * module loads, so the two can never drift. `../package.json` resolves from
 * both `src/` (tests) and `dist/` (the built plugin); npm always packs it.
 */
import { readFileSync } from 'node:fs';

export const VERSION: string = (
  JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8')) as { version: string }
).version;
