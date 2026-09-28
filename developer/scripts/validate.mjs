#!/usr/bin/env node
/**
 * What `buddi plugins install <dir>` would say, without installing anything.
 *
 * There is no `buddi plugins doctor <path>`: the verbs are `init`, `dev`,
 * `list`, `info`, `install`, `update`, `approve`, `reject`, `staged` and
 * `uninstall` (`packages/gateway/src/plugins-cli.ts`), and the only one that
 * reads a directory is `install`, which *stages* it into the owner's own
 * plugins root before it prints anything. That writes to a live installation,
 * so it is not what a plugin author runs while writing one.
 *
 * This is the read-only half of it, out of core's own modules and nothing
 * else: import the built manifest, register it in a `ToolRegistry` — which is
 * what runs at startup, and which derives a JSON Schema from every zod input,
 * parses every view and page descriptor and checks every reference — and then
 * print `renderContribution(contributionOf(manifest))`, the summary the owner
 * reads before saying yes. No database, no record, no process.
 *
 *   node scripts/validate.mjs            # this plugin
 *   node scripts/validate.mjs ../finance # any built plugin directory
 */
import path from 'node:path';
import { readFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';
import { ToolRegistry, contributionOf, renderContribution } from '@buddi/core';

const dir = path.resolve(process.argv[2] ?? path.join(import.meta.dirname, '..'));
const pkg = JSON.parse(readFileSync(path.join(dir, 'package.json'), 'utf8'));
const entry = path.join(dir, pkg.main ?? 'dist/index.js');
const exported = pkg.buddi?.manifest ?? 'manifest';

const module = await import(pathToFileURL(entry).href);
const manifest = module[exported] ?? module.default;
if (!manifest) {
  console.error(`${pkg.name}: ${entry} exports no \`${exported}\``);
  process.exit(1);
}

const registry = new ToolRegistry();
try {
  registry.register(manifest);
} catch (err) {
  console.error(`${manifest.name}: would not load — ${err instanceof Error ? err.message : err}`);
  process.exit(1);
}

console.log(renderContribution(contributionOf(manifest)).join('\n'));
console.log('');
console.log(`It loads: ${registry.list().length} tools are listed to a model, ${
  manifest.tools.length - registry.list().length
} are the owner's own.`);
