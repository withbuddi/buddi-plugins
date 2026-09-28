/**
 * `developer.git`: the six verbs, and nothing that could become a seventh.
 *
 * The action is a zod enum, so `push` is not a refusal the tool writes — it is
 * an argument that does not parse, refused by the registry before any code
 * here runs (`invalid-args`, docs/plugins.md §6). That is the strongest form
 * of "not offered at all".
 */
import path from 'node:path';
import { z } from 'zod';
import type { EffectDescription } from '@buddi/core/plugin';
import type { ToolDefinition } from '@buddi/core/plugin';
import { fenced } from '../fence.js';
import { NO_WORKSPACE_IS_AUTO, tierForGit, type TierFor } from '../modes.js';
import {
  isRefusal,
  requireAgent,
  requireWorkspace,
  workspaceOrNull,
  workspaceOrRefusal,
} from '../store.js';
import {
  branchNameFor,
  commitOnOwnBranch,
  currentBranch,
  defaultBranch,
  ensureBranch,
  git,
  gitOut,
  isRepository,
  requireRepositoryRoot,
  NO_EXTERNAL_DIFF,
  NO_SIGNATURE,
} from '../git.js';
import { gitOptionsFor } from '../runtime.js';
import { resolveInside } from '../paths.js';

const gitInput = z
  .object({
    action: z
      .enum(['status', 'diff', 'log', 'branch', 'commit', 'stash', 'init'])
      .describe(
        'status, diff, log, branch, commit, stash, or init to make the workspace a repository. ' +
          'Nothing else exists here.',
      ),
    task: z
      .string()
      .max(120)
      .optional()
      .describe('What this piece of work is, for the branch name buddi/<you>/<task>.'),
    message: z.string().max(2000).optional().describe('The commit message, for commit.'),
    path: z.string().max(4096).optional().describe('Limit a diff or a log to one path.'),
    limit: z.number().int().min(1).max(100).optional().describe('How many commits, for log.'),
    stash: z
      .enum(['push', 'list'])
      .optional()
      .describe('For stash: push (the default) puts the changes aside, list says what is there.'),
  })
  .describe('One git action inside your workspace.');

type GitInput = z.infer<typeof gitInput>;

/** `branch` with a task is a create; without one it is a list, which is a read. */
function effectiveAction(input: GitInput): string {
  if (input.action === 'branch' && (input.task === undefined || input.task.trim() === '')) {
    return 'branch_list';
  }
  return input.action;
}

export const gitTool: ToolDefinition<GitInput, unknown> = {
  name: 'developer.git',
  description:
    'Git inside your workspace: status, diff, log, branch, commit, stash, and init for a ' +
    'directory that is not a repository yet. Reads are free. A ' +
    'commit goes on a branch of your own, buddi/<you>/<task>, never on the repository default ' +
    'branch. There is no push, no reset, no checkout of somebody else\'s branch and nothing ' +
    'that rewrites history — they do not exist here, and a stash can be made or listed but never ' +
    'brought back, because that is a merge and a merge runs the repository\'s own drivers.',
  tier: 'session',
  input: gitInput,
  async tierFor(input, ctx): Promise<TierFor> {
    const workspace = await workspaceOrNull(ctx);
    if (workspace === undefined) return NO_WORKSPACE_IS_AUTO;
    return tierForGit(workspace.mode, effectiveAction(input));
  },
  async describe(input, ctx): Promise<EffectDescription> {
    const workspace = await requireWorkspace(ctx);
    const agentId = requireAgent(ctx);
    const opts = gitOptionsFor(workspace);
    const action = effectiveAction(input);
    if (action === 'commit') {
      const status = await gitOut(['status', '--porcelain'], opts);
      const branch = branchNameFor(agentId, input.task ?? input.message ?? 'work');
      const files = status.split('\n').filter((line) => line.trim() !== '');
      return {
        envelope: {
          tool: 'developer.git',
          action: 'commit',
          workspace: workspace.dir,
          branch,
          message: input.message ?? '',
          files: files.map((line) => line.slice(3)),
        },
        preview:
          `Commit ${files.length} file${files.length === 1 ? '' : 's'} on ${branch} in ${workspace.dir}` +
          `, with the message "${(input.message ?? '').slice(0, 120)}".`,
      };
    }
    const branch = branchNameFor(agentId, input.task ?? 'work');
    return {
      envelope: { tool: 'developer.git', action, workspace: workspace.dir, branch },
      preview:
        action === 'branch'
          ? `Create the branch ${branch} in ${workspace.dir} and switch to it.`
          : action === 'init'
            ? `Make ${workspace.dir} a git repository.`
            : `Run git ${action} in ${workspace.dir}.`,
    };
  },
  async execute(input, ctx) {
    const found = await workspaceOrRefusal(ctx);
    if (isRefusal(found)) return found;
    const workspace = found;
    const agentId = requireAgent(ctx);
    const opts = gitOptionsFor(workspace, { ...(ctx.signal ? { signal: ctx.signal } : {}) });
    if (input.action === 'init') {
      // A workspace already inside a repository — its own or a parent's — is
      // not made a second one: a nested repository is exactly the "somewhere
      // above me" confusion the root check below refuses.
      if (await isRepository(opts)) {
        throw new Error(`refused: ${workspace.dir} is already inside a git repository.`);
      }
      const result = await git(['init', '--quiet'], opts);
      if (result.exitCode !== 0) {
        throw new Error(`git init failed: ${(result.stderr || result.stdout).trim()}`);
      }
      return {
        path: workspace.dir,
        branch: await currentBranch(opts),
        note: `Initialised a repository in ${workspace.dir}.`,
      };
    }
    // Not "a repository somewhere above me": *this* directory must be the
    // repository root, or a pathspec and an `add --all` reach work that is
    // not this agent's.
    await requireRepositoryRoot(opts);
    // A pathspec is a path like any other, and goes through the boundary.
    const pathspec =
      input.path === undefined
        ? undefined
        : path.relative(
            workspace.dir,
            await resolveInside(workspace.dir, input.path, {
              allowRoot: true,
              toolchainPath: workspace.toolchainPath,
            }),
          ) || '.';
    const branch = await currentBranch(opts);
    const trunk = await defaultBranch(opts);

    switch (input.action) {
      case 'status': {
        const text = await gitOut(['status', '--short', '--branch', '--', '.'], opts);
        return { path: workspace.dir, branch, defaultBranch: trunk, ...fenced(text || '(clean)') };
      }
      case 'diff': {
        const text = await gitOut(
          ['diff', '--no-color', ...NO_EXTERNAL_DIFF, '--', pathspec ?? '.'],
          opts,
        );
        return { path: pathspec ?? '.', branch, ...fenced(text || '(no changes)') };
      }
      case 'log': {
        const text = await gitOut(
          [
            'log',
            '--no-color',
            `--max-count=${input.limit ?? 20}`,
            '--pretty=format:%h %ad %an %s',
            '--date=short',
            ...NO_EXTERNAL_DIFF,
            ...NO_SIGNATURE,
            '--',
            pathspec ?? '.',
          ],
          opts,
        );
        return { path: pathspec ?? '.', branch, ...fenced(text || '(no commits)') };
      }
      case 'branch': {
        if (input.task === undefined || input.task.trim() === '') {
          const text = await gitOut(['branch', '--list', '--no-color'], opts);
          return { path: workspace.dir, branch, defaultBranch: trunk, ...fenced(text) };
        }
        const target = branchNameFor(agentId, input.task);
        const outcome = await ensureBranch(target, opts);
        return {
          path: workspace.dir,
          branch: outcome.branch,
          created: outcome.created,
          from: branch,
          note: `${outcome.created ? 'Created' : 'Switched to'} ${outcome.branch}.`,
        };
      }
      case 'commit': {
        const message = input.message?.trim();
        if (!message) throw new Error('refused: a commit needs a message.');
        if (branch === trunk && (input.task === undefined || input.task.trim() === '')) {
          throw new Error(
            `refused: you are on ${trunk}, the repository's default branch, and a developer agent never commits on it. ` +
              'Give a task so the work goes on buddi/<you>/<task>.',
          );
        }
        const outcome = await commitOnOwnBranch(
          { agentId, task: input.task ?? message, message },
          opts,
        );
        return {
          path: workspace.dir,
          branch: outcome.branch,
          created: outcome.created,
          commit: outcome.commit,
          files: outcome.files,
          note: `Committed ${outcome.commit} on ${outcome.branch} (${outcome.files} file${outcome.files === 1 ? '' : 's'}).`,
          ...fenced(outcome.summary),
        };
      }
      case 'stash': {
        // `push` and `list` only. `pop` and `apply` *merge*, and a merge
        // runs a repository's own merge drivers — which is code, with no
        // card. Bringing a stash back is the owner's, outside buddi.
        const result =
          input.stash === 'list'
            ? await git(['stash', 'list', '--no-color'], opts)
            : await git(
                ['stash', 'push', '--include-untracked', '-m', input.message ?? 'buddi', '--', '.'],
                opts,
              );
        if (result.exitCode !== 0) {
          throw new Error(`git stash failed: ${(result.stderr || result.stdout).trim()}`);
        }
        return {
          path: workspace.dir,
          branch,
          action: input.stash ?? 'push',
          ...fenced(result.stdout.trim() || '(nothing to stash)'),
        };
      }
      default: {
        // Unreachable: the enum is the whole of what exists.
        throw new Error(`developer.git: unknown action.`);
      }
    }
  },
};
