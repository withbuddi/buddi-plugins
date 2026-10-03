import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { ToolRegistry } from '@buddi/core/testing';
import { routeProviderProblem } from '@buddi/core/plugin';
import { createComputer, manifest, resolveApp, isNearName, type AppQuery } from './index.js';
import { ACCESSIBILITY_MISSING, SCREEN_MISSING } from './route.js';
import { HELPER_MISSING, MAC_ONLY } from './helper.js';
import { fakeHelper, type FakeHelperConfig } from './testing/fake-helper.js';

const cleanup: string[] = [];
afterEach(async () => { for (const dir of cleanup.splice(0)) await rm(dir, { recursive: true, force: true }); });
const apps = [{ id: 'com.apple.Numbers', name: 'Numbers' }, { id: 'com.apple.Safari', name: 'Safari' }, { id: 'com.google.Chrome', name: 'Google Chrome' }];
const resolver = async (query: AppQuery) => apps.filter((app) => 'near' in query ? isNearName(query.near, app.name) : 'name' in query ? app.name.toLowerCase() === query.name.toLowerCase() : app.id === query.id);

async function computer(config: FakeHelperConfig = {}, over: { platform?: NodeJS.Platform; helper?: string; browserDir?: string } = {}) {
  const helper = await fakeHelper(config);
  const dir = await mkdtemp(path.join(tmpdir(), 'computer-data-'));
  cleanup.push(helper.dir, dir);
  const made = createComputer({ dir, browserDir: over.browserDir ?? path.join(dir, 'no-browser'), platform: over.platform ?? 'darwin', helper: over.helper ?? helper.path, resolver });
  return { ...made, dir, helper };
}
const ctx = { ownerId: 'owner', agentId: 'owner' } as never;

describe('the manifest', () => {
  it('registers with buddi: one apps route, macOS only, exclusive, with reach, take-over and native typing', () => {
    const registry = new ToolRegistry();
    registry.register(manifest);
    const [route] = registry.routeProviders();
    expect(route).toMatchObject({ kind: 'apps', label: 'your apps', platforms: ['darwin'], exclusive: true, plugin: 'computer' });
    expect(route!.handMessage).toMatch(/^Take over at the Mac/);
    expect(typeof route!.reach?.resolve).toBe('function');
    expect(typeof route!.focused).toBe('function');
    expect(routeProviderProblem(manifest.routes![0])).toBeUndefined();
  });
  it('gives the owner a Settings page with the kit\'s three panels, and only owner-only writes', () => {
    const registry = new ToolRegistry();
    registry.register(manifest);
    const page = registry.pages().find((p) => p.plugin === 'computer')!;
    expect(page).toMatchObject({ id: 'computer', title: 'Computer', place: 'settings' });
    expect(page.body.filter((c) => c.kind === 'section').map((c) => (c as { title?: string }).title)).toEqual(['On this Mac', 'Apps agents may use', 'Another app']);
    expect(manifest.tools.every((tool) => tool.ownerOnly === true)).toBe(true);
  });
  it('agrees with package.json: version, author, host API 1.29', () => {
    const pkg = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8')) as { version: string; author: { name: string }; buddi: { name: string; hostApi: string } };
    expect(manifest.version).toBe(pkg.version);
    expect(manifest.author?.name).toBe(pkg.author.name);
    expect(pkg.buddi).toMatchObject({ name: 'computer', hostApi: '^1.29' });
  });
});

describe('readiness and health', () => {
  it('is ready with the helper and both permissions', async () => {
    const { route } = await computer();
    await expect(route.readiness()).resolves.toEqual({ ready: true });
    expect(route.health()).toEqual({ ok: true });
  });
  it('says which macOS permission is missing, with the repair', async () => {
    const { route } = await computer({ permissions: { accessibility: true, screenRecording: false } });
    await expect(route.readiness()).resolves.toMatchObject({ ready: false, page: 'computer', note: 'Allow Accessibility and Screen Recording for the helper in macOS.' });
    expect(route.health()).toEqual({ ok: false, message: SCREEN_MISSING, repair: 'permissions' });
    const blind = await computer({ permissions: { accessibility: false, screenRecording: true } });
    await blind.route.checkPermissions();
    expect(blind.route.health()).toEqual({ ok: false, message: ACCESSIBILITY_MISSING, repair: 'permissions' });
  });
  it('says the helper is missing', async () => {
    const { route } = await computer({}, { helper: '/nowhere/buddi-computer' });
    expect(route.health()).toEqual({ ok: false, message: HELPER_MISSING, repair: 'helper' });
    await expect(route.readiness()).resolves.toMatchObject({ ready: false, page: 'computer' });
  });
  it('off macOS: loads, says macOS only, and acts on nothing', async () => {
    const { route, helper } = await computer({}, { platform: 'linux' });
    await expect(route.readiness()).resolves.toEqual({ ready: false, note: 'macOS only: on this computer agents use buddi’s own browser and your Chrome.' });
    expect(route.health()).toEqual({ ok: false, message: MAC_ONLY });
    await expect(route.do('s', { action: 'open', appId: 'com.apple.Numbers' })).rejects.toMatchObject({ precondition: true });
    expect(await helper.requests()).toEqual([]);
  });
});

describe('the route, through the fake helper', () => {
  it('opens an app, looks (picture and refs, secure fields left out), and clicks by ref', async () => {
    const { route, helper } = await computer();
    await route.do('s', { action: 'open', appId: 'com.apple.Numbers' });
    const page = await route.look('s');
    expect(page).toMatchObject({ url: 'app://com.apple.Numbers', appId: 'com.apple.Numbers', title: 'Household 2026', screenshotSize: { width: 800, height: 600 } });
    expect(page.targets!.map((t) => [t.ref, t.role, t.name])).toEqual([['ax0', 'button', 'Add row']]);
    expect(page.screenshot).toBeInstanceOf(Uint8Array);
    await route.do('s', { action: 'click', target: { ref: 'ax0' }, observation: page.id });
    const sent = (await helper.requests()).map((r) => r.operation === 'act' ? `act:${String(r.action)}` : String(r.operation));
    expect(sent).toEqual(['permissions', 'open', 'observe', 'permissions', 'act:click']);
  });
  it('refuses before sending: a stale picture, a secure field, coordinates outside the picture', async () => {
    const { route, helper } = await computer();
    await route.do('s', { action: 'open', appId: 'com.apple.Numbers' });
    await expect(route.do('s', { action: 'click', target: { ref: 'ax0' } })).rejects.toThrow('old picture');
    const page = await route.look('s');
    await expect(route.do('s', { action: 'fill', target: { ref: 'ax1' }, value: 'x', observation: page.id })).rejects.toMatchObject({ precondition: true });
    await expect(route.do('s', { action: 'click', target: { x: 900, y: 10 }, observation: page.id })).rejects.toThrow('inside the latest picture');
    expect((await helper.requests()).some((r) => r.operation === 'act')).toBe(false);
  });
  it('says an app that went behind in the words buddi reopens it by', async () => {
    const { route } = await computer({ notInFront: true, front: 'com.apple.Safari' });
    await route.do('s', { action: 'open', appId: 'com.apple.Numbers' });
    await route.reach.resolve({ id: 'com.apple.Numbers' });
    await route.reach.resolve({ id: 'com.apple.Safari' });
    const page = await route.look('s');
    await expect(route.do('s', { action: 'click', target: { ref: 'ax0' }, observation: page.id }))
      .rejects.toThrow('Numbers is no longer in front (Safari is). Call open with the same app to bring it forward, then observe again. No input was sent.');
  });
  it('opens websites only in a browser on the list, in its profile', async () => {
    const { route, helper } = await computer();
    await route.store.save({ ...(await route.store.load()), browserProfile: 'Profile 2' });
    await route.do('s', { action: 'navigate', url: 'https://example.com/' });
    expect((await helper.requests()).filter((r) => r.operation !== 'permissions')).toEqual([
      { operation: 'open', appId: 'com.google.Chrome', profile: 'Profile 2' },
      { operation: 'act', action: 'navigate', appId: 'com.google.Chrome', url: 'https://example.com/', profile: 'Profile 2' },
    ]);
    await route.store.save({ ...(await route.store.load()), allowedApps: ['com.apple.Numbers'] });
    await expect(route.do('t', { action: 'navigate', url: 'https://example.com/' })).rejects.toThrow('not on the list');
  });
  it('refuses input without macOS\'s permissions', async () => {
    const { route } = await computer({ permissions: { accessibility: false, screenRecording: false } });
    await expect(route.do('s', { action: 'open', appId: 'com.apple.Numbers' })).rejects.toThrow('Accessibility and Screen Recording');
  });
  it('take-over sends nothing until resume; release closes no app', async () => {
    const { route, helper } = await computer();
    await route.do('s', { action: 'open', appId: 'com.apple.Numbers' });
    await route.takeover('s');
    await expect(route.do('s', { action: 'observe' })).rejects.toThrow('taken over');
    route.resume('s');
    await route.look('s');
    await route.release('s');
    expect((await helper.requests()).map((r) => r.operation)).not.toContain('close');
  });
  it('types a secret only into the app it read in front', async () => {
    const { route, helper } = await computer({ front: 'com.apple.Numbers' });
    await expect(route.typeSecret('s', 'hunter2')).rejects.toThrow('No focused app');
    await expect(route.focused('s')).resolves.toBe('com.apple.Numbers');
    await route.typeSecret('s', 'hunter2');
    expect((await helper.requests()).at(-1)).toEqual({ operation: 'secretType', appId: 'com.apple.Numbers', value: '[typed]' });
  });
});

describe('reach: names, the list, Always', () => {
  it('resolves a name to one app and refuses none with the close names', async () => {
    const { route } = await computer();
    await expect(route.reach.resolve({ name: 'numbers' })).resolves.toEqual({ id: 'com.apple.Numbers', name: 'Numbers' });
    await expect(route.reach.resolve({ name: 'Numbrs' })).rejects.toThrow('No app called Numbrs. Did you mean Numbers (com.apple.Numbers)?');
    await expect(resolveApp({ name: 'Nope' }, resolver)).rejects.toThrow('No installed app is called Nope.');
  });
  it('answers listed and unlisted from its settings, and Always adds to the list up to 32', async () => {
    const { route, dir } = await computer();
    await expect(route.reach.listed('com.apple.Safari')).resolves.toBe(true);
    await expect(route.reach.listed('com.apple.Numbers')).resolves.toBe(false);
    await expect(route.reach.unlisted()).resolves.toBe('ask');
    await expect(route.reach.remember!({ id: 'com.apple.Numbers', name: 'Numbers' })).resolves.toBe(true);
    expect(JSON.parse(await readFile(path.join(dir, 'settings.json'), 'utf8')).allowedApps).toContain('com.apple.Numbers');
    const full = Array.from({ length: 32 }, (_, i) => `com.example.app${i}`);
    await route.store.save({ ...(await route.store.load()), allowedApps: full });
    await expect(route.reach.remember!({ id: 'com.apple.Preview', name: 'Preview' })).resolves.toBe(false);
  });
});

describe('settings', () => {
  it('takes the list buddi\'s browser kept, the first time', async () => {
    const browserDir = await mkdtemp(path.join(tmpdir(), 'computer-browser-'));
    cleanup.push(browserDir);
    await writeFile(path.join(browserDir, 'settings.apps.json'), JSON.stringify({ version: 2, yourApps: 'on', browserApp: 'com.apple.Safari', allowedApps: ['com.apple.Safari', 'com.apple.Numbers'], browserProfile: 'Work' }));
    const { route, dir } = await computer({}, { browserDir });
    expect(await route.store.load()).toMatchObject({ allowedApps: ['com.apple.Safari', 'com.apple.Numbers'], browserApp: 'com.apple.Safari', browserProfile: 'Work', unlisted: 'ask' });
    expect(JSON.parse(await readFile(path.join(dir, 'settings.json'), 'utf8'))).toMatchObject({ allowedApps: ['com.apple.Safari', 'com.apple.Numbers'] });
  });
  it('the page\'s tools change the list, the browser and the unlisted choice', async () => {
    const { manifest: m, route } = await computer();
    const tool = (name: string) => m.tools.find((t) => t.name === name)!;
    await expect(tool('computer.add_app').execute({ app: 'Numbers' } as never, ctx)).resolves.toMatchObject({ note: 'Added Numbers. Agents open it without asking.' });
    await tool('computer.use_as_browser').execute({ id: 'com.apple.Safari' } as never, ctx);
    expect(route.store.current.browserApp).toBe('com.apple.Safari');
    await tool('computer.remove_app').execute({ id: 'com.apple.Safari' } as never, ctx);
    expect(route.store.current).toMatchObject({ allowedApps: ['com.google.Chrome', 'com.apple.Numbers'], browserApp: 'com.google.Chrome' });
    await tool('computer.set_unlisted').execute({ unlisted: 'refuse' } as never, ctx);
    await expect(route.reach.unlisted()).resolves.toBe('refuse');
  });
  it('the page reads the three checks and the apps', async () => {
    const { manifest: m } = await computer({ permissions: { accessibility: true, screenRecording: false } });
    const view = await m.queries!.find((q) => q.name === 'settings')!.produce({}, ctx) as { checks: Array<{ id: string; state: string; status: string; canRequest: boolean }>; apps: Array<{ id: string; role: string }>; unlisted: string };
    expect(view.checks.map((c) => [c.id, c.state, c.canRequest])).toEqual([['helper', 'installed', false], ['accessibility', 'allowed', false], ['screen', 'needed', true]]);
    expect(view.checks[2]!.status).toBe(SCREEN_MISSING);
    expect(view.apps.map((a) => [a.id, a.role])).toEqual([['com.google.Chrome', 'browser'], ['com.apple.Safari', '']]);
    expect(view.unlisted).toBe('ask');
  });
});
