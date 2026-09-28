/**
 * `developer.failing_tests`: the last recorded test run, read as a number.
 *
 * The memo it reads is this process's (`summarise.ts`), so the whole metric is
 * testable without a database — everything except the workspace lookup, which
 * is one `select` the fake context below answers.
 *
 * Most of what is held down here is the shape of the *silence*. A goal on this
 * number is settled `met` the moment it reads a zero, so every case where we
 * do not actually know that the tests pass has to be `null`: a typecheck that
 * exited 0, a red run whose output never counted anything, a file called
 * `0 failed.test.ts`, a summary line that counts files rather than tests. And
 * a monorepo that prints one summary per package has to add up.
 */
import { afterEach, describe, expect, it } from 'vitest';
import { ToolRegistry, createPluginHost, hostBindingOf } from '@buddi/core/testing';
import { failingTests, failingTestsIn, isTestRunner } from './metrics.js';
import { forgetTestRuns, rememberTestRun, type TestRun } from './summarise.js';
import { manifest } from './index.js';

const AT = '2026-09-21T09:00:00.000Z';

/** A context whose one query answers with a workspace row, or with none. */
function ctx(opts: { workspace?: boolean; agentId?: string | null } = {}): never {
  // `null` means the context names no agent at all — not the same as a default.
  const agentId = opts.agentId === null ? undefined : (opts.agentId ?? 'dev');
  const rows =
    opts.workspace === false
      ? []
      : [
          {
            agent_id: agentId ?? 'dev',
            dir: '/tmp/work',
            mode: 'edit',
            toolchain_path: '',
            git_path: 'git',
            created_at: new Date(AT),
            updated_at: new Date(AT),
          },
        ];
  const facts = {
    db: { query: async () => ({ rows }) },
    now: () => new Date(AT),
    timezone: 'UTC',
    ...(agentId === undefined ? {} : { agentId }),
  } as never;
  return { ...(facts as object), buddi: createPluginHost(hostBindingOf(manifest), facts) } as never;
}

const run = (over: Partial<TestRun> = {}): TestRun => ({
  command: 'pnpm test',
  exitCode: 1,
  state: 'completed',
  output: 'Tests  2 failed | 10 passed (12)',
  at: AT,
  ...over,
});

afterEach(() => forgetTestRuns());

describe('which commands are a test run at all', () => {
  it('accepts the runners that report how many tests failed', () => {
    for (const command of [
      'vitest run',
      'jest --ci',
      'pytest -q',
      'python3 -m pytest tests/',
      'python -m unittest discover',
      'go test ./...',
      'cargo test --all',
      'pnpm -r test',
      'npm run test',
      'yarn test',
      'bun test',
      'node --test',
      'make test',
    ]) {
      expect(isTestRunner(command), command).toBe(true);
    }
  });

  it('refuses everything that says nothing about tests', () => {
    for (const command of [
      'tsc -p tsconfig.json',
      'pnpm typecheck',
      'pnpm -r lint',
      'npm run check',
      'eslint .',
      'ruff check .',
      'go vet ./...',
      'node scripts/build.mjs',
      'cargo build',
      'make check',
    ]) {
      expect(isTestRunner(command), command).toBe(false);
    }
  });
});

describe('reading a count out of what the runner printed', () => {
  it('takes the figure the runner stated, per runner', () => {
    expect(failingTestsIn(run())).toBe(2);
    expect(failingTestsIn(run({ command: 'jest', output: 'Tests:       3 failed, 40 passed, 43 total' }))).toBe(3);
    expect(
      failingTestsIn(run({ command: 'pytest', output: '=========== 2 failed, 10 passed in 3.11s ===========' })),
    ).toBe(2);
    expect(
      failingTestsIn(run({ command: 'cargo test', output: 'test result: FAILED. 12 passed; 3 failed; 0 ignored' })),
    ).toBe(3);
    expect(failingTestsIn(run({ command: 'node --test', output: '# pass 40\n# fail 4' }))).toBe(4);
    expect(
      failingTestsIn(run({ command: 'go test ./...', output: '--- FAIL: TestA (0.00s)\n    --- FAIL: TestA/sub\nFAIL' })),
    ).toBe(2);
  });

  it('adds up every package of a monorepo run, rather than believing the last one', () => {
    const output = [
      'core test:  Tests  2 failed | 100 passed (102)',
      'core test: Done',
      'web test:  Tests  5 failed | 40 passed (45)',
      'cli test:  Tests  1 failed | 9 passed (10)',
    ].join('\n');
    expect(failingTestsIn(run({ command: 'pnpm -r test', output }))).toBe(8);
  });

  it('believes the exit code over the text: 0 is green', () => {
    expect(failingTestsIn(run({ exitCode: 0, output: 'retried after 1 failed attempt' }))).toBe(0);
  });

  it('is null for a green typecheck — it is not a test run, whatever it exited', () => {
    expect(failingTestsIn(run({ command: 'pnpm typecheck', exitCode: 0, output: '' }))).toBeNull();
    expect(failingTestsIn(run({ command: 'tsc -p tsconfig.json', exitCode: 0, output: '' }))).toBeNull();
  });

  it('is null for a red run whose summary counts files rather than tests', () => {
    // vitest, when collection fails: one file is red and no test ran.
    const output = ' Test Files  1 failed (1)\n      Tests  0 failed (0)';
    expect(failingTestsIn(run({ output }))).toBeNull();
  });

  it('does not read a count out of a file name', () => {
    expect(failingTestsIn(run({ output: 'FAIL src/0 failed.test.ts\nsegmentation fault' }))).toBeNull();
    expect(failingTestsIn(run({ output: 'FAIL src/3 failed.test.ts' }))).toBeNull();
  });

  it('is null when it went badly and never said how badly', () => {
    expect(failingTestsIn(run({ output: 'FAIL src/thing.test.ts\nsegmentation fault' }))).toBeNull();
    expect(failingTestsIn(run({ state: 'timed-out', exitCode: null, output: 'Tests  3 failed' }))).toBeNull();
    expect(failingTestsIn(run({ state: 'cancelled', exitCode: null, output: '' }))).toBeNull();
  });
});

describe('the metric itself', () => {
  it('is on the manifest, a count that should go down, and takes no narrowing', () => {
    expect(manifest.metrics).toEqual([failingTests]);
    expect(failingTests.id).toBe('developer.failing_tests');
    expect(failingTests.unit).toBe('count');
    expect(failingTests.direction).toBe('down');
    // The narrowing core stores is the strict one it makes of what is
    // declared: a metric that takes none takes none, whoever is asking.
    const registry = new ToolRegistry();
    registry.register(manifest);
    const registered = registry.metric('developer.failing_tests');
    expect(registered?.params?.safeParse({}).success).toBe(true);
    expect(registered?.params?.safeParse({ workspace: 'x' }).success).toBe(false);
  });

  it('answers the last recorded run for this agent, as of when it ran', async () => {
    rememberTestRun('dev', run());
    const reading = await failingTests.measure({}, ctx());
    expect(reading).toMatchObject({ value: 2 });
    expect(reading?.asOf.toISOString()).toBe(AT);
    expect(reading?.note).toContain('pnpm test');
  });

  it('is null with no workspace, even when a run is remembered', async () => {
    rememberTestRun('dev', run());
    expect(await failingTests.measure({}, ctx({ workspace: false }))).toBeNull();
  });

  it('is null with no run recorded — a restart loses the memo and says so', async () => {
    expect(await failingTests.measure({}, ctx())).toBeNull();
  });

  it('is null when the context names no agent: a workspace belongs to one', async () => {
    rememberTestRun('dev', run());
    expect(await failingTests.measure({}, ctx({ agentId: null }))).toBeNull();
  });

  it('reads the memo of the agent in the context, not somebody else\'s', async () => {
    rememberTestRun('other', run({ output: 'Tests  9 failed' }));
    expect(await failingTests.measure({}, ctx())).toBeNull();
  });

  it('is null when the remembered run was a typecheck the agent happened to run last', async () => {
    rememberTestRun('dev', run({ command: 'pnpm typecheck', exitCode: 0, output: '' }));
    expect(await failingTests.measure({}, ctx())).toBeNull();
  });
});
