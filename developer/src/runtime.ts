/**
 * The three paths this plugin owns on disk, and the git options a workspace
 * row implies.
 *
 * One module because they are one decision — "where does the plugin keep its
 * own things" — and because `processes.ts`, `git`'s callers and the tools all
 * need the same answer.
 */
import { mkdir } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import type { BuddiHost } from '@buddi/core/plugin';
import type { GitOptions } from './git.js';
import type { Workspace } from './store.js';

/**
 * buddi's data directory, as a plugin can honestly resolve it.
 *
 * `BUDDI_DATA_DIR`, then `BUDDI_HOME`, then `~/.buddi` — never core's
 * `resolveDataDir`, which resolves `<repo>/data` relative to the *core
 * package's own* location and would put this plugin's logs inside
 * `node_modules` for a plugin installed the ordinary way.
 */
export function dataRoot(env: NodeJS.ProcessEnv = process.env): string {
  const dataDir = env.BUDDI_DATA_DIR?.trim();
  const home = env.BUDDI_HOME?.trim();
  return dataDir
    ? path.resolve(dataDir)
    : path.resolve(home || path.join(os.homedir(), '.buddi'));
}

export function logRoot(env: NodeJS.ProcessEnv = process.env): string {
  return path.join(dataRoot(env), 'developer', 'logs');
}

export function logPathFor(agentId: string, name: string, env?: NodeJS.ProcessEnv): string {
  const safe = (value: string): string => value.replace(/[^A-Za-z0-9_-]/g, '_');
  return path.join(logRoot(env), `${safe(agentId)}.${safe(name)}.log`);
}

/**
 * An empty directory that `core.hooksPath` points at, so that a repository's
 * own hooks — which an agent could have written before `.git/` was closed, or
 * which arrived with a clone — never run.
 *
 * It lives under buddi's data directory, which is itself on the deny list, so
 * nothing in a workspace can put a file in it.
 */
export function hooksDir(env: NodeJS.ProcessEnv = process.env): string {
  return path.join(dataRoot(env), 'developer', 'empty-hooks');
}

export async function ensureHooksDir(env: NodeJS.ProcessEnv = process.env): Promise<string> {
  const dir = hooksDir(env);
  await mkdir(dir, { recursive: true });
  return dir;
}

/**
 * Everything `git` needs, from the workspace row: the absolute binary and the
 * PATH the owner approved, plus the empty hooks directory.
 */
export function gitOptionsFor(
  workspace: Workspace,
  extra: { signal?: AbortSignal | undefined; env?: NodeJS.ProcessEnv | undefined } = {},
): GitOptions {
  return {
    cwd: workspace.dir,
    gitPath: workspace.gitPath,
    toolchainPath: workspace.toolchainPath,
    hooksDir: hooksDir(extra.env ?? process.env),
    ...(extra.env ? { env: extra.env } : {}),
    ...(extra.signal ? { signal: extra.signal } : {}),
  };
}

/* ------------------------------------------------------------------ *
 * The two ports a plugin has to know about
 * ------------------------------------------------------------------ */

/** The dashboard's own port: `BUDDI_WEB_PORT`, else the gateway's default. */
export const DEFAULT_WEB_PORT = 4317;

export function dashboardPort(env: NodeJS.ProcessEnv = process.env): number {
  const raw = Number((env.BUDDI_WEB_PORT ?? '').trim());
  return Number.isInteger(raw) && raw > 0 && raw <= 65535 ? raw : DEFAULT_WEB_PORT;
}

/**
 * The port previews are served on — a *second* listener, not the dashboard's.
 *
 * It is never guessed. "The dashboard plus one" is wrong the moment that port
 * was taken, and a tailnet route pointing at the wrong port is a route to
 * somebody else's service. Core hands the real number over two ways, and both
 * are read here and nowhere else: `ToolContext.previewPort`, set by the
 * gateway on every call, and `BUDDI_PREVIEW_PORT`, which it sets in the
 * environment after binding.
 *
 * `undefined` is an answer: this buddi is not serving previews, and the
 * callers say so rather than pointing at a number.
 */
export function previewPortFor(
  ctx: { buddi?: BuddiHost | undefined },
  env: NodeJS.ProcessEnv = process.env,
): number | undefined {
  const port = ctx.buddi?.pages.previewPort();
  if (port !== undefined && Number.isInteger(port)) return port;
  const raw = Number((env.BUDDI_PREVIEW_PORT ?? '').trim());
  return Number.isInteger(raw) && raw > 0 && raw <= 65535 ? raw : undefined;
}
