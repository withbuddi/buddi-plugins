#!/usr/bin/env node
/**
 * Every plugin here reaches buddi through `ctx.buddi` and `@buddi/core/plugin`,
 * and nothing else (buddi's docs/plugin-host-api.md §6). The same check
 * as buddi's `packages/gateway/src/plugin-imports.test.ts`, run from the root
 * `pnpm test`. It walks each plugin's `src` and fails, naming the file, on:
 *
 *  - an import of `@buddi/core` other than `@buddi/core/plugin`, or
 *    `@buddi/core/testing` in a test;
 *  - an import of `@buddi/runtime`, `@buddi/gateway` or any `@buddi/tool-*`;
 *  - a relative import that leaves the plugin's own package;
 *  - a `core.` table named in a SQL string, outside tests — the scope rule for
 *    `ctx.buddi.db` until each plugin connects as its own Postgres role.
 *
 * `node scripts/check-plugin-imports.mjs --self-test` checks the check.
 */
import { readdirSync, readFileSync, statSync, existsSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const SOURCE = /\.(ts|tsx|mts|cts|js|mjs|cjs)$/;
const TEST = /\.test\.(ts|tsx|mts|cts|js|mjs|cjs)$/;

function walk(dir) {
  const found = [];
  for (const entry of readdirSync(dir)) {
    if (entry === 'node_modules' || entry === 'dist') continue;
    const full = path.join(dir, entry);
    if (statSync(full).isDirectory()) found.push(...walk(full));
    else if (SOURCE.test(entry) && !entry.endsWith('.d.ts')) found.push(full);
  }
  return found;
}

/** The code, comments blanked: prose may mention `core.events`; code may not. */
function code(text) {
  return text.replace(/\/\*[\s\S]*?\*\//g, ' ').replace(/(^|[^:'"`\\])\/\/.*$/gm, '$1');
}

function specifiers(text) {
  const found = [];
  const patterns = [
    /\b(?:import|export)\s[^'"`;]*?\sfrom\s*['"]([^'"]+)['"]/g,
    /\bimport\s*['"]([^'"]+)['"]/g,
    /\bimport\s*\(\s*['"]([^'"]+)['"]\s*\)/g,
    /\brequire\s*\(\s*['"]([^'"]+)['"]\s*\)/g,
  ];
  for (const pattern of patterns) for (const match of text.matchAll(pattern)) found.push(match[1]);
  return found;
}

const SQL_WORD = /\b(select|insert|update|delete|from|join|into|table|returning)\b/i;
const CORE_TABLE = /(?<![\w@/.-])core\.([a-z_][a-z0-9_]*)\b/g;

function coreTables(text) {
  const found = [];
  for (const literal of text.matchAll(/'(?:[^'\\\n]|\\.)*'|"(?:[^"\\\n]|\\.)*"|`(?:[^`\\]|\\.)*`/g)) {
    const body = literal[0];
    if (!SQL_WORD.test(body)) continue;
    for (const table of body.matchAll(CORE_TABLE)) found.push(`core.${table[1]}`);
  }
  return found;
}

function importProblem(spec, from) {
  if (spec === '@buddi/core/plugin') return undefined;
  if (from.test && (spec === '@buddi/core/testing' || spec.startsWith('@buddi/core/testing/'))) return undefined;
  if (spec === '@buddi/core' || spec.startsWith('@buddi/core/')) {
    return `imports ${spec}; a plugin reaches core through ctx.buddi and @buddi/core/plugin${from.test ? ' (and @buddi/core/testing in a test)' : ''}`;
  }
  if (/^@buddi\/(runtime|gateway)(\/|$)/.test(spec) || /^@buddi\/tool-/.test(spec)) {
    return `imports ${spec}, which is buddi's own code, not the plugin API`;
  }
  if (spec.startsWith('.')) {
    const target = path.resolve(path.dirname(from.file), spec);
    if (target !== from.packageRoot && !target.startsWith(from.packageRoot + path.sep)) {
      return `imports ${spec}, outside its own package`;
    }
  }
  return undefined;
}

function pluginViolations(packageRoot) {
  const src = path.join(packageRoot, 'src');
  if (!existsSync(src)) return [];
  const found = [];
  for (const file of walk(src)) {
    const relative = path.relative(ROOT, file).split(path.sep).join('/');
    const test = TEST.test(file);
    const text = code(readFileSync(file, 'utf8'));
    for (const spec of specifiers(text)) {
      const problem = importProblem(spec, { file, packageRoot, test });
      if (problem !== undefined) found.push(`${relative}: ${problem}`);
    }
    if (!test) {
      for (const table of coreTables(text)) found.push(`${relative}: names ${table} in SQL; a plugin's queries stay in its own schema`);
    }
  }
  return found;
}

function selfTest() {
  const fixture = path.join(ROOT, 'fixture-plugin');
  const at = (name, test = false) => ({ file: path.join(fixture, 'src', name), packageRoot: fixture, test });
  const checks = [
    [importProblem('@buddi/core', at('index.ts')) !== undefined, 'refuses @buddi/core'],
    [importProblem('@buddi/core/testing', at('index.ts')) !== undefined, 'refuses @buddi/core/testing outside a test'],
    [importProblem('@buddi/core/testing', at('a.test.ts', true)) === undefined, 'allows @buddi/core/testing in a test'],
    [importProblem('@buddi/core/plugin', at('index.ts')) === undefined, 'allows @buddi/core/plugin'],
    [importProblem('@buddi/runtime', at('index.ts')) !== undefined, 'refuses @buddi/runtime'],
    [importProblem('@buddi/tool-email', at('index.ts')) !== undefined, 'refuses @buddi/tool-*'],
    [importProblem('../../buddi/packages/core/src/vault/index.js', at('index.ts')) !== undefined, 'refuses a way out of the package'],
    [JSON.stringify(coreTables(code("const g = ['-c', 'core.hooksPath=/x']; // select from core.agents\nq(`select * from core.events`)"))) === '["core.events"]', 'finds core.events in SQL only'],
  ];
  const failed = checks.filter(([ok]) => !ok).map(([, what]) => what);
  if (failed.length > 0) {
    console.error(`check-plugin-imports self-test failed: ${failed.join('; ')}`);
    process.exit(1);
  }
}

selfTest();
const plugins = readdirSync(ROOT)
  .map((name) => path.join(ROOT, name))
  .filter((dir) => statSync(dir).isDirectory() && existsSync(path.join(dir, 'package.json')) && !dir.includes('node_modules'));
const violations = plugins.flatMap((dir) => pluginViolations(dir));
if (violations.length > 0) {
  console.error('A plugin reaches past ctx.buddi:');
  for (const line of violations) console.error(`  ${line}`);
  process.exit(1);
}
console.log(`plugin imports: ${plugins.length} plugins import only @buddi/core/plugin and name no core table`);
