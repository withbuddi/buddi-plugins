/**
 * The agent's own branch, against real git in throwaway directories — a
 * brand-new repository with an unborn HEAD included, because that is where
 * `switch --create … HEAD` has nothing to cut from.
 */
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { commitOnOwnBranch, currentBranch, git, gitOut, hasCommits, type GitOptions } from './git.js';
import { realpathish } from './paths.js';

const dirs: string[] = [];

async function repo(withFirstCommit: boolean): Promise<GitOptions> {
  const dir = await realpathish(await mkdtemp(path.join(tmpdir(), 'buddi-developer-git-')));
  dirs.push(dir);
  const opts: GitOptions = { cwd: dir };
  await gitOut(['init', '--quiet', '--initial-branch=main'], opts);
  await gitOut(['config', 'user.email', 'test@example.invalid'], opts);
  await gitOut(['config', 'user.name', 'Test'], opts);
  if (withFirstCommit) {
    await writeFile(path.join(dir, 'README.md'), '# fixture\n');
    await gitOut(['add', '--all'], opts);
    await gitOut(['commit', '--no-verify', '--quiet', '-m', 'first'], opts);
  }
  return opts;
}

const refExists = async (ref: string, opts: GitOptions) =>
  (await git(['rev-parse', '--verify', '--quiet', ref], opts)).exitCode === 0;

afterEach(async () => {
  await Promise.all(dirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

describe('commitOnOwnBranch', () => {
  it('starts the agent branch in a new repository, and never creates main', async () => {
    const opts = await repo(false);
    expect(await hasCommits(opts)).toBe(false);
    await writeFile(path.join(opts.cwd, 'index.ts'), 'export const a = 1;\n');

    const first = await commitOnOwnBranch(
      { agentId: 'developer', task: 'scaffold', message: 'feat: scaffold' },
      opts,
    );
    expect(first.branch).toBe('buddi/developer/scaffold');
    expect(first.created).toBe(true);
    expect(first.firstCommit).toBe(true);
    expect(first.files).toBe(1);
    expect(await currentBranch(opts)).toBe('buddi/developer/scaffold');
    expect(await refExists('refs/heads/main', opts)).toBe(false);
    expect(await gitOut(['for-each-ref', '--format=%(refname)', 'refs/heads'], opts)).toBe(
      'refs/heads/buddi/developer/scaffold',
    );

    // A second commit continues on the same branch.
    await writeFile(path.join(opts.cwd, 'more.ts'), 'export const b = 2;\n');
    const second = await commitOnOwnBranch(
      { agentId: 'developer', task: 'scaffold', message: 'feat: more' },
      opts,
    );
    expect(second.branch).toBe('buddi/developer/scaffold');
    expect(second.created).toBe(false);
    expect(second.firstCommit).toBe(false);
    expect(await gitOut(['rev-list', '--count', 'HEAD'], opts)).toBe('2');
    expect(await refExists('refs/heads/main', opts)).toBe(false);
  });

  it('cuts the agent branch from HEAD in a repository that has commits, leaving main alone', async () => {
    const opts = await repo(true);
    const mainBefore = await gitOut(['rev-parse', 'main'], opts);
    await writeFile(path.join(opts.cwd, 'index.ts'), 'export const a = 1;\n');

    const outcome = await commitOnOwnBranch(
      { agentId: 'developer', task: 'stale balance flag', message: 'test: flag' },
      opts,
    );
    expect(outcome.branch).toBe('buddi/developer/stale-balance-flag');
    expect(outcome.created).toBe(true);
    expect(outcome.firstCommit).toBe(false);
    expect(await gitOut(['rev-parse', 'main'], opts)).toBe(mainBefore);
    expect(await gitOut(['rev-parse', 'HEAD~1'], opts)).toBe(mainBefore);
  });
});
