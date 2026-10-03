/**
 * The apps route this plugin provides (buddi's host API 1.29 `routes`;
 * docs/browser.md, "A route a plugin provides").
 *
 * buddi picks the route per task, queues conversations (one at a time:
 * `exclusive`), draws the "Use Numbers on your computer?" card and keeps the
 * Once answers; this answers the rest: is the route healthy (the helper on
 * disk, macOS's two permissions), who an app's name stands for, whether it is
 * on the owner's list, and the look and the input themselves, through the
 * native helper. macOS only: elsewhere buddi never offers it.
 */
import { checkUrl, type PluginReadiness, type RouteCommand, type RouteHealth, type RoutePage, type RouteProvider, type RouteReach, type RouteTarget } from '@buddi/core/plugin';
import { resolveApp, spotlightApps, type AppResolver } from './apps.js';
import { ComputerDriver, type UrlCheck } from './driver.js';
import { HELPER_MISSING, HELPER_PATH, MAC_ONLY, NativeBridge, helperPresent, type ComputerBridge } from './helper.js';
import { MAX_APPS, SettingsStore } from './settings.js';

/** macOS's two permissions, as the helper last read them. */
export interface Permissions { accessibility: boolean; screenRecording: boolean; checkedAt: number }

export interface RouteOptions {
  platform?: NodeJS.Platform;
  /** The helper's path; a test points it at a fake. */
  helper?: string;
  /** One bridge per conversation; a test hands a fake. */
  bridge?: () => ComputerBridge;
  resolver?: AppResolver;
  checkUrl?: UrlCheck;
  now?: () => number;
}

/** Permissions are read again at most this often while the dashboard polls. */
const PERMISSIONS_TTL_MS = 60_000;
/** Conversations whose state is kept; the oldest is let go past it. */
const MAX_SESSIONS = 20;

export const ACCESSIBILITY_MISSING = 'macOS hasn’t allowed Accessibility, so agents can’t click or type.';
export const SCREEN_MISSING = 'macOS hasn’t allowed Screen Recording, so agents can’t see app windows.';

export class ComputerRoute implements RouteProvider {
  readonly kind = 'apps' as const;
  readonly label = 'your apps';
  readonly platforms = ['darwin'] as const;
  readonly exclusive = true;
  readonly handMessage = 'Take over at the Mac itself: the agent sends nothing until you give it back here.';
  readonly reach: RouteReach;
  #sessions = new Map<string, ComputerDriver>();
  #names = new Map<string, string>();
  #permissions?: Permissions | undefined;
  #reading?: Promise<Permissions | undefined> | undefined;

  /** Replaced once by `register`, when buddi hands the plugin its directory. */
  store: SettingsStore;
  constructor(store: SettingsStore, readonly options: RouteOptions = {}) {
    this.store = store;
    const route = this;
    this.reach = {
      async resolve(query) { return route.#remember(await resolveApp('name' in query ? { name: query.name } : { id: query.id }, route.options.resolver ?? spotlightApps)); },
      async listed(id) { return (await route.store.load()).allowedApps.includes(id); },
      async unlisted() { return (await route.store.load()).unlisted; },
      async remember(target: RouteTarget) {
        const settings = await route.store.load();
        if (settings.allowedApps.includes(target.id)) return true;
        if (settings.allowedApps.length >= MAX_APPS) return false;
        route.#remember(target);
        await route.store.save({ ...settings, allowedApps: [...settings.allowedApps, target.id] });
        return true;
      },
    };
  }

  get onMac(): boolean { return (this.options.platform ?? process.platform) === 'darwin'; }
  get helperPath(): string { return this.options.helper ?? HELPER_PATH; }
  helperPresent(): boolean { return helperPresent(this.helperPath); }
  bridge(): ComputerBridge { return this.options.bridge?.() ?? new NativeBridge(this.helperPath, this.options.platform ?? process.platform); }
  #now(): number { return this.options.now?.() ?? Date.now(); }
  #remember(target: RouteTarget): RouteTarget { if (target.name !== target.id) this.#names.set(target.id, target.name); return target; }
  /** An app's name, as Spotlight last said it; undefined for one never resolved. */
  nameOf(id: string): string | undefined { return this.#names.get(id); }

  /* ---------------- health and readiness ---------------- */

  get permissions(): Permissions | undefined { return this.#permissions; }
  /** Ask the helper again; `prompt` puts macOS's own dialogs in front of the owner. */
  async checkPermissions(prompt = false): Promise<Permissions | undefined> {
    if (!this.onMac || !this.helperPresent()) return undefined;
    const answer = await this.bridge().run({ operation: 'permissions', prompt });
    this.#permissions = { accessibility: answer.accessibility === true, screenRecording: answer.screenRecording === true, checkedAt: this.#now() };
    return this.#permissions;
  }
  #refresh(): void {
    if (this.#reading || (this.#permissions && this.#now() - this.#permissions.checkedAt < PERMISSIONS_TTL_MS)) return;
    this.#reading = this.checkPermissions(false).catch(() => undefined).finally(() => { this.#reading = undefined; });
  }

  /** What buddi's Where agents may look row shows, and whether app jobs can run now. Never waits on the helper. */
  health(): RouteHealth {
    if (!this.onMac) return { ok: false, message: MAC_ONLY };
    if (!this.helperPresent()) return { ok: false, message: HELPER_MISSING, repair: 'helper' };
    this.#refresh();
    const known = this.#permissions;
    if (known && !known.accessibility) return { ok: false, message: ACCESSIBILITY_MISSING, repair: 'permissions' };
    if (known && !known.screenRecording) return { ok: false, message: SCREEN_MISSING, repair: 'permissions' };
    return { ok: true };
  }

  /** The Plugins page's readiness: macOS, the helper, and both permissions. */
  async readiness(): Promise<PluginReadiness> {
    if (!this.onMac) return { ready: false, note: 'macOS only: on this computer agents use buddi’s own browser and your Chrome.' };
    if (!this.helperPresent()) return { ready: false, note: 'The helper is missing: reinstall the Computer plugin.', page: 'computer' };
    let known = this.#permissions;
    if (!known) { try { known = await this.checkPermissions(false); } catch { known = undefined; } }
    if (!known) return { ready: false, note: 'The helper did not answer. Check again on Settings → Computer.', page: 'computer' };
    if (!known.accessibility || !known.screenRecording) return { ready: false, note: 'Allow Accessibility and Screen Recording for the helper in macOS.', page: 'computer' };
    return { ready: true };
  }

  /* ---------------- one conversation's apps ---------------- */

  #driver(session: string): ComputerDriver {
    let driver = this.#sessions.get(session);
    if (driver) { this.#sessions.delete(session); this.#sessions.set(session, driver); return driver; }
    driver = new ComputerDriver({
      bridge: this.bridge(),
      settings: () => this.store.current,
      nameOf: async (id) => this.#names.get(id) ?? (await this.reach.resolve({ id }).then((t) => t.name, () => undefined)),
      checkUrl: this.options.checkUrl ?? ((url) => checkUrl(url).url),
    });
    this.#sessions.set(session, driver);
    while (this.#sessions.size > MAX_SESSIONS) {
      const oldest = this.#sessions.keys().next().value as string;
      void this.#sessions.get(oldest)?.release();
      this.#sessions.delete(oldest);
    }
    return driver;
  }
  async do(session: string, command: RouteCommand): Promise<void> {
    if (!this.onMac) throw Object.assign(new Error(MAC_ONLY), { precondition: true });
    await this.store.load();
    await this.#driver(session).perform(command);
  }
  look(session: string): Promise<RoutePage> { return this.#driver(session).look(); }
  async release(session: string): Promise<void> { await this.#sessions.get(session)?.release(); }
  async takeover(session: string): Promise<void> { await this.#sessions.get(session)?.takeover(); }
  resume(session: string): void { this.#sessions.get(session)?.resume(); }
  focused(session: string): Promise<string | undefined> { return this.#driver(session).focused(); }
  typeSecret(session: string, value: string): Promise<void> { return this.#driver(session).typeSecret(value); }
}
