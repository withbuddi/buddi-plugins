/**
 * §6: "The unit of review is the diff, not the command."
 *
 * `developer.summarise` is what the agent calls when it says it is done, and
 * what the owner actually reads. It is one read of the repository — branch,
 * base, diff stat, diff, changed files — plus the last test command the agent
 * ran and how it went.
 *
 * **Where the test result comes from.** There is no "test result" in git, and
 * inventing a table for it would mean writing a row on every command. It is
 * kept in this process, keyed by agent: the last `developer.run` whose command
 * reads as a test run, with its exit code and the tail of its output. A
 * restart loses it and `summarise` then says `testCommand: null` rather than
 * something it cannot stand behind — which is the honest answer, since the run
 * that would have produced it is also gone.
 */
import {
  NO_EXTERNAL_DIFF,
  NO_SIGNATURE,
  git,
  gitOut,
  currentBranch,
  defaultBranch,
  requireRepositoryRoot,
} from './git.js';
import type { GitOptions } from './git.js';

/** 200 KB, the same bound every other piece of output in this plugin has. */
export const DIFF_LIMIT_BYTES = 200 * 1024;

export interface TestRun {
  command: string;
  exitCode: number | null;
  state: 'completed' | 'timed-out' | 'cancelled';
  /** The tail of what it printed, already bounded by the runner. */
  output: string;
  at: string;
}

const lastTestRun = new Map<string, TestRun>();

/**
 * Does this command line read as "run the tests"?
 *
 * Anchored to the *program* and its subcommand, not to the word appearing
 * anywhere: the first version matched `cat testing.md`, and "the last test
 * run" in the panel the owner reviews then said something that never
 * happened.
 */
export function looksLikeTests(command: string): boolean {
  const words = command.trim().split(/\s+/);
  const program = (words[0] ?? '').split('/').pop() ?? '';
  if (/^(vitest|jest|pytest|mocha|rspec|phpunit|tsc|mypy|ruff|eslint)$/.test(program)) return true;
  if (/^(npm|pnpm|yarn|bun|go|cargo|make)$/.test(program)) {
    const sub = words.slice(1).find((word) => !word.startsWith('-')) ?? '';
    const after = words.slice(words.indexOf(sub) + 1).find((word) => !word.startsWith('-')) ?? '';
    const named = sub === 'run' ? after : sub;
    return /^(test|tests|check|typecheck|lint|vet)$/.test(named);
  }
  if (program === 'python' || program === 'python3') {
    return words.includes('-m') && /^(pytest|unittest|mypy)$/.test(words[words.indexOf('-m') + 1] ?? '');
  }
  return false;
}

export function rememberTestRun(agentId: string, run: TestRun): void {
  lastTestRun.set(agentId, run);
}

export function recallTestRun(agentId: string): TestRun | undefined {
  return lastTestRun.get(agentId);
}

/** For the tests, and for a workspace change: the memo is about one directory. */
export function forgetTestRuns(agentId?: string): void {
  if (agentId === undefined) lastTestRun.clear();
  else lastTestRun.delete(agentId);
}

export interface Summary {
  branch: string | null;
  base: string | null;
  diffStat: string;
  diff: string;
  diffTruncated: boolean;
  changedFiles: string[];
  testCommand: string | null;
  testResult: string | null;
}

function bound(text: string): { text: string; truncated: boolean } {
  if (Buffer.byteLength(text, 'utf8') <= DIFF_LIMIT_BYTES) return { text, truncated: false };
  const cut = Buffer.from(text, 'utf8').subarray(0, DIFF_LIMIT_BYTES).toString('utf8');
  return { text: cut, truncated: true };
}

/**
 * What the owner reviews.
 *
 * The diff is against the merge base with the default branch when the agent is
 * on a branch of its own, and against the working tree otherwise: the question
 * "what did this agent change" has two different answers depending on whether
 * it has committed yet, and both of them are wanted.
 */
export async function summarise(opts: GitOptions & { agentId: string }): Promise<Summary> {
  const test = recallTestRun(opts.agentId);
  const testFields = {
    testCommand: test?.command ?? null,
    testResult: test
      ? `${test.state === 'completed' ? `exit ${test.exitCode}` : test.state} at ${test.at}`
      : null,
  };
  const repository = await requireRepositoryRoot(opts).then(
    () => true,
    () => false,
  );
  if (!repository) {
    return {
      branch: null,
      base: null,
      diffStat: '',
      diff: '',
      diffTruncated: false,
      changedFiles: [],
      ...testFields,
    };
  }
  const branch = await currentBranch(opts);
  const trunk = await defaultBranch(opts);
  const mergeBase = await git(['merge-base', 'HEAD', trunk], opts);
  const base = mergeBase.exitCode === 0 ? mergeBase.stdout.trim() : null;
  // `base` when there is one: committed work *and* the working tree, which is
  // what "everything this agent did" means. Otherwise the working tree alone.
  const range = base !== null && branch !== trunk ? [base] : [];
  // `-- .` on every one of them: the workspace is the repository root, and
  // saying so keeps the pathspec rule of `git.ts` true everywhere.
  const diffRaw = await gitOut(['diff', '--no-color', ...NO_EXTERNAL_DIFF, ...range, '--', '.'], opts);
  const diffStat = await gitOut(
    ['diff', '--stat', '--no-color', ...NO_EXTERNAL_DIFF, ...range, '--', '.'],
    opts,
  );
  const changed = await gitOut(['diff', '--name-only', ...range, '--', '.'], opts);
  const { text, truncated } = bound(diffRaw);
  return {
    branch,
    base: base === null ? trunk : base,
    diffStat,
    diff: text,
    diffTruncated: truncated,
    changedFiles: changed.split('\n').filter((line) => line.trim() !== ''),
    ...testFields,
  };
}
