/**
 * @withbuddi/plugin-computer — agents work in the apps on your Mac that you
 * allow (buddi's "your apps" route).
 *
 * The plugin provides one route to buddi's browser runtime (`route.ts`, host
 * API 1.29 `routes`), drives the owner's apps through a fixed native helper
 * (`helper.ts`, built from `native/Computer.swift`), keeps the list of apps
 * in its own settings (`settings.ts`) and draws Settings → Computer
 * (`page.ts`). macOS 14 or newer only: on any other computer it loads and
 * says so, and buddi never offers the route.
 */
import type { PluginManifest } from '@buddi/core/plugin';
import { computerPages, computerQueries, computerTools } from './page.js';
import { ComputerRoute, type RouteOptions } from './route.js';
import { SettingsStore } from './settings.js';
import { VERSION } from './version.js';

export const DESCRIPTION = 'Lets agents work in the apps on your Mac that you allow, through a small native helper: macOS accessibility and the app’s own window, signed in as you. One agent at a time; you can take over.';

/**
 * The manifest and the one route it provides. The route keeps its settings in
 * the directory `register()` hands it; a test passes `dir` (and a fake
 * helper, a fake Spotlight) instead.
 */
export function createComputer(options: RouteOptions & { dir?: string; browserDir?: string } = {}): { manifest: PluginManifest; route: ComputerRoute } {
  const route = new ComputerRoute(new SettingsStore(options.dir, options.browserDir), options);
  const manifest: PluginManifest = {
    name: 'computer',
    version: VERSION,
    schema: 'computer',
    migrationsDir: '',
    author: { name: 'withbuddi', url: 'https://withbuddi.com' },
    description: DESCRIPTION,
    tools: computerTools(() => route),
    pages: computerPages,
    queries: computerQueries(() => route),
    routes: [route],
    network: [{ host: '* (what the apps you allow reach)', why: 'Your apps use their own network and sign-ins; this plugin sends nothing itself. Each app window’s picture and accessibility text go to the agent’s model provider.' }],
    setup: { produce: async () => route.readiness() },
    register: (host) => {
      if (route.store.dir === undefined) route.store = new SettingsStore(host.dir.path, options.browserDir);
      void route.store.load().catch(() => undefined);
    },
  };
  return { manifest, route };
}

export const { manifest, route } = createComputer();
export default manifest;
export * from './apps.js';
export * from './errors.js';
export * from './helper.js';
export * from './route.js';
export * from './settings.js';
export { ComputerDriver } from './driver.js';
export { computerPages, computerQueries, computerTools, settingsView, INTRO, EMPTY_APPS, PAGE_ID } from './page.js';
