/**
 * The number a goal can watch here: how many tests are failing.
 *
 * It is read from what `developer.summarise` reads — the last `developer.run`
 * whose command looked like a test run, remembered in this process per agent
 * (`summarise.ts`). Nothing here runs anything: a metric is measured on a
 * schedule, by a sentinel tick with no owner in front of it, and a metric that
 * could start a test suite would be a way to run commands in the owner's
 * workspace without anybody asking for it. The number is therefore about the
 * last run that *did* happen, and `asOf` is when it happened.
 *
 * Two rules, and both of them exist because a goal on this number can be
 * settled **met** by a lie:
 *
 *  1. **Only a test runner is believed.** `looksLikeTests` is deliberately
 *     wider than that — it is the net for "the last thing the review panel
 *     shows", and it accepts `tsc`, `eslint`, `ruff`, `pnpm typecheck`. Those
 *     say nothing about tests, and an exit code of 0 from one of them would
 *     otherwise be measured as "0 failing tests" and reach the owner as a goal
 *     reached. So this asks a narrower question (`isTestRunner`) and answers
 *     `null` for everything else.
 *  2. **Only a runner's own summary line is a count, and every one of them
 *     counts.** `pnpm -r test` prints one summary per package: taking the last
 *     figure reported 1 while eight tests were red, and a stray "0 failed"
 *     after a real summary reported a green suite on a red run. The summaries
 *     are anchored to the line each runner ends with, and **summed**.
 *
 * `null` is the ordinary answer, and there are five ways to it: no workspace,
 * no agent in the context, no test run recorded (a restart loses the memo,
 * which `summarise` already says out loud), a run that was not a test runner,
 * and a run that failed without any summary saying how many tests did. "Not
 * measured since Tuesday" is true in all five; a zero would be a claim that
 * the suite is green.
 */
import type { MetricDefinition } from '@buddi/core/plugin';
import { z } from 'zod';
import { workspaceOrNull } from './store.js';
import { recallTestRun, type TestRun } from './summarise.js';

/** The first word that is not a flag — a subcommand, as the runners spell it. */
function subcommand(words: readonly string[]): string {
  return words.find((word) => !word.startsWith('-')) ?? '';
}

/**
 * Does this command line run tests *and report how many failed*?
 *
 * Narrower than `looksLikeTests` on purpose, and the difference is the whole
 * point: that one asks "is this the test run to show the owner", this one asks
 * "is this a thing whose exit code and output are about tests at all". A
 * typecheck, a lint and a formatter are all legitimate answers to the first
 * and none of them is an answer to the second.
 */
export function isTestRunner(command: string): boolean {
  const words = command.trim().split(/\s+/);
  const program = (words[0] ?? '').split('/').pop() ?? '';
  const rest = words.slice(1);
  if (/^(vitest|jest|pytest)$/.test(program)) return true;
  // `node --test`, and only with the flag: plain `node` runs anything at all.
  if (program === 'node') return rest.includes('--test');
  if (program === 'python' || program === 'python3') {
    const at = rest.indexOf('-m');
    return at >= 0 && /^(pytest|unittest)$/.test(rest[at + 1] ?? '');
  }
  if (program === 'go' || program === 'cargo' || program === 'make') {
    return subcommand(rest) === 'test';
  }
  if (/^(npm|pnpm|yarn|bun)$/.test(program)) {
    const sub = subcommand(rest);
    const after = subcommand(rest.slice(rest.indexOf(sub) + 1));
    const named = sub === 'run' ? after : sub;
    return named === 'test' || named === 'tests';
  }
  return false;
}

/**
 * What may stand in front of a summary line: a short `<package> test: ` label,
 * because that is what a workspace runner puts there, and every summary of a
 * `pnpm -r test` would otherwise be invisible — which is the run this
 * repository's own agents make most.
 */
const PREFIX = String.raw`^(?:[^\n:]{0,40}: )?\s*`;

/**
 * The line each runner ends with, and nothing else.
 *
 * Anchored at the start of a line, so that `FAIL src/0 failed.test.ts` — a
 * real file name — is not a count, and so that vitest's `Test Files 1 failed`
 * (a count of *files*) is never read as a count of tests.
 */
const SUMMARIES: readonly RegExp[] = [
  // vitest: "Tests  2 failed | 10 passed (12)"
  new RegExp(`${PREFIX}Tests\\s+(\\d+) failed`, 'gm'),
  // jest: "Tests:       3 failed, 40 passed, 43 total"
  new RegExp(`${PREFIX}Tests:\\s+(\\d+) failed`, 'gm'),
  // pytest's final banner: "=== 2 failed, 10 passed in 3.11s ==="
  new RegExp(`${PREFIX}=+[^\\n]*?\\b(\\d+) failed\\b[^\\n]*=+\\s*$`, 'gm'),
  // cargo: "test result: FAILED. 12 passed; 3 failed; 0 ignored"
  new RegExp(`${PREFIX}test result:[^\\n]*?\\b(\\d+) failed\\b`, 'gm'),
  // node --test: "# fail 2"
  new RegExp(`${PREFIX}# fail (\\d+)\\s*$`, 'gm'),
];

/** `go test` prints one of these per failing test; there is no total line. */
const GO_FAIL = new RegExp(`${PREFIX}--- FAIL: `, 'gm');

/**
 * How many tests failed, from what the runner printed.
 *
 * Every anchored summary in the output is added up, because one run may be
 * many runners (`pnpm -r test`). A run that **exited 0** is green whatever its
 * text says: the exit code is the runner's own verdict and no parse may
 * overrule it. A non-zero exit whose summaries add up to nothing — none found,
 * or all of them zero — is `null`: the run failed for a reason the count does
 * not name (a collection error, a compile failure, a crashed worker), and
 * answering 0 there is the one thing this must never do.
 */
export function failingTestsIn(run: TestRun): number | null {
  if (run.state !== 'completed') return null;
  if (!isTestRunner(run.command)) return null;
  if (run.exitCode === 0) return 0;
  let total = 0;
  for (const pattern of SUMMARIES) {
    for (const match of run.output.matchAll(pattern)) {
      const n = Number(match[1]);
      if (Number.isInteger(n)) total += n;
    }
  }
  total += [...run.output.matchAll(GO_FAIL)].length;
  return total > 0 ? total : null;
}

export const failingTests: MetricDefinition = {
  id: 'developer.failing_tests',
  description:
    'How many tests were failing in the last test run recorded for your workspace — the same run ' +
    'developer.summarise reports, when that run was an actual test runner (vitest, jest, pytest, go ' +
    'test, cargo test, npm/pnpm/yarn/bun test, node --test, make test). It never runs anything: with ' +
    'no workspace, no recorded run, a typecheck or a lint rather than a test run, or a failure whose ' +
    'output never said how many tests failed, there is no number.',
  unit: 'count',
  direction: 'down',
  params: z.object({}),
  async measure(_params, ctx) {
    const workspace = await workspaceOrNull(ctx);
    if (workspace === undefined) return null;
    const agentId = ctx.agentId?.trim();
    if (!agentId) return null;
    const run = recallTestRun(agentId);
    if (run === undefined) return null;
    const value = failingTestsIn(run);
    if (value === null) return null;
    return {
      value,
      asOf: new Date(run.at),
      note: `${run.command} — exit ${run.exitCode} at ${run.at}`,
    };
  },
};

export const developerMetrics: MetricDefinition[] = [failingTests];
