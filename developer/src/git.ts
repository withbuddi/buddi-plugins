/**
 * Git, in the six verbs §4 offers and no others — and hardened, because git
 * is a program that runs other programs.
 *
 * A review spelled the whole problem out: `.git/hooks/pre-commit`,
 * `[core] hooksPath`, `[alias] x = !sh -c …`, `core.fsmonitor`, a clean
 * filter, `GIT_EXTERNAL_DIFF`, a credential helper in `~/.gitconfig`. Every
 * one of them is arbitrary code with no card. So every call here:
 *
 *  - uses the **absolute binary** resolved from the workspace's captured PATH,
 *    not "git", so a later edit to a PATH directory cannot change what runs;
 *  - disables system and global configuration (`GIT_CONFIG_NOSYSTEM`,
 *    `GIT_CONFIG_GLOBAL=/dev/null`), so nothing in `~/.gitconfig` is read;
 *  - points `core.hooksPath` at an empty directory this plugin owns, and turns
 *    off the fsmonitor, the pager, signing and `core.sshCommand`;
 *  - passes `--no-ext-diff --no-textconv` to every command that renders a
 *    diff, which is how an external diff driver or a textconv filter is
 *    refused. (`-c diff.external=` is *not* that: an empty value means "run
 *    the program named by the empty string", and git dies. It looked right
 *    and broke every diff, which is exactly why the tests run git.)
 *  - never takes `-c` from anywhere: the arguments here are structured, built
 *    from a zod enum and from strings this module composes, and there is no
 *    path by which a model supplies one;
 *  - refuses unless the workspace **is** the repository root, so a pathspec or
 *    an `add --all` cannot reach the owner's unrelated work in a parent repo;
 *  - scopes every pathspec to `-- .`.
 *
 * With `.git/` unwritable (`paths.ts`) and `commit` auto only in `run` mode
 * (`modes.ts`), that is the answer to "a commit is code execution".
 *
 * Aliases cannot reach `push` from here either: global and system config are
 * off, and a repository-local `[alias]` cannot rename a built-in — `git push`
 * is `push` whatever an alias says — while the subcommand itself comes from a
 * zod enum that has no `push` in it.
 */
import path from 'node:path';
import { childEnv, runArgv, type CommandResult } from './exec.js';
import { isInside, realpathish } from './paths.js';

export interface GitOptions {
  cwd: string;
  /** The absolute git binary from the workspace row. */
  gitPath?: string | undefined;
  /** The workspace's captured PATH, for the child environment. */
  toolchainPath?: string | undefined;
  /** An empty directory this plugin owns; `core.hooksPath` points at it. */
  hooksDir?: string | undefined;
  env?: NodeJS.ProcessEnv;
  signal?: AbortSignal;
  timeoutSeconds?: number;
}

/** The flags that refuse an external diff driver, on the commands that take them. */
export const NO_EXTERNAL_DIFF = ['--no-ext-diff', '--no-textconv'] as const;

/**
 * And for the commands that print a commit: never verify a signature.
 *
 * `log`/`show` run `gpg` — or whatever `gpg.program` names — to check one,
 * which is a program starting because a repository contained a signed commit.
 */
export const NO_SIGNATURE = ['--no-show-signature'] as const;

/**
 * The `-c` settings every invocation carries.
 *
 * `/usr/bin/false` where the setting names a *program*, never an empty
 * string: an empty value is a program called "", and git dies trying to run
 * it. `credential.helper=` is the exception and is correct — an empty value
 * there is git's own documented way to reset the helper list.
 */
export function hardeningArgs(hooksDir: string): string[] {
  return [
    '-c', `core.hooksPath=${hooksDir}`,
    '-c', 'core.fsmonitor=false',
    '-c', 'core.pager=cat',
    '-c', 'commit.gpgsign=false',
    '-c', 'gpg.program=/usr/bin/false',
    '-c', 'gpg.ssh.program=/usr/bin/false',
    '-c', 'gpg.format=openpgp',
    '-c', 'core.sshCommand=/usr/bin/false',
    '-c', 'credential.helper=',
    '-c', 'protocol.ext.allow=never',
  ];
}

/** The environment: the child allowlist, plus git's own "read nothing" switches. */
export function gitEnv(opts: GitOptions): NodeJS.ProcessEnv {
  return childEnv({
    toolchainPath: opts.toolchainPath ?? '',
    ...(opts.env ? { env: opts.env } : {}),
    extra: {
      GIT_CONFIG_NOSYSTEM: '1',
      GIT_CONFIG_GLOBAL: '/dev/null',
      GIT_TERMINAL_PROMPT: '0',
      GIT_ASKPASS: '/usr/bin/false',
      GIT_OPTIONAL_LOCKS: '0',
      GIT_PAGER: 'cat',
    },
  });
}

export async function git(args: readonly string[], opts: GitOptions): Promise<CommandResult> {
  const hooks = opts.hooksDir ?? '/dev/null';
  return runArgv({
    file: opts.gitPath && path.isAbsolute(opts.gitPath) ? opts.gitPath : 'git',
    args: [...hardeningArgs(hooks), ...args],
    cwd: opts.cwd,
    timeoutSeconds: opts.timeoutSeconds ?? 60,
    env: gitEnv(opts),
    ...(opts.signal ? { signal: opts.signal } : {}),
  });
}

/** stdout, trimmed, or a throw naming what git said. */
export async function gitOut(args: readonly string[], opts: GitOptions): Promise<string> {
  const result = await git(args, opts);
  if (result.exitCode !== 0) {
    throw new Error(`git ${args.join(' ')} failed: ${(result.stderr || result.stdout).trim()}`);
  }
  return result.stdout.trim();
}

export async function isRepository(opts: GitOptions): Promise<boolean> {
  const result = await git(['rev-parse', '--is-inside-work-tree'], opts);
  return result.exitCode === 0 && result.stdout.trim() === 'true';
}

/**
 * The repository this workspace *is*, or a refusal.
 *
 * "Is there a repository somewhere above me" is not the question. A workspace
 * that is a *subdirectory* of a repository would let `add --all` commit the
 * owner's unrelated work and a pathspec read a sibling project, so the only
 * repository this plugin works in is one whose root is the workspace itself.
 */
export async function requireRepositoryRoot(opts: GitOptions): Promise<string> {
  if (!(await isRepository(opts))) {
    throw new Error(`refused: ${opts.cwd} is not a git repository.`);
  }
  const top = await gitOut(['rev-parse', '--show-toplevel'], opts);
  const root = await realpathish(top);
  const workspace = await realpathish(opts.cwd);
  if (!(isInside(root, workspace) && isInside(workspace, root))) {
    throw new Error(
      `refused: the workspace ${workspace} is inside the repository ${root} but is not its root. ` +
        'A commit or a stash here would take work that is not yours; make the repository root the workspace.',
    );
  }
  return root;
}

export async function currentBranch(opts: GitOptions): Promise<string> {
  // `symbolic-ref` names the branch HEAD points at even before the first
  // commit, when `rev-parse HEAD` has no revision to resolve. A detached HEAD
  // has no symbolic ref, and there `rev-parse` answers as before.
  const symbolic = await git(['symbolic-ref', '--quiet', '--short', 'HEAD'], opts);
  if (symbolic.exitCode === 0 && symbolic.stdout.trim() !== '') return symbolic.stdout.trim();
  return gitOut(['rev-parse', '--abbrev-ref', 'HEAD'], opts);
}

/**
 * The branch this repository treats as its trunk.
 *
 * Used only to *refuse* a commit, so guessing wide is the safe direction: the
 * worst case is an agent told to make a branch it did not strictly need.
 */
export async function defaultBranch(opts: GitOptions): Promise<string> {
  const head = await git(['symbolic-ref', '--quiet', 'refs/remotes/origin/HEAD'], opts);
  if (head.exitCode === 0) {
    const name = head.stdout.trim().split('/').pop();
    if (name) return name;
  }
  for (const candidate of ['main', 'master']) {
    const exists = await git(['rev-parse', '--verify', '--quiet', candidate], opts);
    if (exists.exitCode === 0) return candidate;
  }
  // Neither exists yet (a new repository): the name `git init` would have used.
  const configured = await git(['config', '--get', 'init.defaultBranch'], opts);
  if (configured.exitCode === 0 && configured.stdout.trim() !== '') return configured.stdout.trim();
  return 'main';
}

/** The tree with nothing in it: diffing against it shows every file as added. */
export const EMPTY_TREE = '4b825dc642cb6eb9a060e54bf8d69288fbee4904';

/** Whether `ref` names a commit in this repository. */
export async function commitExists(ref: string, opts: GitOptions): Promise<boolean> {
  const result = await git(['rev-parse', '--verify', '--quiet', `${ref}^{commit}`], opts);
  return result.exitCode === 0;
}

/** `Add a test for the stale-balance flag` → `add-a-test-for-the-stale-balance-flag`. */
export function slugify(task: string): string {
  const slug = task
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 40)
    .replace(/-+$/, '');
  return slug === '' ? 'work' : slug;
}

/** §4: "The agent commits on a branch of its own (`buddi/<agent>/<task>`)". */
export function branchNameFor(agentId: string, task: string): string {
  return `buddi/${slugify(agentId)}/${slugify(task)}`;
}

export async function branchExists(name: string, opts: GitOptions): Promise<boolean> {
  const result = await git(['rev-parse', '--verify', '--quiet', `refs/heads/${name}`], opts);
  return result.exitCode === 0;
}

/**
 * Whether HEAD names a commit. False in a brand-new repository, right after
 * `git init`: HEAD points at a branch (main or master) that does not exist yet.
 */
export async function hasCommits(opts: GitOptions): Promise<boolean> {
  const head = await git(['rev-parse', '--verify', '--quiet', 'HEAD'], opts);
  return head.exitCode === 0;
}

/**
 * Put the work on the agent's own branch, creating it from where HEAD is.
 *
 * `switch -c` from HEAD and nothing else: creating a branch moves a ref and
 * leaves the working tree exactly as it was, so no checkout happens, no smudge
 * filter runs and nothing an agent has not committed can be lost. Switching to
 * a branch that already exists *is* a checkout, and is only ever to the
 * agent's own branch.
 */
export async function ensureBranch(
  name: string,
  opts: GitOptions,
): Promise<{ branch: string; created: boolean }> {
  const current = await currentBranch(opts);
  if (current === name) return { branch: name, created: false };
  if (await branchExists(name, opts)) {
    await gitOut(['switch', name], opts);
    return { branch: name, created: false };
  }
  if (!(await hasCommits(opts))) {
    // A new repository: there is no HEAD commit to cut from, so `switch
    // --create … HEAD` would fail. Point the unborn HEAD at the agent's branch
    // instead; the first commit creates it, and main/master is never made.
    await gitOut(['symbolic-ref', 'HEAD', `refs/heads/${name}`], opts);
    return { branch: name, created: true };
  }
  // From HEAD explicitly, so "where the branch starts" is not a function of
  // anything in the repository's configuration.
  await gitOut(['switch', '--create', name, 'HEAD'], opts);
  return { branch: name, created: true };
}

export interface CommitOutcome {
  branch: string;
  created: boolean;
  /** True when this was the repository's first commit, on a branch HEAD pointed at unborn. */
  firstCommit: boolean;
  commit: string;
  files: number;
  summary: string;
}

export async function commitOnOwnBranch(
  input: { agentId: string; task: string; message: string },
  opts: GitOptions,
): Promise<CommitOutcome> {
  await requireRepositoryRoot(opts);
  const target = branchNameFor(input.agentId, input.task);
  const status = await gitOut(['status', '--porcelain', '--', '.'], opts);
  if (status === '') {
    throw new Error('refused: nothing is staged or changed, so there is nothing to commit.');
  }
  const firstCommit = !(await hasCommits(opts));
  const { branch, created } = await ensureBranch(target, opts);
  await gitOut(['add', '--all', '--', '.'], opts);
  // `--no-verify` is the belt to the `core.hooksPath` brace.
  await gitOut(['commit', '--no-verify', '-m', input.message], opts);
  const commit = await gitOut(['rev-parse', '--short', 'HEAD'], opts);
  const summary = await gitOut(
    ['show', '--stat', '--oneline', '--no-color', ...NO_EXTERNAL_DIFF, ...NO_SIGNATURE, 'HEAD'],
    opts,
  );
  const files = (await gitOut(
    ['show', '--name-only', '--format=', ...NO_EXTERNAL_DIFF, ...NO_SIGNATURE, 'HEAD'],
    opts,
  ))
    .split('\n')
    .filter((line) => line.trim() !== '').length;
  return { branch, created, firstCommit, commit, files, summary };
}
