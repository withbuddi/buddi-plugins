/**
 * Running one program, bounded — **argv only, and never a shell**.
 *
 * The first version of this file spawned `$SHELL -lc <command>`. Two reviews
 * took that apart the same way, and their conclusion is what this file now
 * is: a lexical denylist over a string a shell is about to re-interpret
 * cannot establish anything. `$HOME`, `>>~/.zshenv`, `env curl`, `node -e`,
 * an alias sourced out of `~/.zshenv` — each is a different spelling of "the
 * parser read one program and the shell ran another".
 *
 * So there is no shell here. A command is a program and an argument vector,
 * spawned directly. What runs without a card is decided by `runlist.ts`, an
 * allowlist of programs and subcommands; everything else is an approval, and
 * an approval does not buy a shell either — a gated command runs through this
 * same function.
 *
 * And the child gets an environment this module builds, not the service's.
 * `DATABASE_URL`, `BUDDI_*`, the vault's key and every API token live in
 * buddi's own environment; a project's test script is somebody else's code
 * and has no business seeing any of them.
 */
import { spawn } from 'node:child_process';
import os from 'node:os';
import path from 'node:path';

/** §4: "output bounded (200 KB, tail kept)" — over **both** streams together. */
export const OUTPUT_LIMIT_BYTES = 200 * 1024;
export const DEFAULT_TIMEOUT_SECONDS = 120;
export const MAX_TIMEOUT_SECONDS = 600;

/** The PATH used when the owner's shell said nothing usable. */
export const FALLBACK_PATH = '/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin';

export interface CommandResult {
  state: 'completed' | 'timed-out' | 'cancelled';
  exitCode: number | null;
  signal: string | null;
  stdout: string;
  stderr: string;
  /** True when something was dropped from the head of the combined output. */
  truncated: boolean;
  /** How many bytes were dropped from the heads of the two streams together. */
  omittedBytes: number;
  elapsedMs: number;
}

/**
 * The environment a child gets: an allowlist, built here, and nothing else.
 *
 * `PATH` is the toolchain path captured at `developer.workspace` time — the
 * owner's login shell asked once, printed on the approval card, and stored on
 * the workspace row. That is how `pnpm` and `python` are found without a login
 * shell running on every command, and it is a value the owner saw.
 *
 * `CI=1` because a runner that opens a pager or waits for a TTY inside a tool
 * call is a tool call that times out.
 */
export function childEnv(opts: {
  toolchainPath: string;
  env?: NodeJS.ProcessEnv;
  extra?: Record<string, string>;
}): NodeJS.ProcessEnv {
  const source = opts.env ?? process.env;
  const out: NodeJS.ProcessEnv = {};
  for (const key of ['HOME', 'USER', 'LANG', 'LC_ALL', 'TERM', 'TMPDIR', 'SHELL']) {
    const value = source[key];
    if (value !== undefined && value !== '') out[key] = value;
  }
  out.PATH = opts.toolchainPath === '' ? FALLBACK_PATH : opts.toolchainPath;
  out.CI = '1';
  for (const [key, value] of Object.entries(opts.extra ?? {})) out[key] = value;
  return out;
}

/**
 * The environment for this plugin's *own* helpers — `ps`, `lsof`, `ss`, and
 * the one login-shell call that captures the toolchain PATH.
 *
 * They are not the workspace's programs and have no business with the
 * workspace's PATH, so they get a fixed system one and four variables. It is
 * separate from `childEnv` because the two answer different questions: what
 * may a project's code see, and what does this plugin need to ask the
 * operating system a question.
 */
export const SYSTEM_PATH = '/usr/bin:/bin:/usr/sbin:/sbin';

export function minimalEnv(env: NodeJS.ProcessEnv = process.env): NodeJS.ProcessEnv {
  const out: NodeJS.ProcessEnv = { PATH: SYSTEM_PATH };
  for (const key of ['HOME', 'USER', 'SHELL', 'TERM']) {
    const value = env[key];
    if (value !== undefined && value !== '') out[key] = value;
  }
  return out;
}

/**
 * The names a child must never see, as a predicate.
 *
 * `childEnv` is an allowlist and so already excludes all of them; this exists
 * for the test that asserts it, so that an edit turning the allowlist back
 * into a denylist fails loudly instead of quietly.
 */
export function isSecretEnvName(name: string): boolean {
  return (
    name === 'DATABASE_URL' ||
    name.startsWith('BUDDI_') ||
    /_(KEY|TOKEN|SECRET|PASSWORD|PASSWD|CREDENTIALS)$/i.test(name) ||
    /^(ANTHROPIC|OPENAI|AWS|GITHUB|NPM|GH|TAVILY)_/i.test(name)
  );
}

/**
 * The owner's own `PATH`, asked of their login shell exactly once.
 *
 * The one place a login shell is used, and it runs a *constant*: nothing a
 * model wrote reaches it. It happens at `developer.workspace` time, the answer
 * goes on the approval card, and every command afterwards runs with that PATH
 * and no shell at all.
 */
export async function captureToolchainPath(
  env: NodeJS.ProcessEnv = process.env,
): Promise<string> {
  const shell = env.SHELL?.trim();
  if (!shell || !shell.startsWith('/')) return FALLBACK_PATH;
  const result = await runArgv({
    file: shell,
    args: ['-lc', 'printf %s "$PATH"'],
    cwd: os.tmpdir(),
    timeoutSeconds: 15,
    // The shell is asked for a value; it is not handed buddi's environment
    // while it sources the owner's rc files.
    env: minimalEnv(env),
  }).catch(() => undefined);
  const captured = result?.exitCode === 0 ? result.stdout.trim() : '';
  if (captured === '') return FALLBACK_PATH;
  // Absolute directories only: a relative entry would make the meaning of a
  // program name depend on the directory a command happened to run in.
  const parts = captured
    .split(':')
    .map((part) => part.trim())
    .filter((part) => part !== '' && path.isAbsolute(part));
  return parts.length === 0 ? FALLBACK_PATH : [...new Set(parts)].join(':');
}

/** Keep the last `limit` bytes of a growing stream, and say if anything went. */
class Tail {
  #chunks: Buffer[] = [];
  #bytes = 0;
  dropped = false;
  /** Bytes let go from the head so far. */
  droppedBytes = 0;

  constructor(private readonly limit: number) {}

  push(bytes: Buffer): void {
    if (bytes.length === 0) return;
    this.#chunks.push(bytes);
    this.#bytes += bytes.length;
    while (this.#bytes > this.limit && this.#chunks.length > 1) {
      const first = this.#chunks.shift() as Buffer;
      this.#bytes -= first.length;
      this.droppedBytes += first.length;
      this.dropped = true;
    }
    if (this.#bytes > this.limit) {
      const only = this.#chunks[0] as Buffer;
      this.#chunks[0] = only.subarray(only.length - this.limit);
      this.droppedBytes += only.length - this.limit;
      this.#bytes = this.limit;
      this.dropped = true;
    }
  }

  toString(): string {
    return Buffer.concat(this.#chunks).toString('utf8');
  }
}

export function clampTimeout(seconds: number | undefined): number {
  const wanted = seconds ?? DEFAULT_TIMEOUT_SECONDS;
  return Math.max(1, Math.min(MAX_TIMEOUT_SECONDS, Math.floor(wanted)));
}

export interface RunOptions {
  file: string;
  args: readonly string[];
  cwd: string;
  timeoutSeconds?: number;
  /**
   * **Required**, and that is the point: an optional `env` means a call site
   * that forgot one hands the child `process.env`, which is how
   * `DATABASE_URL` and the vault key reached a project's test script in the
   * first version. There is no way to spawn from this module without saying
   * what the child may see.
   */
  env: NodeJS.ProcessEnv;
  signal?: AbortSignal;
}

/**
 * One program, one argument vector, one directory.
 *
 * `shell: false` is the default and is never changed. `detached` gives the
 * child its own process group, so a timeout takes what it started with it.
 *
 * The 200 KB is over stdout and stderr **together**: two 200 KB tails is
 * 400 KB in the projection where §4 says 200, and a command that floods
 * stderr must not be able to push stdout out of the bound by being a second
 * stream.
 */
export async function runArgv(opts: RunOptions): Promise<CommandResult> {
  if (os.platform() === 'win32') {
    throw new Error('developer: running commands needs macOS or Linux.');
  }
  const timeoutMs = clampTimeout(opts.timeoutSeconds) * 1000;
  const started = Date.now();
  return new Promise<CommandResult>((resolve, reject) => {
    const child = spawn(opts.file, [...opts.args], {
      cwd: opts.cwd,
      env: opts.env,
      detached: true,
      shell: false,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    const stdout = new Tail(OUTPUT_LIMIT_BYTES);
    const stderr = new Tail(OUTPUT_LIMIT_BYTES);
    let state: CommandResult['state'] = 'completed';
    let hardKill: ReturnType<typeof setTimeout> | undefined;

    const killGroup = (signal: NodeJS.Signals): void => {
      if (child.pid === undefined) return;
      try {
        process.kill(-child.pid, signal);
      } catch {
        /* already gone */
      }
    };
    const stop = (reason: CommandResult['state']): void => {
      if (state !== 'completed') return;
      state = reason;
      killGroup('SIGTERM');
      hardKill = setTimeout(() => killGroup('SIGKILL'), 500);
    };
    const abort = (): void => stop('cancelled');
    const timer = setTimeout(() => stop('timed-out'), timeoutMs);
    opts.signal?.addEventListener('abort', abort, { once: true });
    if (opts.signal?.aborted) abort();

    child.stdout.on('data', (bytes: Buffer) => stdout.push(bytes));
    child.stderr.on('data', (bytes: Buffer) => stderr.push(bytes));

    const cleanup = (): void => {
      clearTimeout(timer);
      if (hardKill) clearTimeout(hardKill);
      opts.signal?.removeEventListener('abort', abort);
      // Nothing a command started outlives it. A dev server belongs to
      // `developer.start`, which keeps its own row and its own pid.
      killGroup('SIGKILL');
    };
    child.once('error', (error) => {
      cleanup();
      reject(error);
    });
    child.once('close', (exitCode, signal) => {
      cleanup();
      const bounded = boundCombined(stdout.toString(), stderr.toString());
      resolve({
        state,
        exitCode,
        signal,
        stdout: bounded.stdout,
        stderr: bounded.stderr,
        truncated: stdout.dropped || stderr.dropped || bounded.truncated,
        omittedBytes: stdout.droppedBytes + stderr.droppedBytes + bounded.omittedBytes,
        elapsedMs: Date.now() - started,
      });
    });
  });
}

/**
 * The combined bound, applied once at the end.
 *
 * stderr gets at most half, because a failure says why in its last lines and
 * losing stderr entirely to a chatty stdout is losing the answer.
 */
export function boundCombined(
  stdout: string,
  stderr: string,
  limit = OUTPUT_LIMIT_BYTES,
): { stdout: string; stderr: string; truncated: boolean; omittedBytes: number } {
  const outBytes = Buffer.from(stdout, 'utf8');
  const errBytes = Buffer.from(stderr, 'utf8');
  if (outBytes.length + errBytes.length <= limit) {
    return { stdout, stderr, truncated: false, omittedBytes: 0 };
  }
  const keepErr = Math.min(errBytes.length, Math.floor(limit / 2));
  const keepOut = Math.min(outBytes.length, limit - keepErr);
  return {
    stdout: outBytes.subarray(outBytes.length - keepOut).toString('utf8'),
    stderr: errBytes.subarray(errBytes.length - keepErr).toString('utf8'),
    truncated: true,
    omittedBytes: outBytes.length - keepOut + (errBytes.length - keepErr),
  };
}

/**
 * Find a program on a given PATH, absolutely, without a shell.
 *
 * Used at `developer.workspace` time for `git`, so that "git" means one file
 * on disk for the life of the workspace rather than "whatever is first on a
 * PATH that a later edit might change".
 */
export async function resolveProgram(
  name: string,
  toolchainPath: string,
): Promise<string | undefined> {
  const { promises: fs, constants } = await import('node:fs');
  for (const dir of toolchainPath.split(':')) {
    if (dir.trim() === '' || !path.isAbsolute(dir)) continue;
    const candidate = path.join(dir, name);
    try {
      const info = await fs.lstat(candidate);
      if (info.isSymbolicLink() || info.isFile()) {
        await fs.access(candidate, constants.X_OK);
        return candidate;
      }
    } catch {
      /* not here */
    }
  }
  return undefined;
}
