/**
 * The native helper: one fixed executable, spawned once per operation with a
 * bounded JSON request on stdin and a bounded JSON answer on stdout. No shell,
 * no script, nothing the model wrote. Built from `native/Computer.swift`
 * (`scripts/build-native.mjs`) and shipped in the npm package as
 * `helper/buddi-computer`, universal and signed ad hoc.
 */
import { execFile, spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { PreconditionError } from './errors.js';

/** Where the helper sits in this package, in a checkout and in the npm tarball alike. */
export const HELPER_PATH = fileURLToPath(new URL('../helper/buddi-computer', import.meta.url));
/** The sentence when it is not there. */
export const HELPER_MISSING = 'The computer helper isn’t installed, so agents can’t reach your apps. Reinstall the Computer plugin (Settings → Plugins), or in a checkout run pnpm build in buddi-plugins/computer.';
export const MAC_ONLY = 'Computer control works on macOS only (14 or newer). On this computer agents use buddi’s own browser and your Chrome.';

/** One request to the helper, and its answer. */
export interface ComputerBridge {
  run(input: Record<string, unknown>): Promise<Record<string, unknown>>;
  cancel(): void;
}

/** Do not copy vault, provider or database secrets into the native UI helper. */
export function helperEnvironment(env: NodeJS.ProcessEnv = process.env): NodeJS.ProcessEnv {
  return Object.fromEntries(['PATH', 'HOME', 'TMPDIR', 'LANG', 'LC_ALL', 'USER', 'LOGNAME']
    .filter((key) => typeof env[key] === 'string').map((key) => [key, env[key]]));
}

/** A stat, cheap enough for a health the dashboard polls. */
export function helperPresent(executable = HELPER_PATH): boolean { return existsSync(executable); }

/** Bounded text from a fixed system command (Spotlight, plutil): five seconds, 4 MB. */
export function execText(file: string, args: string[]): Promise<string> {
  return new Promise((resolve, reject) => {
    execFile(file, args, { timeout: 5_000, maxBuffer: 4 << 20, env: helperEnvironment() }, (error, stdout) => error ? reject(error) : resolve(String(stdout)));
  });
}

/** One-shot, bounded, fixed native executable. */
export class NativeBridge implements ComputerBridge {
  #children = new Set<ChildProcessWithoutNullStreams>();
  constructor(readonly executable = HELPER_PATH, readonly platform: NodeJS.Platform = process.platform) {}
  run(input: Record<string, unknown>): Promise<Record<string, unknown>> {
    if (this.platform !== 'darwin') return Promise.reject(new PreconditionError(MAC_ONLY));
    return new Promise((resolve, reject) => {
      const child = spawn(this.executable, [], { env: helperEnvironment(), stdio: ['pipe', 'pipe', 'pipe'] });
      this.#children.add(child);
      const chunks: Buffer[] = []; let size = 0; let failure: Error | undefined;
      const timer = setTimeout(() => { failure = new Error('The computer helper timed out. Input may have partly gone through; look before trying again.'); child.kill('SIGKILL'); }, input.operation === 'permissions' && input.prompt ? 60_000 : 20_000);
      timer.unref();
      child.stdout.on('data', (chunk: Buffer) => {
        size += chunk.length;
        if (size > 24 * 1024 * 1024) { failure = new Error('The computer helper’s answer was too large.'); child.kill('SIGKILL'); }
        else chunks.push(chunk);
      });
      child.stderr.resume(); // Never log captured content or input values.
      child.stdin.on('error', () => {});
      child.on('error', (error) => { failure = new PreconditionError((error as NodeJS.ErrnoException).code === 'ENOENT' ? HELPER_MISSING : `The computer helper would not start: ${error.message}.`); });
      child.on('close', (code, signal) => {
        clearTimeout(timer); this.#children.delete(child);
        if (failure) { reject(failure); return; }
        if (code !== 0 || signal) { reject(new Error('The computer helper was interrupted. Look at the app before trying any input again.')); return; }
        try {
          const result = JSON.parse(Buffer.concat(chunks).toString('utf8')) as Record<string, unknown>;
          if (typeof result.error === 'string') throw result.dispatched === false ? new PreconditionError(result.error) : new Error(result.error);
          resolve(result);
        } catch (error) { reject(error); }
      });
      child.stdin.end(JSON.stringify(input));
    });
  }
  cancel(): void { for (const child of this.#children) child.kill('SIGKILL'); }
}

/** What Settings → Computer prints about the helper: present, and the version it answers. */
export async function helperFacts(bridge: ComputerBridge, executable = HELPER_PATH): Promise<{ present: boolean; version?: string }> {
  if (!helperPresent(executable)) return { present: false };
  try {
    const answer = await bridge.run({ operation: 'version' });
    return { present: true, ...(typeof answer.version === 'string' ? { version: answer.version } : {}) };
  } catch { return { present: true }; }
}
