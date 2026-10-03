/**
 * The apps on this Mac: who a name stands for (Spotlight), the installed list
 * the settings page offers (each bundle's Info.plist), and a Chromium
 * browser's profiles. Nothing here launches an app or reads more than its
 * manifest.
 */
import { readdir, readFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import path from 'node:path';
import type { RouteTarget } from '@buddi/core/plugin';
import { PreconditionError } from './errors.js';
import { execText } from './helper.js';

/** One installed application, as macOS names it. */
export interface InstalledApp { id: string; name: string }
/** By display name, by bundle id, or (`near`) the ones close to a name that matched nothing. */
export type AppQuery = { name: string } | { id: string } | { near: string };
export type AppResolver = (query: AppQuery) => Promise<InstalledApp[]>;

/** Levenshtein distance. */
function editDistance(a: string, b: string): number {
  let previous = Array.from({ length: b.length + 1 }, (_, i) => i);
  for (let i = 1; i <= a.length; i++) {
    const row = [i];
    for (let j = 1; j <= b.length; j++) row[j] = Math.min(previous[j]! + 1, row[j - 1]! + 1, previous[j - 1]! + (a[i - 1] === b[j - 1] ? 0 : 1));
    previous = row;
  }
  return previous[b.length]!;
}

/**
 * A display name close to what was asked, ignoring case: one contains the
 * other (three letters at least), or a small edit distance — two for a name
 * up to eight characters, three above, always less than half of what was
 * asked. The same name is not "close": it matched.
 */
export function isNearName(asked: string, name: string): boolean {
  const a = asked.trim().toLowerCase(); const n = name.trim().toLowerCase().replace(/\.app$/, '');
  if (!a || !n || a === n) return false;
  if (Math.min(a.length, n.length) >= 3 && (n.includes(a) || a.includes(n))) return true;
  const limit = Math.min(Math.max(a.length, n.length) <= 8 ? 2 : 3, Math.floor((a.length - 1) / 2));
  return Math.abs(a.length - n.length) <= limit && editDistance(a, n) <= limit;
}

const appName = (appPath: string) => appPath.replace(/^.*\//, '').replace(/\.app$/i, '');
async function describeApps(paths: string[]): Promise<InstalledApp[]> {
  const found = await Promise.all(paths.map(async (appPath) => {
    try {
      const [id, name] = (await execText('mdls', ['-raw', '-nullMarker', '', '-name', 'kMDItemCFBundleIdentifier', '-name', 'kMDItemDisplayName', appPath])).split('\0');
      return id?.trim() ? [{ id: id.trim(), name: (name ?? '').trim().replace(/\.app$/i, '') || appName(appPath) }] : [];
    } catch { return []; }
  }));
  return found.flat();
}

/**
 * Installed applications through Spotlight: `mdfind` for the bundles, `mdls`
 * for each one's id and display name. A name matches exactly, ignoring case,
 * with or without `.app`; `near` keeps the few application bundles whose file
 * name is close.
 */
export const spotlightApps: AppResolver = async (query) => {
  if (process.platform !== 'darwin') return [];
  const quoted = (text: string) => text.replace(/[\\'"*?]/g, (c) => `\\${c}`);
  const bundles = "kMDItemContentType == 'com.apple.application-bundle'";
  const filter = 'near' in query ? bundles
    : 'name' in query ? `${bundles} && (kMDItemDisplayName == '${quoted(query.name)}'c || kMDItemDisplayName == '${quoted(query.name)}.app'c)`
    : `${bundles} && kMDItemCFBundleIdentifier == '${quoted(query.id)}'`;
  const bundlePaths = (await execText('mdfind', [filter])).split('\n').map((line) => line.trim()).filter(Boolean);
  const paths = 'near' in query ? bundlePaths.slice(0, 5_000).filter((appPath) => isNearName(query.near, appName(appPath))).slice(0, 10) : bundlePaths.slice(0, 20);
  return describeApps(paths);
};

const unique = (apps: InstalledApp[]) => [...new Map(apps.map((app) => [app.id, app])).values()];
const listed = (apps: InstalledApp[]) => apps.map((app) => `${app.name} (${app.id})`).join(', ');

/**
 * The one application a name or a bundle id stands for, or the refusal.
 * Several copies of the same bundle id are one app. A name that matches
 * nothing gets the close names back, never one picked for the agent.
 */
export async function resolveApp(query: { name: string } | { id: string }, resolver: AppResolver = spotlightApps): Promise<RouteTarget> {
  let found: InstalledApp[];
  try { found = await resolver(query); } catch { found = []; }
  if ('id' in query) found = found.filter((app) => app.id === query.id);
  else found = found.filter((app) => app.name.toLowerCase() === query.name.trim().toLowerCase());
  const apps = unique(found);
  const asked = 'name' in query ? query.name.trim() : query.id;
  if (apps.length === 0 && 'name' in query) {
    let near: InstalledApp[];
    try { near = unique((await resolver({ near: asked })).filter((app) => isNearName(asked, app.name))).slice(0, 5); } catch { near = []; }
    if (near.length === 1) throw new PreconditionError(`No app called ${asked}. Did you mean ${listed(near)}? Ask again with that name.`);
    if (near.length > 1) throw new PreconditionError(`No app called ${asked}. Close names: ${listed(near)}. Say which.`);
  }
  if (apps.length === 0) throw new PreconditionError('name' in query ? `No installed app is called ${asked}.` : `No installed app has the bundle id ${asked}.`);
  if (apps.length > 1) throw new PreconditionError(`Several apps are called ${asked}: ${listed(apps)}. Say which bundle id.`);
  return { id: apps[0]!.id, name: apps[0]!.name };
}

/* ---------------- the list the settings page offers ---------------- */

const CACHE_MS = 5 * 60_000;
let cache: { at: number; apps: InstalledApp[] } | null = null;

/** The apps in the three places macOS puts them, by their Info.plist; cached five minutes. */
export async function installedApps(now = Date.now()): Promise<InstalledApp[]> {
  if (cache && now - cache.at < CACHE_MS) return cache.apps;
  if (process.platform !== 'darwin') return [];
  const roots = ['/Applications', '/System/Applications', '/System/Applications/Utilities', path.join(homedir(), 'Applications')];
  const found = new Map<string, InstalledApp>();
  for (const root of roots) {
    let entries: string[];
    try { entries = await readdir(root); } catch { continue; }
    await Promise.all(entries.filter((e) => e.endsWith('.app')).map(async (entry) => {
      const app = await readApp(path.join(root, entry));
      if (app && !found.has(app.id)) found.set(app.id, app);
    }));
  }
  const apps = [...found.values()].sort((a, b) => a.name.localeCompare(b.name));
  cache = { at: now, apps };
  return apps;
}

async function readApp(appPath: string): Promise<InstalledApp | null> {
  try {
    const info = JSON.parse(await execText('plutil', ['-convert', 'json', '-o', '-', path.join(appPath, 'Contents', 'Info.plist')])) as { CFBundleIdentifier?: string; CFBundleDisplayName?: string; CFBundleName?: string };
    if (!info.CFBundleIdentifier) return null;
    return { id: info.CFBundleIdentifier, name: info.CFBundleDisplayName || info.CFBundleName || path.basename(appPath, '.app') };
  } catch { return null; }
}

/* ---------------- the browser app ---------------- */

/** The browsers agents may open websites in (`navigate`). */
export const BROWSER_APPS = ['com.google.Chrome', 'com.apple.Safari', 'org.chromium.Chromium', 'com.microsoft.edgemac', 'com.brave.Browser', 'org.mozilla.firefox'] as const;
/** The ones that keep several profiles and accept `--profile-directory`. */
export const CHROMIUM_APPS: readonly string[] = ['com.google.Chrome', 'org.chromium.Chromium', 'com.microsoft.edgemac', 'com.brave.Browser'];
const PROFILE_STATE: Record<string, string> = {
  'com.google.Chrome': 'Google/Chrome',
  'org.chromium.Chromium': 'Chromium',
  'com.microsoft.edgemac': 'Microsoft Edge',
  'com.brave.Browser': 'BraveSoftware/Brave-Browser',
};

/** A Chromium browser's profiles, from its own "Local State": names and folders only. */
export async function browserProfiles(app: string): Promise<Array<{ directory: string; name: string }>> {
  const folder = PROFILE_STATE[app];
  if (!folder || process.platform !== 'darwin') return [];
  try {
    const state = JSON.parse(await readFile(path.join(homedir(), 'Library', 'Application Support', folder, 'Local State'), 'utf8')) as { profile?: { info_cache?: Record<string, { name?: string }> } };
    return Object.entries(state.profile?.info_cache ?? {})
      .map(([directory, info]) => ({ directory, name: info.name || directory }))
      .sort((a, b) => a.name.localeCompare(b.name));
  } catch { return []; }
}
