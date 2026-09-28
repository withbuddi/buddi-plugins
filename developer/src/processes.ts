/**
 * Long-lived processes: a dev server, a test watcher (§4), and the previews
 * that make them worth having (§12).
 *
 * What the reviews changed here, and why each one matters:
 *
 *  - **A pid is not an identity.** `kill(pid, 0)` says "something is alive",
 *    and after a reboot that something is somebody else's process with a
 *    recycled number — which `stop` would then `SIGKILL` by process *group*.
 *    Every row now carries what `ps -o lstart=` said at start, and nothing is
 *    signalled unless the pair still matches.
 *  - **A port is not a claim.** The old code believed the `port` argument and
 *    believed a line of the process's own output, so a process could print
 *    `http://localhost:5432` and turn the owner's authenticated dashboard into
 *    a proxy to their database. A port is accepted only when *that pid* is
 *    listening on it, and buddi's own ports are refused outright.
 *  - **A signal handler that does not re-raise makes buddi unkillable.**
 *    Registering a `SIGTERM` listener removes Node's default disposition, so
 *    after the first `developer.start` the service ignored `SIGTERM` — which
 *    inverted acceptance §10.4 entirely: the dev server was not stopped when
 *    buddi stopped, because buddi did not stop. The handler now removes
 *    itself and re-raises.
 *  - **No shell.** A process is spawned argv-only with the scrubbed child
 *    environment, like every other command.
 */
import { execFileSync, spawn } from 'node:child_process';
import { setTimeout as sleep } from 'node:timers/promises';
import { open, mkdir, readFile, readdir, readlink, stat } from 'node:fs/promises';
import path from 'node:path';
import type { ToolContext } from '@buddi/core/plugin';
import { childEnv, minimalEnv, resolveProgram, runArgv } from './exec.js';
import { classifyForRunList } from './runlist.js';
import { isPort, portFromCommand, portFromOutput, reloadsItself } from './ports.js';
import { dashboardPort, logPathFor, previewPortFor } from './runtime.js';
import {
  MAX_PROCESSES_PER_AGENT,
  forgetProcess,
  getProcess,
  listProcesses,
  recordProcess,
  setProcessPort,
  type ProcessRow,
  type Workspace,
} from './store.js';

export { dataRoot, hooksDir, logPathFor, logRoot, dashboardPort, previewPortFor } from './runtime.js';

/**
 * Ports this plugin never previews, whatever a process claims.
 *
 * The gateway refuses the same set on its side (its own two ports, 5432, and
 * anything under 1024); this is the plugin half, so that a refusal reads as a
 * sentence in the tool result rather than as a 404 from a proxy.
 */
export function reservedPorts(env: NodeJS.ProcessEnv = process.env): Set<number> {
  const ports = new Set<number>([5432, 5433, 55433, dashboardPort(env)]);
  const preview = previewPortFor({}, env);
  if (preview !== undefined) ports.add(preview);
  const url = env.DATABASE_URL?.trim();
  if (url) {
    try {
      const port = Number(new URL(url).port);
      if (isPort(port)) ports.add(port);
    } catch {
      /* not a URL we can read; the fixed list still holds */
    }
  }
  return ports;
}

/** A port a preview may point at: not privileged, not reserved. */
export function previewablePort(port: number, env: NodeJS.ProcessEnv = process.env): boolean {
  return isPort(port) && port >= 1024 && !reservedPorts(env).has(port);
}

/* ------------------------------------------------------------------ *
 * Identity: a pid and when it started
 * ------------------------------------------------------------------ */

/** What `ps -o lstart=` says about a pid, or '' when it is not there. */
export async function processStartedAt(pid: number): Promise<string> {
  const result = await runArgv({
    file: '/bin/ps',
    args: ['-o', 'lstart=', '-p', String(pid)],
    cwd: '/',
    timeoutSeconds: 5,
    env: minimalEnv(),
  }).catch(() => undefined);
  return result?.exitCode === 0 ? result.stdout.trim() : '';
}

/** Is this pid there? `signal 0` asks without touching it. */
export function pidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    // EPERM means it exists and belongs to somebody else — still alive.
    return (err as NodeJS.ErrnoException).code === 'EPERM';
  }
}

/**
 * Is the process behind this row still *this* process?
 *
 * A row with no recorded start time is from before the identity check
 * existed; it is treated as stale rather than trusted, because "we do not
 * know" and "it is the same process" are not the same answer and only one of
 * them is safe to send a signal on.
 */
export async function isSameProcess(row: ProcessRow): Promise<boolean> {
  if (!pidAlive(row.pid)) return false;
  if (row.startedAtNative === '') return false;
  return (await processStartedAt(row.pid)) === row.startedAtNative;
}

/* ------------------------------------------------------------------ *
 * The shutdown hook
 * ------------------------------------------------------------------ */

/**
 * Every child this *process* started, with its identity.
 *
 * A pid alone was not enough: between `start` and shutdown a child can exit
 * and its number be reused, and a hook that signalled the *group* of a
 * recycled pid would end an unrelated session of the owner's. So the set
 * holds what `stopProcess` holds — the pid and what `ps` said about when it
 * started — and the hook checks the pair before it signals anything.
 */
interface OwnChild {
  pid: number;
  startedAtNative: string;
}

const ours = new Map<number, OwnChild>();
let hookInstalled = false;

function killGroup(pid: number, signal: NodeJS.Signals): void {
  try {
    process.kill(-pid, signal);
  } catch {
    try {
      process.kill(pid, signal);
    } catch {
      /* already gone */
    }
  }
}

const SHUTDOWN_SIGNALS = ['SIGINT', 'SIGTERM', 'SIGHUP'] as const;
const handlers = new Map<NodeJS.Signals, () => void>();

/**
 * Stop the children this process started, checking each one's identity first.
 *
 * Synchronous, because an `exit` handler cannot await — which is why the
 * start time is captured at `start` and kept in memory rather than asked for
 * here. `psStartSync` is the one exception: it is a two-millisecond read of
 * `/proc` or a `ps` call, and doing it is the difference between killing our
 * dev server and killing whatever inherited its number.
 */
function stopAllOurs(): void {
  for (const child of ours.values()) {
    if (!pidAlive(child.pid)) continue;
    if (child.startedAtNative !== '' && processStartedAtSync(child.pid) !== child.startedAtNative) {
      // Somebody else's process is wearing this number now.
      continue;
    }
    killGroup(child.pid, 'SIGTERM');
  }
  ours.clear();
}

/** `ps -o lstart=` synchronously, for the signal path. '' when unknown. */
function processStartedAtSync(pid: number): string {
  try {
    return execFileSync('/bin/ps', ['-o', 'lstart=', '-p', String(pid)], {
      encoding: 'utf8',
      timeout: 2000,
      env: minimalEnv(),
    }).trim();
  } catch {
    return '';
  }
}

/**
 * Stop everything this process started, on the way out — and then get out of
 * the way.
 *
 * The re-raise is the whole point. A listener on `SIGTERM` replaces Node's
 * default "terminate", so a handler that only cleans up turns the service into
 * one that ignores the signal. Removing the listener and re-sending the same
 * signal to ourselves restores the default disposition and exits with the
 * status a supervisor expects.
 */
export function installShutdownHook(): void {
  if (hookInstalled) return;
  hookInstalled = true;
  process.once('exit', stopAllOurs);
  for (const signal of SHUTDOWN_SIGNALS) {
    const handler = (): void => {
      stopAllOurs();
      for (const other of SHUTDOWN_SIGNALS) {
        const registered = handlers.get(other);
        if (registered) process.removeListener(other, registered);
      }
      handlers.clear();
      hookInstalled = false;
      process.kill(process.pid, signal);
    };
    handlers.set(signal, handler);
    process.on(signal, handler);
  }
}

/**
 * Put a pid in the hook's hands.
 *
 * `startProcess` is the only caller in the plugin. It is exported because the
 * signal behaviour has to be tested against a *real* child in a *real* child
 * process — a handler that fails to re-raise cannot be observed from inside
 * the process that installed it — and that test needs a pid to track without
 * a database.
 */
export function trackForShutdown(pid: number, startedAtNative = ''): void {
  ours.set(pid, { pid, startedAtNative });
}

/** A child that has exited, or been stopped, is no longer the hook's business. */
export function forgetForShutdown(pid: number): void {
  ours.delete(pid);
}

/** For the tests: what the hook currently holds, and whether it is installed. */
export function trackedPids(): readonly number[] {
  return [...ours.keys()];
}

export function shutdownHookInstalled(): boolean {
  return hookInstalled;
}

/**
 * Drop rows whose process is gone — or is a different process wearing the
 * same pid.
 */
export async function reconcile(ctx: ToolContext, agentId: string): Promise<ProcessRow[]> {
  const rows = await listProcesses(ctx.buddi!.db, agentId);
  const alive: ProcessRow[] = [];
  for (const row of rows) {
    if (await isSameProcess(row)) alive.push(row);
    else {
      forgetForShutdown(row.pid);
      await forgetProcess(ctx.buddi!.db, agentId, row.name);
    }
  }
  return alive;
}

/* ------------------------------------------------------------------ *
 * Ports: verified against the pid, or not a port
 * ------------------------------------------------------------------ */

/**
 * This pid and every process under it.
 *
 * A dev server is rarely the pid we started: `npm run dev` runs nodemon, which
 * runs tsx, which runs the node that binds. The tree is read from `ps` (or
 * `/proc` where there is no `ps`) and walked down from this pid only, so a
 * port still counts only when a process this agent started, or one of its
 * descendants, holds it — never any port on the host.
 */
export async function processTree(pid: number): Promise<number[]> {
  const parents = new Map<number, number>();
  const ps = await runArgv({
    file: '/bin/ps',
    args: ['-A', '-o', 'pid=,ppid='],
    cwd: '/',
    timeoutSeconds: 5,
    env: minimalEnv(),
  }).catch(() => undefined);
  if (ps?.exitCode === 0) {
    for (const line of ps.stdout.split('\n')) {
      const match = /^\s*(\d+)\s+(\d+)\s*$/.exec(line);
      if (match) parents.set(Number(match[1]), Number(match[2]));
    }
  } else {
    const entries = await readdir('/proc').catch(() => [] as string[]);
    await Promise.all(
      entries
        .filter((entry) => /^\d+$/.test(entry))
        .map(async (entry) => {
          const stat = await readFile(`/proc/${entry}/stat`, 'utf8').catch(() => '');
          // The command name is parenthesised and may hold spaces: ppid is the
          // second field after the last ')'.
          const ppid = Number(stat.slice(stat.lastIndexOf(')') + 2).split(' ')[1]);
          if (Number.isInteger(ppid)) parents.set(Number(entry), ppid);
        }),
    );
  }
  const children = new Map<number, number[]>();
  for (const [child, parent] of parents) {
    if (child === parent) continue;
    children.set(parent, [...(children.get(parent) ?? []), child]);
  }
  const tree = [pid];
  const seen = new Set(tree);
  for (let i = 0; i < tree.length; i += 1) {
    for (const child of children.get(tree[i] as number) ?? []) {
      if (seen.has(child)) continue;
      seen.add(child);
      tree.push(child);
    }
  }
  return tree;
}

/**
 * The TCP ports this pid, or any process under it, is actually listening on.
 *
 * `lsof` first, `ss` on a Linux box without it. When neither is there the
 * answer is the empty set, which means no preview — a preview that cannot be
 * verified is exactly the thing the review turned into an attack.
 */
export async function listeningPorts(pid: number): Promise<Set<number>> {
  const ports = new Set<number>();
  const tree = await processTree(pid);
  const lsofArgs = ['-nP', '-iTCP', '-sTCP:LISTEN', '-a', '-p', tree.join(',')];
  const lsof = await runArgv({
    file: '/usr/sbin/lsof',
    args: lsofArgs,
    cwd: '/',
    timeoutSeconds: 10,
    env: minimalEnv(),
  }).catch(async () =>
    runArgv({
      file: 'lsof',
      args: lsofArgs,
      cwd: '/',
      timeoutSeconds: 10,
      env: minimalEnv(),
    }).catch(() => undefined),
  );
  if (lsof?.exitCode === 0) {
    for (const match of lsof.stdout.matchAll(/[:.](\d{1,5})\s+\(LISTEN\)/g)) {
      const port = Number(match[1]);
      if (isPort(port)) ports.add(port);
    }
    if (ports.size > 0) return ports;
  }
  const ss = await runArgv({
    file: 'ss',
    args: ['-ltnpH'],
    cwd: '/',
    timeoutSeconds: 10,
    env: minimalEnv(),
  }).catch(() => undefined);
  if (ss?.exitCode === 0) {
    for (const line of ss.stdout.split('\n')) {
      if (!tree.some((member) => line.includes(`pid=${member},`))) continue;
      const match = /[:.](\d{1,5})\s/.exec(line);
      const port = match?.[1] === undefined ? Number.NaN : Number(match[1]);
      if (isPort(port)) ports.add(port);
    }
    if (ports.size > 0) return ports;
  }
  for (const member of tree) for (const port of await procListeningPorts(member)) ports.add(port);
  return ports;
}

/**
 * Linux without `lsof` or `ss`: ask `/proc` directly.
 *
 * The pid's open sockets are inodes under `/proc/<pid>/fd`; the listening TCP
 * sockets and their inodes are in `/proc/net/tcp` and `tcp6`. The intersection
 * is what this pid is listening on — the same question, asked of the kernel
 * rather than of a tool that may not be installed.
 */
export async function procListeningPorts(pid: number): Promise<Set<number>> {
  const ports = new Set<number>();
  let inodes: Set<string>;
  try {
    const fds = await readdir(`/proc/${pid}/fd`);
    const links = await Promise.all(
      fds.map((fd) => readlink(`/proc/${pid}/fd/${fd}`).catch(() => '')),
    );
    inodes = new Set(
      links
        .map((link) => /^socket:\[(\d+)\]$/.exec(link)?.[1])
        .filter((inode): inode is string => inode !== undefined),
    );
  } catch {
    return ports;
  }
  if (inodes.size === 0) return ports;
  for (const table of ['/proc/net/tcp', '/proc/net/tcp6']) {
    let text: string;
    try {
      text = await readFile(table, 'utf8');
    } catch {
      continue;
    }
    for (const line of text.split('\n').slice(1)) {
      const parts = line.trim().split(/\s+/);
      // local_address is column 1, st is 3 (0A is LISTEN), inode is 9.
      const local = parts[1];
      const state = parts[3];
      const inode = parts[9];
      if (local === undefined || state !== '0A' || inode === undefined) continue;
      if (!inodes.has(inode)) continue;
      const port = Number.parseInt(local.split(':')[1] ?? '', 16);
      if (isPort(port)) ports.add(port);
    }
  }
  return ports;
}

/**
 * The port a process is on, or undefined: **claimed, then verified**.
 *
 * The claim narrows the search — an explicit argument, the command line, the
 * first lines of output — and the verification is what decides. A claim the
 * pid is not listening on is discarded silently, because a dev server that has
 * not bound yet is the ordinary case, not an accusation.
 */
export async function verifiedPort(input: {
  pid: number;
  explicit?: number | undefined;
  command: string;
  output?: string;
  env?: NodeJS.ProcessEnv;
}): Promise<number | undefined> {
  const env = input.env ?? process.env;
  const claims = [
    input.explicit,
    portFromCommand(input.command),
    input.output === undefined ? undefined : portFromOutput(input.output),
  ].filter((port): port is number => port !== undefined && previewablePort(port, env));
  const listening = await listeningPorts(input.pid);
  for (const claim of claims) if (listening.has(claim)) return claim;
  // Nothing claimed, but exactly one port is open and it may be previewed:
  // that is the server, and saying so is better than asking the agent to
  // repeat what the kernel already knows.
  const open = [...listening].filter((port) => previewablePort(port, env));
  return claims.length === 0 && open.length === 1 ? open[0] : undefined;
}

/* ------------------------------------------------------------------ *
 * Tailscale
 * ------------------------------------------------------------------ */

async function tailscaleBinary(toolchainPath: string): Promise<string | undefined> {
  return resolveProgram('tailscale', toolchainPath);
}

export interface TailscaleOutcome {
  added: boolean;
  url?: string;
  note?: string;
}

/** `tailscale serve --https=<port> http://127.0.0.1:<port>`, exactly as §12 says. */
export async function addTailscaleRoute(
  port: number,
  opts: { toolchainPath: string; previewPort: number | undefined; env?: NodeJS.ProcessEnv },
): Promise<TailscaleOutcome> {
  // §12: a preview is served on buddi's *preview* listener, behind a ticket
  // the dashboard hands out. The tailnet route points there. Pointing it at
  // the app's own port would publish the app with no credential at all — and
  // guessing the listener ("the dashboard plus one") is wrong the moment the
  // port next door was taken, which is why core hands the number over.
  const target = opts.previewPort;
  if (target === undefined) {
    return {
      added: false,
      note: 'this buddi is not serving previews, so there is nothing for a tailnet route to point at.',
    };
  }
  const binary = await tailscaleBinary(opts.toolchainPath);
  if (!binary) {
    return { added: false, note: 'tailscale is not on the workspace PATH, so no tailnet route was added.' };
  }
  const env = childEnv({ toolchainPath: opts.toolchainPath, ...(opts.env ? { env: opts.env } : {}) });
  const result = await runArgv({
    file: binary,
    args: ['serve', `--https=${port}`, `http://127.0.0.1:${target}`],
    cwd: '/',
    timeoutSeconds: 30,
    env,
  });
  if (result.exitCode !== 0) {
    return {
      added: false,
      note: `tailscale refused the route: ${(result.stderr || result.stdout).trim().slice(0, 200)}`,
    };
  }
  const host = await tailscaleHost(binary, env);
  return {
    added: true,
    ...(host ? { url: `https://${host}:${port}/` } : {}),
    ...(host ? {} : { note: 'the route is up; `tailscale status` has the host name.' }),
  };
}

export async function removeTailscaleRoute(
  port: number,
  opts: { toolchainPath: string; env?: NodeJS.ProcessEnv },
): Promise<void> {
  const binary = await tailscaleBinary(opts.toolchainPath);
  if (!binary) return;
  await runArgv({
    file: binary,
    args: ['serve', `--https=${port}`, 'off'],
    cwd: '/',
    timeoutSeconds: 30,
    env: childEnv({ toolchainPath: opts.toolchainPath, ...(opts.env ? { env: opts.env } : {}) }),
  }).catch(() => undefined);
}

async function tailscaleHost(binary: string, env: NodeJS.ProcessEnv): Promise<string | undefined> {
  const result = await runArgv({
    file: binary,
    args: ['status', '--json'],
    cwd: '/',
    timeoutSeconds: 10,
    env,
  }).catch(() => undefined);
  if (!result || result.exitCode !== 0) return undefined;
  try {
    const parsed = JSON.parse(result.stdout) as { Self?: { DNSName?: string } };
    const dns = parsed.Self?.DNSName?.replace(/\.$/, '');
    return dns && dns !== '' ? dns : undefined;
  } catch {
    return undefined;
  }
}

/* ------------------------------------------------------------------ *
 * start / output / stop
 * ------------------------------------------------------------------ */

export interface StartInput {
  name: string;
  command: string;
  port?: number | undefined;
}

export interface StartOutcome {
  process: ProcessRow;
  tailscale?: TailscaleOutcome;
}

export async function startProcess(
  ctx: ToolContext,
  agentId: string,
  workspace: Workspace,
  input: StartInput,
  opts: {
    env?: NodeJS.ProcessEnv;
    /**
     * What goes into the child's environment *besides* the allowlist: the
     * owner's secrets delivered for this workspace (owner-secrets §4), handed
     * in by `developer.start` and never read again here.
     */
    extra?: Record<string, string>;
    tailscaleRoutes: boolean;
    settleMs?: number;
  } = {
    tailscaleRoutes: false,
  },
): Promise<StartOutcome> {
  const env = opts.env ?? process.env;
  const alive = await reconcile(ctx, agentId);
  const existing = alive.find((row) => row.name === input.name);
  if (existing) {
    throw new Error(
      `refused: ${agentId} already has a process called ${input.name} (pid ${existing.pid}). Stop it first, or pick another name.`,
    );
  }
  // A process name is how a preview is asked for, and the gateway asks by
  // name alone. So a name belongs to one agent at a time across the whole
  // installation: otherwise "preview `web`" would mean whichever row came
  // back first, which is a different agent's process.
  const heldElsewhere = (await listProcesses(ctx.buddi!.db)).find(
    (row) => row.name === input.name && row.agentId !== agentId,
  );
  if (heldElsewhere) {
    if (await isSameProcess(heldElsewhere)) {
      throw new Error(
        `refused: ${heldElsewhere.agentId} is already running a process called ${input.name}, and a name ` +
          'belongs to one agent at a time because a preview is asked for by name. Pick another name.',
      );
    }
    await forgetProcess(ctx.buddi!.db, heldElsewhere.agentId, input.name);
  }
  if (alive.length >= MAX_PROCESSES_PER_AGENT) {
    throw new Error(
      `refused: ${agentId} already has ${alive.length} processes running, which is the limit. Stop one with developer.stop.`,
    );
  }
  // The same words the run list reads, spawned as the same words. A command
  // that is not plain never becomes a process, whatever its tier said: there
  // is no shell to hand it to.
  const parsed = classifyForRunList(input.command);
  const words = parsed.words;
  if (!words || words.length === 0) {
    throw new Error(`refused: ${parsed.reason ?? 'this command cannot be run without a shell.'}`);
  }
  const [program, ...args] = words as [string, ...string[]];
  // The same resolution `developer.run` does: an absolute program from the
  // workspace's own captured PATH, so "node" means one file on disk and a
  // process is never started by a name the operating system resolves against
  // whatever PATH it happened to inherit.
  const resolved = program.includes('/')
    ? undefined
    : await resolveProgram(program, workspace.toolchainPath);
  if (resolved === undefined && !program.includes('/')) {
    throw new Error(
      `refused: ${program} is not on this workspace's PATH. The PATH is the one captured when the owner ` +
        'granted the workspace; nothing is looked up through a shell.',
    );
  }

  const file = logPathFor(agentId, input.name, env);
  await mkdir(path.dirname(file), { recursive: true });
  const handle = await open(file, 'w');
  let child;
  try {
    child = spawn(resolved ?? program, args, {
      cwd: workspace.dir,
      env: childEnv({ toolchainPath: workspace.toolchainPath, env, extra: opts.extra }),
      detached: true,
      shell: false,
      stdio: ['ignore', handle.fd, handle.fd],
    });
    child.unref();
  } finally {
    await handle.close().catch(() => undefined);
  }
  const pid = child.pid;
  if (pid === undefined) throw new Error(`developer: ${input.name} did not start.`);
  const startedAtNative = await processStartedAt(pid);
  trackForShutdown(pid, startedAtNative);
  installShutdownHook();

  await recordProcess(
    ctx.buddi!.db,
    {
      agentId,
      name: input.name,
      pid,
      command: input.command,
      startedAtNative,
      port: null,
      logPath: file,
    },
    ctx.buddi!.clock.now(),
  );

  // Give a server a moment to bind, then ask the kernel — not the process —
  // which port it is on. Bounded and short: a tool call is not the place to
  // wait for a slow build, and `preview` verifies again later.
  let port: number | undefined;
  const settle = opts.settleMs ?? 1_500;
  const deadline = Date.now() + settle;
  do {
    const text = await readLog(file, 16 * 1024).catch(() => '');
    port = await verifiedPort({ pid, explicit: input.port, command: input.command, output: text, env });
    if (port !== undefined) break;
    if (Date.now() >= deadline) break;
    await new Promise((resolve) => setTimeout(resolve, 150));
  } while (Date.now() < deadline);
  if (port !== undefined) await setProcessPort(ctx.buddi!.db, agentId, input.name, port);

  const row = (await getProcess(ctx.buddi!.db, agentId, input.name)) as ProcessRow;
  if (port !== undefined && opts.tailscaleRoutes) {
    const tailscale = await addTailscaleRoute(port, {
      toolchainPath: workspace.toolchainPath,
      previewPort: previewPortFor(ctx, env),
      env,
    });
    return { process: row, tailscale };
  }
  return { process: row };
}

/**
 * How long a started process is watched for a port it had not bound yet, and
 * how often it is asked. Three minutes covers a cold `npm run dev` on a slow
 * machine; past that, `developer.preview` is still there to ask again.
 */
export const PORT_WATCH_MS = 3 * 60_000;
export const PORT_WATCH_EVERY_MS = 1_000;

/**
 * Watch a process that was not listening when `start` came back, until it is.
 *
 * `start` waits a second and a half and no longer, because a tool call is not
 * the place to wait for a build — which left a slow dev server with no port on
 * its row, and so with no preview until the agent thought to ask. This keeps
 * asking the kernel in the background, the same verified question `start`
 * asks, and writes the port on the row the moment the pid holds one. The
 * preview route reads the row, so the dashboard — which asks the route whether
 * the preview is being served yet — opens it without the agent's help.
 *
 * Bounded three ways: a deadline; the process exiting; and the row changing
 * under it (stopped, restarted under the same name, or given a port by
 * `developer.preview`). Never throws: a failure here is a preview that does
 * not open by itself, which `developer.preview` still can.
 */
export async function watchForPort(
  ctx: ToolContext,
  agentId: string,
  row: ProcessRow,
  input: { explicit?: number | undefined },
  opts: {
    env?: NodeJS.ProcessEnv;
    watchMs?: number;
    everyMs?: number;
    onPort?: (port: number) => Promise<void>;
  } = {},
): Promise<number | undefined> {
  const env = opts.env ?? process.env;
  const deadline = Date.now() + (opts.watchMs ?? PORT_WATCH_MS);
  const every = opts.everyMs ?? PORT_WATCH_EVERY_MS;
  try {
    while (Date.now() < deadline) {
      // Not holding the gateway open for a dev server that never binds.
      await sleep(every, undefined, { ref: false });
      if (!pidAlive(row.pid)) return undefined;
      const current = await getProcess(ctx.buddi!.db, agentId, row.name);
      if (!current || current.pid !== row.pid) return undefined;
      if (current.port !== null) return current.port;
      const port = await recheckPort(ctx, agentId, row, { ...input, env });
      if (port === undefined) continue;
      await opts.onPort?.(port);
      return port;
    }
  } catch {
    /* the pool closed, or the log went away: nothing to open */
  }
  return undefined;
}

/**
 * Ask the kernel, once, which port this row's process holds, and write it on
 * the row when there is one. The watcher asks this every second; the preview
 * tool asks it when the row has no port yet, rather than refusing a server
 * that bound after the watcher gave up.
 */
export async function recheckPort(
  ctx: ToolContext,
  agentId: string,
  row: ProcessRow,
  input: { explicit?: number | undefined; env?: NodeJS.ProcessEnv } = {},
): Promise<number | undefined> {
  const text = await readLog(row.logPath, 16 * 1024).catch(() => '');
  const port = await verifiedPort({
    pid: row.pid,
    explicit: input.explicit,
    command: row.command,
    output: text,
    ...(input.env ? { env: input.env } : {}),
  });
  if (port !== undefined) await setProcessPort(ctx.buddi!.db, agentId, row.name, port);
  return port;
}

/**
 * Does this process reload its own page after a change? Read from the
 * command, and from the project's `package.json` scripts when the command
 * runs one. A missing or unreadable `package.json` is no scripts.
 */
export async function processReloadsItself(command: string, dir: string): Promise<boolean> {
  let scripts: Record<string, string> = {};
  try {
    const parsed = JSON.parse(await readFile(path.join(dir, 'package.json'), 'utf8')) as { scripts?: unknown };
    if (parsed.scripts && typeof parsed.scripts === 'object') scripts = parsed.scripts as Record<string, string>;
  } catch {
    /* no package.json: the command alone decides */
  }
  return reloadsItself(command, scripts);
}

/**
 * The tail of a log file, and how much of its head that tail leaves out — for
 * the canvas to say "first N KB not shown" rather than pass a tail off as the
 * whole.
 */
export async function readLogTail(file: string, bytes: number): Promise<{ text: string; omittedBytes: number }> {
  const info = await stat(file);
  const text = await readLog(file, bytes);
  return { text, omittedBytes: Math.max(0, info.size - bytes) };
}

/**
 * Every port this process's tree listens on that a preview may use, in order.
 *
 * What the preview panel's port picker offers: never a port outside the
 * tree, because it is `listeningPorts` of this pid; never one a preview may
 * not point at, because `previewablePort` filters it.
 */
export async function previewablePorts(pid: number, env: NodeJS.ProcessEnv = process.env): Promise<number[]> {
  const listening = await listeningPorts(pid).catch(() => new Set<number>());
  return [...listening].filter((port) => previewablePort(port, env)).sort((a, b) => a - b);
}

/** The tail of a log file, in bytes. */
export async function readLog(file: string, bytes: number): Promise<string> {
  const info = await stat(file);
  if (info.size <= bytes) return readFile(file, 'utf8');
  const handle = await open(file, 'r');
  try {
    const buffer = Buffer.alloc(bytes);
    await handle.read(buffer, 0, bytes, info.size - bytes);
    return buffer.toString('utf8');
  } finally {
    await handle.close();
  }
}

export interface StopOutcome {
  stopped: boolean;
  /** The row that was there, whether or not its process still was. */
  process?: ProcessRow;
  /** True when the row was about a process that is no longer that process. */
  stale?: boolean;
}

export async function stopProcess(
  ctx: ToolContext,
  agentId: string,
  name: string,
  opts: { env?: NodeJS.ProcessEnv; toolchainPath?: string } = {},
): Promise<StopOutcome> {
  const row = await getProcess(ctx.buddi!.db, agentId, name);
  if (!row) return { stopped: false };
  const same = await isSameProcess(row);
  if (!same) {
    // The pid is somebody else's now, or nobody's. Forget the row; signalling
    // a recycled pid's *process group* is how a plugin kills a shell session.
    forgetForShutdown(row.pid);
    await forgetProcess(ctx.buddi!.db, agentId, name);
    return { stopped: false, process: row, stale: true };
  }
  killGroup(row.pid, 'SIGTERM');
  forgetForShutdown(row.pid);
  await new Promise((resolve) => setTimeout(resolve, 200));
  if (pidAlive(row.pid) && (await processStartedAt(row.pid)) === row.startedAtNative) {
    killGroup(row.pid, 'SIGKILL');
  }
  if (row.port !== null) {
    await removeTailscaleRoute(row.port, {
      toolchainPath: opts.toolchainPath ?? '',
      ...(opts.env ? { env: opts.env } : {}),
    });
  }
  await forgetProcess(ctx.buddi!.db, agentId, name);
  return { stopped: true, process: row };
}

/** Every process of one agent, stopped: a workspace change, or the owner's button. */
export async function stopAllFor(
  ctx: ToolContext,
  agentId: string,
  opts: { env?: NodeJS.ProcessEnv; toolchainPath?: string } = {},
): Promise<ProcessRow[]> {
  const rows = await listProcesses(ctx.buddi!.db, agentId);
  const stopped: ProcessRow[] = [];
  for (const row of rows) {
    const outcome = await stopProcess(ctx, agentId, row.name, opts);
    if (outcome.stopped && outcome.process) stopped.push(outcome.process);
  }
  return stopped;
}

/** Every process of every agent. The Settings page's "Stop all processes". */
export async function stopEverything(
  ctx: ToolContext,
  opts: { env?: NodeJS.ProcessEnv } = {},
): Promise<ProcessRow[]> {
  const rows = await listProcesses(ctx.buddi!.db);
  const stopped: ProcessRow[] = [];
  for (const row of rows) {
    const outcome = await stopProcess(ctx, row.agentId, row.name, opts);
    if (outcome.stopped && outcome.process) stopped.push(outcome.process);
  }
  return stopped;
}
