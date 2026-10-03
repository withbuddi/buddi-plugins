/**
 * Settings → Computer: the design kit's computer-plugin page (Browser.jsx,
 * `ComputerSettings`). Three panels: On this Mac (the helper, Accessibility,
 * Screen Recording, each with its repair), Apps agents may use (the list, the
 * browser app, Add an app), and Another app (ask, or do not open it).
 *
 * The writes are owner-only tools: the dashboard calls them as the owner, and
 * no agent ever sees them. An agent reaches the list only through the
 * owner's Always on buddi's card (`reach.remember`).
 */
import { z } from 'zod';
import type { PageDescriptor, PageQuery, ToolDefinition } from '@buddi/core/plugin';
import { BROWSER_APPS, CHROMIUM_APPS, browserProfiles, installedApps, resolveApp, spotlightApps } from './apps.js';
import { helperFacts, HELPER_MISSING, MAC_ONLY } from './helper.js';
import { ACCESSIBILITY_MISSING, SCREEN_MISSING, type ComputerRoute } from './route.js';
import { MAX_APPS } from './settings.js';

export const PAGE_ID = 'computer';
export const INTRO = 'Agents work in the apps below when you name one, in their own windows, signed in as you. One agent at a time; you can take over from the Canvas. Turn your apps on or off in Settings → Computer & browser.';
export const EMPTY_APPS = 'No app yet. Add the apps agents may open. Until then they ask you each time.';

const initials = (name: string) => name.split(/\s+/).map((word) => word[0] ?? '').join('').slice(0, 2).toUpperCase();
const isBrowser = (id: string): boolean => (BROWSER_APPS as readonly string[]).includes(id);

/** The page's one read: the three checks, the apps, the choices. */
export async function settingsView(route: ComputerRoute): Promise<Record<string, unknown>> {
  const settings = await route.store.load();
  const onMac = route.onMac;
  const present = onMac && route.helperPresent();
  let version: string | undefined;
  if (present) version = (await helperFacts(route.bridge(), route.helperPath)).version;
  let permissions = route.permissions;
  if (present && !permissions) { try { permissions = await route.checkPermissions(false); } catch { permissions = undefined; } }
  const check = (id: string, name: string, ok: boolean, line: string, problem: string, word: string) => ({
    id, name, line: ok ? line : '', state: ok ? word : 'needed', status: ok ? '' : problem, canRequest: !ok && id !== 'helper' && present,
  });
  const checks = onMac ? [
    check('helper', 'Helper', present, `buddi-computer${version ? ` ${version}` : ''}, installed`, HELPER_MISSING, 'installed'),
    check('accessibility', 'Accessibility', present && permissions?.accessibility === true, 'Lets agents click and type in the apps below', present ? ACCESSIBILITY_MISSING : 'Needs the helper first.', 'allowed'),
    check('screen', 'Screen Recording', present && permissions?.screenRecording === true, 'Lets agents see the apps below', present ? SCREEN_MISSING : 'Needs the helper first.', 'allowed'),
  ] : [];
  const names = new Map((await installedApps().catch(() => [])).map((app) => [app.id, app.name]));
  const nameOf = (id: string) => names.get(id) ?? route.nameOf(id) ?? id;
  const apps = settings.allowedApps.map((id) => ({
    id, name: nameOf(id), initials: initials(nameOf(id)),
    role: id === settings.browserApp ? 'browser' : '',
    canUseAsBrowser: id !== settings.browserApp && isBrowser(id),
  }));
  return {
    onMac, notMacNote: onMac ? '' : MAC_ONLY,
    checks, ready: checks.length > 0 && checks.every((c) => c.status === ''),
    apps, appsEmpty: apps.length === 0, full: apps.length >= MAX_APPS,
    unlisted: settings.unlisted,
    browserApp: settings.browserApp, chromium: CHROMIUM_APPS.includes(settings.browserApp) && settings.allowedApps.includes(settings.browserApp),
    browserProfile: settings.browserProfile ?? '',
  };
}

export function computerQueries(route: () => ComputerRoute): PageQuery[] {
  return [
    { name: 'settings', params: z.object({}).strict(), produce: async () => settingsView(route()) },
    {
      name: 'installed',
      params: z.object({}).strict(),
      async produce() {
        const listed = new Set((await route().store.load()).allowedApps);
        return { apps: (await installedApps().catch(() => [])).filter((app) => !listed.has(app.id)).map((app) => ({ value: app.id, label: app.name })) };
      },
    },
    {
      name: 'profiles',
      params: z.object({}).strict(),
      async produce() {
        const settings = await route().store.load();
        const found = await browserProfiles(settings.browserApp);
        return { profiles: [{ value: '', label: 'Whichever is in front' }, ...found.map((p) => ({ value: p.directory, label: p.directory === 'Default' ? p.name : `${p.name} (${p.directory})` }))] };
      },
    },
  ];
}

const appIdInput = z.string().trim().min(3).max(200).regex(/^[A-Za-z0-9.-]+$/, 'a bundle id, like com.apple.Numbers');

export function computerTools(route: () => ComputerRoute): ToolDefinition<any, unknown>[] {
  const check: ToolDefinition<{ prompt?: boolean | undefined }, unknown> = {
    name: 'computer.check', tier: 'auto', ownerOnly: true,
    description: 'Read the computer helper and macOS permissions again; with prompt, put macOS’s own Allow dialogs in front of the owner.',
    input: z.object({ prompt: z.boolean().optional() }).strict(),
    async execute(input) {
      const r = route();
      if (!r.onMac) return { note: MAC_ONLY };
      if (!r.helperPresent()) return { note: HELPER_MISSING };
      const permissions = await r.checkPermissions(input.prompt === true);
      if (permissions?.accessibility && permissions.screenRecording) return { note: 'Everything is allowed. Agents can work in your apps.' };
      return { note: input.prompt ? 'macOS asked. Allow the helper in System Settings → Privacy & Security, then Check again; macOS may ask you to restart buddi.' : 'Not everything is allowed yet. Press Allow in macOS on the row that needs it.' };
    },
  };
  const add: ToolDefinition<{ app: string }, unknown> = {
    name: 'computer.add_app', tier: 'auto', ownerOnly: true,
    description: 'Put an app on the list agents may open, by its bundle id or its name.',
    input: z.object({ app: z.string().trim().min(1).max(200) }).strict(),
    async execute(input) {
      const r = route();
      const settings = await r.store.load();
      if (settings.allowedApps.length >= MAX_APPS) return { note: `The list is full (${MAX_APPS} apps). Remove one first.` };
      const target = appIdInput.safeParse(input.app).success && input.app.includes('.')
        ? await resolveApp({ id: input.app }, r.options.resolver ?? spotlightApps).catch(() => ({ id: input.app, name: input.app }))
        : await resolveApp({ name: input.app }, r.options.resolver ?? spotlightApps);
      if (settings.allowedApps.includes(target.id)) return { note: `${target.name} is on the list already.` };
      await r.store.save({ ...settings, allowedApps: [...settings.allowedApps, target.id] });
      await r.reach.resolve({ id: target.id }).catch(() => undefined);
      return { note: `Added ${target.name}. Agents open it without asking.` };
    },
  };
  const remove: ToolDefinition<{ id: string }, unknown> = {
    name: 'computer.remove_app', tier: 'auto', ownerOnly: true,
    description: 'Take an app off the list agents may open.',
    input: z.object({ id: appIdInput }).strict(),
    async execute(input) {
      const r = route();
      const settings = await r.store.load();
      const allowedApps = settings.allowedApps.filter((id) => id !== input.id);
      // The browser goes with it: the next browser on the list takes its place.
      const browserApp = input.id === settings.browserApp ? (allowedApps.find(isBrowser) as typeof settings.browserApp | undefined) ?? settings.browserApp : settings.browserApp;
      await r.store.save({ ...settings, allowedApps, browserApp });
      return { note: `Removed ${r.nameOf(input.id) ?? input.id}. Agents ask you before opening it.` };
    },
  };
  const browser: ToolDefinition<{ id: (typeof BROWSER_APPS)[number] }, unknown> = {
    name: 'computer.use_as_browser', tier: 'auto', ownerOnly: true,
    description: 'The listed browser websites open in.',
    input: z.object({ id: z.enum(BROWSER_APPS) }).strict(),
    async execute(input) {
      const r = route();
      const settings = await r.store.load();
      if (!settings.allowedApps.includes(input.id)) return { note: 'Add that browser to the list first.' };
      const { browserProfile: _profile, ...rest } = settings;
      await r.store.save({ ...rest, browserApp: input.id });
      return { note: `Websites open in ${r.nameOf(input.id) ?? input.id} now.` };
    },
  };
  const unlisted: ToolDefinition<{ unlisted: 'ask' | 'refuse' }, unknown> = {
    name: 'computer.set_unlisted', tier: 'auto', ownerOnly: true,
    description: 'What happens when an agent wants an app that is not on the list.',
    input: z.object({ unlisted: z.enum(['ask', 'refuse']) }).strict(),
    async execute(input) {
      const r = route();
      await r.store.save({ ...(await r.store.load()), unlisted: input.unlisted });
      return { note: input.unlisted === 'ask' ? 'Saved. Agents ask you with a card for an app that isn’t listed.' : 'Saved. Agents don’t open an app that isn’t listed.' };
    },
  };
  const profile: ToolDefinition<{ profile: string }, unknown> = {
    name: 'computer.set_profile', tier: 'auto', ownerOnly: true,
    description: 'Which of the browser’s profiles websites open in; empty for whichever is in front.',
    input: z.object({ profile: z.union([z.literal(''), z.string().min(1).max(100).regex(/^[A-Za-z0-9 ._-]+$/)]) }).strict(),
    async execute(input) {
      const r = route();
      const { browserProfile: _old, ...rest } = await r.store.load();
      await r.store.save(input.profile ? { ...rest, browserProfile: input.profile } : rest);
      return { note: input.profile ? `Websites open in the ${input.profile} profile.` : 'Websites open in whichever profile is in front.' };
    },
  };
  return [check, add, remove, browser, unlisted, profile];
}

export const computerPages: PageDescriptor[] = [
  {
    id: PAGE_ID,
    title: 'Computer',
    place: 'settings',
    icon: 'plug',
    data: { query: 'settings' },
    body: [
      { kind: 'notice', text: INTRO },
      { kind: 'notice', tone: 'warning', text: { path: 'notMacNote' }, when: { path: 'onMac', equals: false } },
      {
        kind: 'section',
        title: 'On this Mac',
        when: { path: 'onMac', equals: true },
        actions: [{ kind: 'button', action: { tool: 'computer.check', label: 'Check again', busy: 'Checking…', done: { path: 'note' }, then: 'refresh' } }],
        body: [
          {
            kind: 'list',
            query: { query: 'settings' },
            rows: 'checks',
            key: 'id',
            item: {
              title: { path: 'name' },
              sub: { path: 'line' },
              pill: { value: { path: 'state' }, labels: { installed: 'installed', allowed: 'allowed', needed: 'needed' }, tones: { installed: 'good', allowed: 'good', needed: 'critical' } },
              status: { text: { path: 'status' }, tone: 'critical' },
            },
            actions: [
              { tool: 'computer.check', label: 'Allow in macOS', tone: 'accent', busy: 'Asking macOS…', done: { path: 'note' }, then: 'refresh', args: { prompt: { const: true } }, when: { path: 'canRequest', equals: true } },
            ],
          },
        ],
      },
      {
        kind: 'section',
        title: 'Apps agents may use',
        body: [
          {
            kind: 'list',
            query: { query: 'settings' },
            rows: 'apps',
            key: 'id',
            item: {
              title: { path: 'name' },
              sub: { path: 'id' },
              logo: { asset: { path: 'initials' }, label: { path: 'name' } },
              pill: { value: { path: 'role' }, tone: 'accent' },
            },
            actions: [
              { tool: 'computer.use_as_browser', label: 'Use as browser', done: { path: 'note' }, then: 'refresh', args: { id: { row: 'id' } }, when: { path: 'canUseAsBrowser', equals: true } },
              { tool: 'computer.remove_app', label: 'Remove', done: { path: 'note' }, then: 'refresh', args: { id: { row: 'id' } } },
            ],
            empty: EMPTY_APPS,
          },
          {
            kind: 'form',
            when: { path: 'full', equals: false },
            drawer: { title: 'Add an app', button: 'Add an app' },
            fields: [
              { name: 'app', label: 'App', type: 'select', required: true, optionsFrom: { query: { query: 'installed' }, rows: 'apps', value: 'value', label: 'label' }, hint: 'An app on this Mac. Agents open it without asking; what they see in it goes to their model.' },
            ],
            submit: { tool: 'computer.add_app', label: 'Add', tone: 'accent', busy: 'Adding…', done: { path: 'note' }, then: 'close', args: { app: { field: 'app' } } },
          },
          {
            kind: 'form',
            when: { path: 'chromium', equals: true },
            initial: { query: 'settings' },
            fields: [
              { name: 'browserProfile', label: 'Websites open in', type: 'select', from: 'browserProfile', optionsFrom: { query: { query: 'profiles' }, rows: 'profiles', value: 'value', label: 'label' }, hint: 'The browser’s profile, signed in as it is.' },
            ],
            submit: { tool: 'computer.set_profile', label: 'Save', busy: 'Saving…', done: { path: 'note' }, args: { profile: { field: 'browserProfile' } } },
          },
        ],
      },
      {
        kind: 'section',
        title: 'Another app',
        body: [
          {
            kind: 'form',
            initial: { query: 'settings' },
            fields: [
              {
                name: 'unlisted', label: 'When an agent wants an app that isn’t listed', type: 'select', from: 'unlisted',
                hint: 'Ask: a card in the chat, Allow once or Always (added to the list).',
                options: [{ value: 'ask', label: 'Ask me' }, { value: 'refuse', label: 'Don’t open it' }],
              },
            ],
            submit: { tool: 'computer.set_unlisted', label: 'Save', busy: 'Saving…', done: { path: 'note' }, args: { unlisted: { field: 'unlisted' } } },
          },
        ],
      },
    ],
  },
];
