/**
 * One conversation's hold on the owner's apps: what it opened, the last
 * accessibility snapshot and picture, and the input it may send against them.
 *
 * The helper acts on accessibility nodes of the selected app's focused window
 * (click this button, fill that field), or clicks a point in the window's own
 * picture. Every input names the snapshot it was aimed at, and a stale one is
 * refused before anything is sent. Nothing here ever closes an app.
 */
import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import type { RouteCommand, RoutePage } from '@buddi/core/plugin';
import { CHROMIUM_APPS } from './apps.js';
import { PreconditionError, isPrecondition } from './errors.js';
import type { ComputerBridge } from './helper.js';
import type { ComputerSettings } from './settings.js';

const nodeSchema = z.object({ path: z.array(z.number().int().min(0)), role: z.string(), name: z.string(), value: z.string(), secure: z.boolean(), enabled: z.boolean(),
  bounds: z.object({ x: z.number(), y: z.number(), width: z.number().positive(), height: z.number().positive() }) });
const snapshotSchema = z.object({ identity: z.string(), title: z.string(), nodes: z.array(nodeSchema).max(500), jpeg: z.string(), width: z.number().positive(), height: z.number().positive(), imageHash: z.string() });
type Snapshot = z.infer<typeof snapshotSchema>;
/** The helper's refusal when the selected app is not the frontmost one (Computer.swift, `state`). */
const NOT_IN_FRONT = /selected app is no longer in front/i;
const roles: Record<string, string> = { AXButton: 'button', AXLink: 'link', AXTextField: 'textbox', AXTextArea: 'textbox', AXCheckBox: 'checkbox', AXRadioButton: 'radio', AXComboBox: 'combobox', AXPopUpButton: 'combobox', AXMenuItem: 'menuitem' };

/** Checks a website address for `navigate`: public http(s) only. Injected so the plugin uses buddi's own rule. */
export type UrlCheck = (url: string) => URL;

export interface DriverDeps {
  bridge: ComputerBridge;
  settings: () => ComputerSettings;
  /** An app's display name for the agent's sentences; undefined: the bundle id. */
  nameOf: (appId: string) => Promise<string | undefined>;
  checkUrl: UrlCheck;
}

export class ComputerDriver {
  #appId?: string | undefined;
  #snapshot?: Snapshot | undefined;
  #page?: RoutePage | undefined;
  #generation = 0;
  #paused = false;
  #focused?: string | undefined;
  constructor(readonly deps: DriverDeps) {}

  /** The helper, with its "not in front" refusal said to the agent: open brings the app back; nothing was sent. */
  async #run(input: Record<string, unknown>): Promise<Record<string, unknown>> {
    try { return await this.deps.bridge.run(input); }
    catch (error) {
      if (!isPrecondition(error) || !NOT_IN_FRONT.test(error.message)) throw error;
      const appId = String(input.appId ?? this.#appId ?? '');
      const name = async (id: string) => { try { return (await this.deps.nameOf(id)) || id; } catch { return id; } };
      let front: string | undefined;
      try { const focused = await this.deps.bridge.run({ operation: 'focused' }); front = typeof focused.appId === 'string' && focused.appId.trim() ? focused.appId.trim() : undefined; } catch { front = undefined; }
      const inFront = front && front !== appId ? ` (${await name(front)} is)` : '';
      // The words buddi's runtime recognises (APP_BEHIND): it opens the app again by itself.
      throw new PreconditionError(`${await name(appId)} is no longer in front${inFront}. Call open with the same app to bring it forward, then observe again. No input was sent.`);
    }
  }
  /** macOS must allow both before any input. */
  async #permitted(): Promise<void> {
    const permissions = await this.deps.bridge.run({ operation: 'permissions', prompt: false });
    if (!permissions.accessibility || !permissions.screenRecording) throw new PreconditionError('Computer control needs macOS Accessibility and Screen Recording permission. The owner allows them on Settings → Computer. Nothing was sent.');
  }
  #invalidate(): void { this.#snapshot = undefined; this.#page = undefined; }

  async perform(command: RouteCommand): Promise<void> {
    if (this.#paused) throw new PreconditionError('The owner has taken over the app. Wait until they give it back.');
    const generation = this.#generation;
    if (command.action === 'close') { await this.release(); return; }
    if (command.action === 'observe') return;
    await this.#permitted();
    if (command.action === 'open' || command.action === 'navigate') {
      const settings = this.deps.settings();
      // buddi lets an `open` through only for an app on the list or allowed by the owner's card.
      const appId = command.action === 'navigate' ? settings.browserApp : command.appId;
      if (!appId) throw new PreconditionError('Say which app to open.');
      let url: string | undefined;
      if (command.action === 'navigate') {
        if (!settings.allowedApps.includes(appId)) throw new PreconditionError('The browser app is not on the list of apps on Settings → Computer, so websites cannot open in it. Ask the owner.');
        url = this.deps.checkUrl(command.url ?? '').href;
      }
      this.#invalidate();
      const profile = command.action === 'navigate' && CHROMIUM_APPS.includes(appId) ? settings.browserProfile : undefined;
      await this.deps.bridge.run({ operation: 'open', appId, ...(profile ? { profile } : {}) });
      if (generation !== this.#generation) throw new Error('Computer action cancelled');
      this.#appId = appId;
      if (url) await this.deps.bridge.run({ operation: 'act', action: 'navigate', appId, url, ...(profile ? { profile } : {}) });
      return;
    }
    if (!this.#appId) throw new PreconditionError('Open an allowed app or a website first.');
    if (command.action === 'select' || command.action === 'tab') throw new PreconditionError('An app window has no select or tab ids. Look, then click the visible accessibility target for the tab or option.');
    if (!this.#snapshot || (command.observation !== undefined && command.observation !== this.#page?.id)) throw new PreconditionError('That is an old picture of the app. Look again before acting.');
    const snapshot = this.#snapshot;
    let node: Snapshot['nodes'][number] | undefined;
    if (command.target?.x !== undefined) {
      if (command.action !== 'click' || command.target.y === undefined || command.target.x >= snapshot.width || command.target.y >= snapshot.height) throw new PreconditionError('Only click takes coordinates, measured inside the latest picture.');
    } else if (command.target) {
      if (command.target.ref) {
        const match = /^ax(\d+)$/.exec(command.target.ref);
        node = match ? snapshot.nodes[Number(match[1])] : undefined;
      } else {
        const matches = snapshot.nodes.filter((n) => n.name === command.target?.name && (command.target.by !== 'role' || (roles[n.role] ?? n.role) === command.target.role));
        if (matches.length === 1) node = matches[0];
      }
      if (!node || node.secure || !node.enabled) throw new PreconditionError('That target is missing, ambiguous, disabled or secure. Copy an exact ref from the latest look.');
    }
    const input = { operation: 'act', appId: this.#appId, action: command.action, identity: snapshot.identity,
      ...(node ? { target: node } : {}), ...(command.target?.x !== undefined ? { x: command.target.x, y: command.target.y, imageHash: snapshot.imageHash } : {}),
      value: command.value, key: command.key, direction: command.direction };
    this.#invalidate(); // Never replay evidence once dispatch may have started.
    await this.#run(input);
  }

  async look(): Promise<RoutePage> {
    if (!this.#appId) throw new PreconditionError('No app is open yet. Open an allowed app first.');
    const generation = this.#generation;
    const appId = this.#appId;
    const snapshot = snapshotSchema.parse(await this.#run({ operation: 'observe', appId }));
    if (generation !== this.#generation) throw new Error('Computer observation cancelled');
    this.#snapshot = snapshot;
    const targets = snapshot.nodes.flatMap((node, i) => node.secure || !node.enabled ? [] : [{ ref: `ax${i}`, frame: 0, role: roles[node.role] ?? node.role, name: node.name, bounds: node.bounds }]);
    this.#page = { id: randomUUID(), appId, url: `app://${appId}`, title: snapshot.title,
      tree: targets.map((t) => `${t.ref} ${t.role} ${JSON.stringify(t.name)} ${JSON.stringify(snapshot.nodes[Number(t.ref.slice(2))]?.value ?? '')}`).join('\n').slice(0, 32_000),
      targets, tabs: [], capturedAt: new Date().toISOString(), screenshotSize: { width: snapshot.width, height: snapshot.height } };
    return { ...this.#page, screenshot: new Uint8Array(Buffer.from(snapshot.jpeg, 'base64')) };
  }

  /**
   * The app the owner is using right now, as the helper reports it — never the
   * agent's claim. Remembered so the typing goes to the same app the secret's
   * use was delivered for: an app switch in between is refused.
   */
  async focused(): Promise<string | undefined> {
    const result = await this.deps.bridge.run({ operation: 'focused' });
    const appId = typeof result.appId === 'string' ? result.appId.trim() : '';
    this.#focused = appId === '' ? undefined : appId;
    return this.#focused;
  }
  /** The owner's secret into the focused field, with the helper's own focus guards. */
  async typeSecret(value: string): Promise<void> {
    const appId = this.#focused;
    if (!appId) throw new PreconditionError('No focused app was read for this use. Ask which app is in front again, then ask for the secret.');
    const generation = this.#generation;
    this.#invalidate();
    await this.deps.bridge.run({ operation: 'secretType', appId, value });
    if (generation !== this.#generation) throw new Error('Computer action cancelled');
  }

  /** The owner takes the app: anything in flight is cut off, nothing more is sent until resume. */
  async takeover(): Promise<void> { ++this.#generation; this.#paused = true; this.deps.bridge.cancel(); this.#invalidate(); }
  resume(): void { this.#paused = false; this.#invalidate(); }
  /**
   * Done for now: anything in flight is cut off. Never closes an app — they
   * are the owner's — and keeps which one was open, since buddi also calls
   * this when the owner takes over mid-action and the agent carries on after.
   */
  async release(): Promise<void> { ++this.#generation; this.deps.bridge.cancel(); this.#invalidate(); }
}
