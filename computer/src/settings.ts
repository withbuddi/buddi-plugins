/**
 * The Computer plugin's own settings: the apps agents may open, the browser
 * app websites open in (and its Chromium profile), and what happens with an
 * app that is not on the list. One JSON file in the plugin's directory
 * (`<data>/plugins-data/computer/settings.json`), readable only by the owner.
 *
 * The first time it starts with no file, it takes the list buddi's browser
 * kept before computer control was a plugin (`<data>/browser/`:
 * `settings.apps.json`, `settings.v1.json` or `settings.json`, whichever
 * carries it), so nobody adds their apps twice.
 */
import { randomUUID } from 'node:crypto';
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { z } from 'zod';
import { BROWSER_APPS } from './apps.js';

/** At most this many apps on the list. */
export const MAX_APPS = 32;
const appId = z.string().min(3).max(200).regex(/^[A-Za-z0-9.-]+$/);

export const settingsSchema = z.object({
  allowedApps: z.array(appId).max(MAX_APPS).default(['com.google.Chrome', 'com.apple.Safari']),
  browserApp: z.enum(BROWSER_APPS).default('com.google.Chrome'),
  browserProfile: z.string().min(1).max(100).regex(/^[A-Za-z0-9 ._-]+$/).optional(),
  /** An app not on the list: ask the owner with a card (Allow once / Always), or do not open it. */
  unlisted: z.enum(['ask', 'refuse']).default('ask'),
}).strict();
export type ComputerSettings = z.infer<typeof settingsSchema>;

/** What buddi's browser kept for computer control, read past everything else. */
const legacySchema = z.object({
  allowedApps: z.array(appId).max(MAX_APPS).optional(),
  browserApp: z.enum(BROWSER_APPS).optional(),
  browserProfile: z.string().min(1).max(100).regex(/^[A-Za-z0-9 ._-]+$/).optional(),
}).passthrough();

async function readJson(file: string): Promise<unknown> {
  try { return JSON.parse(await readFile(file, 'utf8')); }
  catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined; throw error; }
}

/** The apps list buddi's browser kept, when one of its files carries it. */
export async function legacyApps(browserDir: string): Promise<Partial<ComputerSettings> | undefined> {
  for (const name of ['settings.apps.json', 'settings.v1.json', 'settings.json']) {
    let raw: unknown;
    try { raw = await readJson(path.join(browserDir, name)); } catch { continue; }
    const parsed = legacySchema.safeParse(raw);
    if (!parsed.success || parsed.data.allowedApps === undefined) continue;
    const { allowedApps, browserApp, browserProfile } = parsed.data;
    return { allowedApps, ...(browserApp ? { browserApp } : {}), ...(browserProfile ? { browserProfile } : {}) };
  }
  return undefined;
}

/** The settings file, read once and kept; every write is atomic. */
export class SettingsStore {
  #settings: ComputerSettings = settingsSchema.parse({});
  #loaded?: Promise<ComputerSettings>;
  constructor(readonly dir: string | undefined, readonly browserDir: string | undefined = dir ? path.resolve(dir, '..', '..', 'browser') : undefined) {}
  /** What is known now: the defaults until the file has been read. */
  get current(): ComputerSettings { return this.#settings; }
  /** The settings, once the file has been read (or seeded); always the latest after a save. */
  async load(): Promise<ComputerSettings> {
    await this.#read();
    return this.#settings;
  }
  #read(): Promise<ComputerSettings> {
    this.#loaded ??= (async () => {
      if (!this.dir) return this.#settings;
      const raw = await readJson(path.join(this.dir, 'settings.json')).catch(() => undefined);
      if (raw !== undefined) {
        const parsed = settingsSchema.safeParse(raw);
        if (parsed.success) { this.#settings = parsed.data; return this.#settings; }
      }
      const seeded = this.browserDir ? await legacyApps(this.browserDir) : undefined;
      this.#settings = settingsSchema.parse(seeded ?? {});
      if (seeded) await this.#write(this.#settings).catch(() => undefined);
      return this.#settings;
    })();
    return this.#loaded;
  }
  async save(next: ComputerSettings): Promise<ComputerSettings> {
    await this.load();
    const parsed = settingsSchema.parse(next);
    await this.#write(parsed);
    this.#settings = parsed;
    return parsed;
  }
  async #write(value: ComputerSettings): Promise<void> {
    if (!this.dir) return;
    await mkdir(this.dir, { recursive: true, mode: 0o700 });
    const file = path.join(this.dir, 'settings.json');
    const temp = `${file}.${randomUUID()}.tmp`;
    await writeFile(temp, JSON.stringify(value), { mode: 0o600 });
    await rename(temp, file);
  }
}
