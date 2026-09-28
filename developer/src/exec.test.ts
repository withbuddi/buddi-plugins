/**
 * The runner: what a child is given, and what it is never given.
 *
 * The environment test spawns a **real** child and reads what arrived, rather
 * than asserting on the object `childEnv` returned. That is the whole point:
 * the review's finding was that the service's own environment — `DATABASE_URL`,
 * `BUDDI_*`, the vault's key, every model token — reached a project's test
 * script, and the only honest way to say it no longer does is to look at what
 * a process actually sees.
 */
import { readFile, readdir } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import {
  FALLBACK_PATH,
  SYSTEM_PATH,
  minimalEnv,
  boundCombined,
  childEnv,
  clampTimeout,
  isSecretEnvName,
  resolveProgram,
  runArgv,
} from './exec.js';

const SERVICE_ENV = {
  HOME: '/home/owner',
  USER: 'owner',
  LANG: 'en_GB.UTF-8',
  SHELL: '/bin/zsh',
  PATH: '/usr/bin:/bin',
  DATABASE_URL: 'postgres://buddi:hunter2@127.0.0.1:5432/buddi',
  BUDDI_VAULT_KEY: 'AGE-SECRET-KEY-1',
  BUDDI_DATA_DIR: '/home/owner/.buddi',
  ANTHROPIC_API_KEY: 'sk-ant-secret',
  GITHUB_TOKEN: 'ghp_secret',
  SOME_PASSWORD: 'hunter2',
};

describe('childEnv', () => {
  it('is an allowlist: nothing arrives that was not named', () => {
    const env = childEnv({ toolchainPath: '/opt/bin:/usr/bin', env: SERVICE_ENV });
    // `LOGNAME` was on this list and is not any more: it is the owner's login
    // name a second time, and a name nothing needs is a name not to pass.
    expect(Object.keys(env).sort()).toEqual(['CI', 'HOME', 'LANG', 'PATH', 'SHELL', 'USER']);
    expect(env.PATH).toBe('/opt/bin:/usr/bin');
    expect(env.CI).toBe('1');
  });

  it('falls back to a fixed PATH when the workspace has none yet', () => {
    expect(childEnv({ toolchainPath: '', env: SERVICE_ENV }).PATH).toBe(FALLBACK_PATH);
  });

  it('lets a caller add what it means to add, and nothing implicitly', () => {
    const env = childEnv({
      toolchainPath: '/usr/bin',
      env: SERVICE_ENV,
      extra: { GIT_CONFIG_NOSYSTEM: '1' },
    });
    expect(env.GIT_CONFIG_NOSYSTEM).toBe('1');
    expect(env.DATABASE_URL).toBeUndefined();
  });

  it('knows what a secret name looks like, so a future denylist edit fails loudly', () => {
    for (const name of Object.keys(SERVICE_ENV).filter((key) => key !== 'HOME')) {
      const secret = isSecretEnvName(name);
      const allowed = ['USER', 'LANG', 'SHELL', 'PATH'].includes(name);
      expect([name, secret]).toEqual([name, !allowed]);
    }
  });

  it('gives a real child none of them', async () => {
    const result = await runArgv({
      file: '/usr/bin/env',
      args: [],
      cwd: '/',
      timeoutSeconds: 10,
      env: childEnv({ toolchainPath: '/usr/bin:/bin', env: SERVICE_ENV }),
    });
    expect(result.exitCode).toBe(0);
    const names = result.stdout
      .split('\n')
      .filter((line) => line.includes('='))
      .map((line) => line.split('=')[0] as string);
    for (const name of names) expect([name, isSecretEnvName(name)]).toEqual([name, false]);
    expect(result.stdout).not.toContain('hunter2');
    expect(result.stdout).not.toContain('sk-ant-secret');
    expect(result.stdout).not.toContain('ghp_secret');
  });

  /**
   * And the counter-test: the same child, given the service's environment the
   * way the first version of this plugin gave it. If this ever stops failing
   * to find the secret, `childEnv` has stopped being an allowlist.
   */
  it('is the difference that matters: the same child with process.env sees everything', async () => {
    const result = await runArgv({
      file: '/usr/bin/env',
      args: [],
      cwd: '/',
      timeoutSeconds: 10,
      env: SERVICE_ENV,
    });
    expect(result.stdout).toContain('hunter2');
  });
});

describe('runArgv', () => {
  it('runs a program with no shell at all', async () => {
    const result = await runArgv({
      file: '/bin/echo',
      // If this went through a shell, the output would be a list of files.
      args: ['*'],
      cwd: '/',
      timeoutSeconds: 10,
      env: childEnv({ toolchainPath: '/usr/bin:/bin' }),
    });
    expect(result.stdout.trim()).toBe('*');
  });

  it('carries the exit code and the elapsed time back', async () => {
    const result = await runArgv({
      file: '/usr/bin/false',
      args: [],
      cwd: '/',
      timeoutSeconds: 10,
      env: childEnv({ toolchainPath: '/usr/bin:/bin' }),
    });
    expect(result.exitCode).toBe(1);
    expect(result.state).toBe('completed');
    expect(result.elapsedMs).toBeGreaterThanOrEqual(0);
  });

  it('times out, and says so rather than hanging a run', async () => {
    const result = await runArgv({
      file: '/bin/sleep',
      args: ['30'],
      cwd: '/',
      timeoutSeconds: 1,
      env: childEnv({ toolchainPath: '/usr/bin:/bin' }),
    });
    expect(result.state).toBe('timed-out');
  }, 20_000);

  it('clamps a timeout to the bounds §4 gives', () => {
    expect(clampTimeout(undefined)).toBe(120);
    expect(clampTimeout(5)).toBe(5);
    expect(clampTimeout(100_000)).toBe(600);
    expect(clampTimeout(0)).toBe(1);
  });
});

describe('the output bound', () => {
  it('is 200 KB over both streams together, not 200 KB each', () => {
    const out = 'o'.repeat(300 * 1024);
    const err = 'e'.repeat(300 * 1024);
    const bounded = boundCombined(out, err);
    const total = Buffer.byteLength(bounded.stdout) + Buffer.byteLength(bounded.stderr);
    expect(total).toBeLessThanOrEqual(200 * 1024);
    expect(bounded.truncated).toBe(true);
    // stderr keeps at most half, so a chatty stdout never silences the reason
    // a command failed.
    expect(Buffer.byteLength(bounded.stderr)).toBe(100 * 1024);
  });

  it('keeps the tail, because a failure says why at the end', () => {
    const bounded = boundCombined('abcdefghij', '', 4);
    expect(bounded.stdout).toBe('ghij');
    // And says how much of the head went, for "first N KB not shown".
    expect(bounded.omittedBytes).toBe(6);
  });

  it('leaves small output exactly as it was', () => {
    expect(boundCombined('a', 'b')).toEqual({ stdout: 'a', stderr: 'b', truncated: false, omittedBytes: 0 });
  });
});

describe('resolveProgram', () => {
  it('finds a program on the given PATH, absolutely', async () => {
    expect(await resolveProgram('sh', '/usr/bin:/bin')).toMatch(/\/sh$/);
  });

  it('says nothing about a program that is not on it', async () => {
    expect(await resolveProgram('sh', '/nowhere')).toBeUndefined();
    expect(await resolveProgram('definitely-not-a-program', '/usr/bin:/bin')).toBeUndefined();
  });

  it('ignores a relative PATH entry, so a program cannot mean two things', async () => {
    expect(await resolveProgram('sh', 'relative/bin')).toBeUndefined();
  });
});

describe('minimalEnv', () => {
  /**
   * `ps`, `lsof`, `ss` and the one login-shell call are this plugin asking
   * the operating system a question. They are not the workspace's programs
   * and have no business with the workspace's PATH.
   */
  it('is four variables and a system PATH', () => {
    const env = minimalEnv({ ...SERVICE_ENV, TERM: 'xterm' });
    expect(Object.keys(env).sort()).toEqual(['HOME', 'PATH', 'SHELL', 'TERM', 'USER']);
    expect(env.PATH).toBe(SYSTEM_PATH);
    expect(env.DATABASE_URL).toBeUndefined();
  });
});

/**
 * The structural half of "nothing inherits buddi's environment".
 *
 * `RunOptions.env` is required, so a `runArgv` call cannot forget one — the
 * compiler says so. This covers the other way a child is made: a direct
 * `spawn`, of which this plugin has exactly one (the long-lived process), and
 * it is read here rather than trusted.
 */
describe('no child inherits the service environment', () => {
  const SRC = path.resolve(path.dirname(fileURLToPath(import.meta.url)));

  it('passes an explicit env at every spawn, and never process.env', async () => {
    const files: string[] = [];
    const walk = async (dir: string): Promise<void> => {
      for (const entry of await readdir(dir, { withFileTypes: true })) {
        const full = path.join(dir, entry.name);
        if (entry.isDirectory()) await walk(full);
        else if (entry.name.endsWith('.ts') && !entry.name.endsWith('.test.ts')) files.push(full);
      }
    };
    await walk(SRC);
    expect(files.length).toBeGreaterThan(10);

    for (const file of files) {
      const text = await readFile(file, 'utf8');
      expect([file, /env:\s*process\.env/.test(text)]).toEqual([file, false]);
      // Every `spawn(` in this plugin names an environment within the next
      // few lines. `exec.ts` and `processes.ts` are the only two that spawn.
      for (const match of text.matchAll(/\bspawn\(/g)) {
        const after = text.slice(match.index ?? 0, (match.index ?? 0) + 400);
        expect([file, after.includes('env:')]).toEqual([file, true]);
      }
    }
  });

  it('requires an environment at the type level, so a call site cannot forget', async () => {
    const exec = await readFile(path.join(SRC, 'exec.ts'), 'utf8');
    expect(exec).toMatch(/\n  env: NodeJS\.ProcessEnv;/);
    expect(exec).not.toMatch(/\n  env\?: NodeJS\.ProcessEnv;\n  signal/);
  });
});
