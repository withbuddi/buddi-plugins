/**
 * `developer.screenshot`: a picture of a page one of the agent's own processes
 * serves, kept in the Files library and drawn on the canvas.
 *
 * It takes a process name, never a URL or a host. The target is always
 * `http://127.0.0.1:<port><path>` (or `[::1]`, as the gateway's preview
 * decides), and the port must be one the process's tree is listening on right
 * now and one a preview may point at — the same check `developer.preview`
 * makes, asked afresh. A read of the agent's own server, so it is `auto` in
 * every mode, the way the file reads are.
 */
import { z } from 'zod';
import type { ToolDefinition } from '@buddi/core/plugin';
import { READ_IS_AUTO, type TierFor } from '../modes.js';
import { getProcess, isRefusal, requireAgent, workspaceOrRefusal } from '../store.js';
import {
  isSameProcess,
  listeningPorts,
  previewablePort,
  recheckPort,
  reconcile,
} from '../processes.js';
import {
  SCREENSHOT_MAX_HEIGHT,
  SCREENSHOT_MAX_WIDTH,
  SCREENSHOT_MIN_HEIGHT,
  SCREENSHOT_MIN_WIDTH,
  screenshotPath,
  screenshotViewport,
  takeScreenshot,
} from '../screenshot.js';

const screenshotInput = z
  .object({
    name: z
      .string()
      .min(1)
      .max(40)
      .regex(/^[a-z][a-z0-9-]*$/)
      .describe('The process, as you named it to developer.start.'),
    port: z
      .number()
      .int()
      .min(1)
      .max(65535)
      .optional()
      .describe("One of the ports that process listens on. Defaults to the process's own port."),
    path: z
      .string()
      .max(2048)
      .optional()
      .describe('A path on that server, such as "/" or "/settings?tab=2". Not a URL. Defaults to "/".'),
    width: z
      .number()
      .int()
      .min(SCREENSHOT_MIN_WIDTH)
      .max(SCREENSHOT_MAX_WIDTH)
      .optional()
      .describe('Viewport width in CSS pixels. Defaults to 1280.'),
    height: z
      .number()
      .int()
      .min(SCREENSHOT_MIN_HEIGHT)
      .max(SCREENSHOT_MAX_HEIGHT)
      .optional()
      .describe('Viewport height in CSS pixels. Defaults to 800.'),
    fullPage: z
      .boolean()
      .optional()
      .describe('The whole scrollable page rather than the viewport (clipped at 8000 px).'),
  })
  .strict();

type ScreenshotInput = z.infer<typeof screenshotInput>;

function slug(path: string): string {
  const cleaned = path
    .split(/[?#]/)[0]!
    .replace(/[^a-zA-Z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 40);
  return cleaned === '' ? 'root' : cleaned;
}

export const screenshotTool: ToolDefinition<ScreenshotInput, unknown> = {
  name: 'developer.screenshot',
  description:
    'Take a picture of a page one of your running processes serves, to see what you built. Name ' +
    'the process; give a path on it, not a URL. A throwaway headless browser loads ' +
    'http://127.0.0.1:<port><path> and nothing else, and the PNG goes to the owner\'s Files ' +
    'library and onto the canvas. The port must be one your process is listening on.',
  tier: 'session',
  producesArtifacts: true,
  timeoutMs: 45_000,
  input: screenshotInput,
  async tierFor(): Promise<TierFor> {
    return READ_IS_AUTO;
  },
  async execute(input, ctx) {
    const agentId = requireAgent(ctx);
    const found = await workspaceOrRefusal(ctx);
    if (isRefusal(found)) return found;

    const target = screenshotPath(input.path);
    if ('refusal' in target) throw new Error(target.refusal);

    await reconcile(ctx, agentId);
    const stored = await getProcess(ctx.buddi!.db, agentId, input.name);
    if (!stored) throw new Error(`refused: you have no process called ${input.name}.`);
    if (!(await isSameProcess(stored))) {
      throw new Error(`refused: ${input.name} is no longer running. Start it again with developer.start.`);
    }
    const own = stored.port ?? (await recheckPort(ctx, agentId, stored)) ?? null;
    const port = input.port ?? own;
    if (port === null) {
      throw new Error(
        `refused: ${input.name} is running but is not listening on a port yet, so there is nothing ` +
          'to look at. Read developer.output to see what it is doing.',
      );
    }
    // Asked of the kernel now: the process or one of its children holds the
    // port, and it is a port a preview may point at. Anything else is refused.
    const listening = await listeningPorts(stored.pid);
    if (!listening.has(port) || !previewablePort(port)) {
      const held = [...listening].filter((candidate) => previewablePort(candidate)).sort((a, b) => a - b);
      throw new Error(
        `refused: port ${port} is not one ${input.name} is listening on` +
          (held.length > 0 ? ` (it holds ${held.join(', ')}).` : ', and it holds none a screenshot may use.') +
          ' A screenshot is only of your own server.',
      );
    }

    const viewport = screenshotViewport(input.width, input.height);
    const fullPage = input.fullPage ?? false;
    const shot = await takeScreenshot({
      port,
      path: target.path,
      ...viewport,
      fullPage,
      ...(ctx.signal ? { signal: ctx.signal } : {}),
    });

    const filename = `${input.name}-${port}-${slug(target.path)}.png`;
    const saved = await ctx.buddi!.files!.save({
      bytes: shot.png,
      mime: 'image/png',
      filename,
      caption: `${input.name} at ${target.path} (port ${port}), ${viewport.width}×${viewport.height}`,
    });

    const notes = [
      `A screenshot of ${target.path} on ${input.name} (port ${port}) is in the Files library and on the canvas.`,
    ];
    if (!shot.loaded) notes.push('The page had not finished loading after 10 s; this is what was there.');
    if (shot.status !== null && shot.status >= 400) notes.push(`The server answered ${shot.status}.`);
    if (shot.blocked > 0) {
      notes.push(`${shot.blocked} request(s) to other hosts were blocked, so anything they load is missing.`);
    }
    return {
      artifacts: [{ id: saved.id }],
      id: saved.id,
      filename: saved.filename,
      name: input.name,
      port,
      path: target.path,
      viewport,
      fullPage,
      imageHeight: shot.imageHeight,
      status: shot.status,
      loaded: shot.loaded,
      blocked: shot.blocked,
      sizeBytes: saved.sizeBytes,
      note: notes.join(' '),
    };
  },
};
