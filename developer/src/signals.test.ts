/**
 * The shutdown hook, in a real child process, with a real signal.
 *
 * This is the one behaviour in the plugin that cannot be observed from inside
 * the process that implements it. The review's finding was that
 * `process.once('SIGTERM', …)` *replaces* Node's default disposition, so the
 * first `developer.start` turned the buddi service into one that ignores
 * `SIGTERM` — which inverts acceptance §10.4 completely: the dev server is not
 * stopped when buddi stops, because buddi does not stop.
 *
 * So: spawn a node process that installs the hook and holds a sleeping child,
 * send it `SIGTERM`, and assert two things — that it *died* (the re-raise) and
 * that the sleeper died with it (the cleanup). An assertion on either alone
 * would have passed against the broken version.
 *
 * It runs against `dist/`, because it has to be a separate process and the
 * sources are TypeScript. `pnpm build` precedes `pnpm test` in the gauntlet;
 * without a build the suite says so and skips rather than pretending.
 */
import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const DIST = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', 'dist');
const built = existsSync(path.join(DIST, 'processes.js'));
const suite = built ? describe : describe.skip;

if (!built) {
  console.log('signals: dist/ is not built, so the shutdown-hook suite is skipped (run `pnpm build`).');
}

/**
 * What the child runs: hold two sleepers — one tracked with its real start
 * time, one tracked with a start time that does not match, standing in for a
 * recycled pid — install the hook, say the pids, and wait.
 */
const CHILD = `
import { spawn } from 'node:child_process';
const mod = await import(${JSON.stringify(path.join(DIST, 'processes.js'))});
const ours = spawn('/bin/sleep', ['60'], { detached: true, stdio: 'ignore' });
ours.unref();
const stranger = spawn('/bin/sleep', ['60'], { detached: true, stdio: 'ignore' });
stranger.unref();
mod.trackForShutdown(ours.pid, await mod.processStartedAt(ours.pid));
mod.trackForShutdown(stranger.pid, 'Thu Jan  1 00:00:00 1970');
mod.installShutdownHook();
console.log(JSON.stringify({ child: process.pid, sleeper: ours.pid, stranger: stranger.pid }));
setInterval(() => {}, 1000);
`;

function alive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

suite('the shutdown hook', () => {
  it('kills what it started and then dies of the signal itself', async () => {
    const child = spawn(process.execPath, ['--input-type=module', '-e', CHILD], {
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    const pids = await new Promise<{ child: number; sleeper: number; stranger: number }>((resolve, reject) => {
      let buffer = '';
      const timer = setTimeout(() => reject(new Error('the child never reported its pids')), 15_000);
      child.stdout.on('data', (bytes: Buffer) => {
        buffer += bytes.toString('utf8');
        const line = buffer.split('\n').find((candidate) => candidate.trim().startsWith('{'));
        if (line) {
          clearTimeout(timer);
          resolve(JSON.parse(line) as { child: number; sleeper: number; stranger: number });
        }
      });
      child.once('error', reject);
    });

    expect(alive(pids.sleeper)).toBe(true);
    expect(alive(pids.stranger)).toBe(true);

    const exit = new Promise<{ code: number | null; signal: string | null }>((resolve) => {
      child.once('close', (code, signal) => resolve({ code, signal }));
    });
    child.kill('SIGTERM');

    // The re-raise. Against the broken version this promise never settled:
    // the handler ran, the process stayed up, and the timeout was the failure.
    const outcome = await Promise.race([
      exit,
      new Promise<'ignored'>((resolve) => setTimeout(() => resolve('ignored'), 8_000)),
    ]);
    expect(outcome).not.toBe('ignored');
    if (outcome === 'ignored') {
      child.kill('SIGKILL');
      return;
    }
    // Node reports either the signal or 128+15 depending on how it exits.
    expect(outcome.signal === 'SIGTERM' || outcome.code === 143 || outcome.code === 0).toBe(true);

    // And the cleanup: the sleeper went with it.
    for (let i = 0; i < 40 && alive(pids.sleeper); i += 1) {
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
    expect(alive(pids.sleeper)).toBe(false);

    // …but the one whose recorded start time did not match was left alone.
    // A pid is a number that gets reused, and the hook signals a process
    // *group*: getting this wrong ends an unrelated session of the owner's.
    expect(alive(pids.stranger)).toBe(true);
    process.kill(pids.stranger, 'SIGKILL');
  }, 40_000);
});
