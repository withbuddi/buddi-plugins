/**
 * The two tools the owner actually looks at: `summarise` (§6) and `preview`
 * (§12).
 *
 * Both are reads, both are `auto` once the mode has been consulted, and both
 * end in something on the canvas rather than in a wall of text — `summarise`
 * through this plugin's view descriptor, `preview` through a URL the gateway
 * serves behind the dashboard's own session.
 */
import { z } from 'zod';
import type { ToolContext, ToolDefinition } from '@buddi/core/plugin';
import { fenced } from '../fence.js';
import { READ_IS_AUTO, type TierFor } from '../modes.js';
import {
  getProcess,
  getProcessByName,
  isRefusal,
  requireAgent,
  workspaceOrRefusal,
} from '../store.js';
import {
  isSameProcess,
  listeningPorts,
  previewablePort,
  processReloadsItself,
  previewablePorts,
  readLog,
  recheckPort,
  reconcile,
} from '../processes.js';
import { isPort } from '../ports.js';
import { gitOptionsFor } from '../runtime.js';
import { summarise } from '../summarise.js';

export const summariseTool: ToolDefinition<Record<string, never>, unknown> = {
  name: 'developer.summarise',
  description:
    'Say what you did: the branch, the diff, the files you changed and the last test run. Call ' +
    'it when you think you are done — it is what the owner reviews, and the unit of review is ' +
    'the diff, not the commands you ran.',
  tier: 'session',
  input: z.object({}).strict(),
  async tierFor(): Promise<TierFor> {
    return READ_IS_AUTO;
  },
  async execute(_input, ctx) {
    const found = await workspaceOrRefusal(ctx);
    if (isRefusal(found)) return found;
    const workspace = found;
    const agentId = requireAgent(ctx);
    const summary = await summarise({
      ...gitOptionsFor(workspace, { ...(ctx.signal ? { signal: ctx.signal } : {}) }),
      agentId,
    });
    return {
      path: workspace.dir,
      branch: summary.branch,
      base: summary.base,
      diffStat: summary.diffStat,
      changedFiles: summary.changedFiles,
      testCommand: summary.testCommand,
      testResult: summary.testResult,
      diffTruncated: summary.diffTruncated,
      // The diff is workspace content like any other: fenced, with the notice.
      ...fenced(summary.diff === '' ? '(no changes)' : summary.diff),
    };
  },
};

/* ------------------------------------------------------------------ *
 * preview
 * ------------------------------------------------------------------ */

const previewInput = z.object({
  name: z
    .string()
    .min(1)
    .max(40)
    .regex(/^[a-z][a-z0-9-]*$/)
    .describe('The process, as you named it to developer.start.'),
});

/**
 * `developer.preview` names a process. It does **not** return a URL.
 *
 * A preview is served on a second origin with a credential of its own, and the
 * only way to one is the dashboard's `GET /api/preview/developer/<name>/link`,
 * which is session-gated and hands out a single-use five-minute ticket. A
 * plugin has no session, so it cannot call that route and must not pretend to
 * hold its answer: the result carries `{ plugin, name }` and the string
 * `/preview/developer/<name>/`, and the canvas's `preview` descriptor is what
 * asks the link route. "Put this URL in an iframe on the dashboard" is not a
 * sentence a plugin gets to say.
 */
export const previewTool: ToolDefinition<z.infer<typeof previewInput>, unknown> = {
  name: 'developer.preview',
  description:
    'Show the owner one of your running processes: buddi frames it on the canvas, on its own ' +
    'preview origin and behind their dashboard sign-in. Call it when you have something to look ' +
    'at. The port is checked against your process — you cannot point a preview at anything else.',
  tier: 'session',
  input: previewInput,
  async tierFor(): Promise<TierFor> {
    return READ_IS_AUTO;
  },
  async execute(input, ctx) {
    const agentId = requireAgent(ctx);
    const found = await workspaceOrRefusal(ctx);
    if (isRefusal(found)) return found;
    await reconcile(ctx, agentId);
    const stored = await getProcess(ctx.buddi!.db, agentId, input.name);
    if (!stored) {
      throw new Error(`refused: you have no process called ${input.name}.`);
    }
    // No port on the row yet: ask the kernel now, as the watcher would, and
    // keep what it says. A server that bound late is not a refusal.
    const port = stored.port ?? (await recheckPort(ctx, agentId, stored)) ?? null;
    const row = { ...stored, port };
    if (row.port === null) {
      throw new Error(
        `refused: ${input.name} is running but is not listening on a port this installation will ` +
          'preview, so there is nothing to frame.',
      );
    }
    // Asked again, now: a process that has stopped listening, or that has
    // moved to a port it may not have, stops being previewable at once.
    const listening = await listeningPorts(row.pid);
    if (!listening.has(row.port) || !previewablePort(row.port)) {
      throw new Error(
        `refused: ${input.name} is no longer listening on port ${row.port}. Start it again, or read ` +
          'developer.output to see what it did.',
      );
    }
    const output = await readLog(row.logPath, 8 * 1024).catch(() => '');
    return {
      plugin: 'developer',
      name: row.name,
      port: row.port,
      // Every port the tree holds that a preview may use: the panel's picker.
      ports: await previewablePorts(row.pid),
      /** What the canvas descriptor reads: a name, not a URL. */
      preview: `/preview/developer/${row.name}/`,
      reloadsItself: await processReloadsItself(row.command, found.dir),
      ...fenced(output === '' ? '(nothing yet)' : output),
      note:
        `${row.name} is on the canvas as a preview. It is served on buddi's preview origin, behind ` +
        'your dashboard sign-in; the link is the dashboard\'s to make, not mine.',
    };
  },
};

/**
 * The manifest's `previews.resolve`: a process name to the loopback port the
 * gateway proxies to, or null.
 *
 * Asked on **every** proxied request, so everything it checks is checked
 * afresh:
 *
 *  - the row exists and its (pid, start time) is still the process we started;
 *  - that pid is *listening* on that port right now — not "said so once";
 *  - the port is one a preview may point at (not privileged, not buddi's own
 *    two ports, not the database).
 *
 * It is scoped by agent through the row it finds, and it returns at most one
 * answer: a name belongs to one agent's process at a time, and the first row
 * with a matching name is checked rather than trusted.
 */
export async function resolvePreview(name: string, ctx: ToolContext): Promise<{ port: number; host?: '127.0.0.1' } | null> {
  // `<name>.<port>`: the same process on another port its tree holds — what
  // the panel's port picker asks for. A process name has no dot, so the two
  // spellings never meet.
  const other = /^([a-z][a-z0-9-]*)\.(\d{1,5})$/.exec(name);
  if (other) return resolveOtherPort(other[1] as string, Number(other[2]), ctx);
  const row = await getProcessByName(ctx.buddi!.db, name);
  if (!row || row.port === null) return null;
  // Everything is checked afresh, because this is asked on every proxied
  // request: the row is still the process we started (pid *and* start time),
  // the port is one a preview may point at, and that pid is listening on it
  // right now. What is left is the window between this answer and the
  // gateway's connect, which is stated in the spec as the residual it is.
  if (!(await isSameProcess(row))) return null;
  if (!previewablePort(row.port)) return null;
  const listening = await listeningPorts(row.pid);
  if (!listening.has(row.port)) return null;
  return { port: row.port, host: '127.0.0.1' };
}

/**
 * One of the other ports a process's tree listens on, checked exactly as
 * afresh as its own: the row is still that process, the port is one a
 * preview may point at, and the pid or one of its children holds it now. A
 * port outside the tree is null, whatever the name says.
 */
async function resolveOtherPort(
  name: string,
  port: number,
  ctx: ToolContext,
): Promise<{ port: number; host: '127.0.0.1' } | null> {
  if (!isPort(port)) return null;
  const row = await getProcessByName(ctx.buddi!.db, name);
  if (!row) return null;
  if (!(await isSameProcess(row))) return null;
  if (!previewablePort(port)) return null;
  const listening = await listeningPorts(row.pid);
  if (!listening.has(port)) return null;
  return { port, host: '127.0.0.1' };
}
