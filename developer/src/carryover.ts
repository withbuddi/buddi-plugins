/**
 * The developer's lines in the note a rolled-over chat opens with.
 *
 * When a Developer conversation ends — idle, or grown too long — the next one
 * starts with a short note core writes from the old transcript. These are the
 * facts the transcript cannot be trusted to hold: which workspace, which
 * branch, the last commit, and what is uncommitted. Read from git at the
 * moment of the rollover, with the same hardened git every other tool uses,
 * and nothing but names: no file contents, no diff.
 *
 * Core bounds this (time, line count, width, secrets) and leaves it out on a
 * throw; an agent with no workspace contributes nothing.
 */
import type { CarryOverContributor, ToolContext } from '@buddi/core/plugin';
import { currentBranch, git, isRepository, NO_SIGNATURE } from './git.js';
import { gitOptionsFor } from './runtime.js';
import { workspaceOrNull } from './store.js';

/** Changed paths named in the note; the rest are counted. */
export const CARRY_OVER_PATHS = 5;

/** The lines, from the agent's workspace as it stands now. */
export async function carryOverLines(ctx: ToolContext): Promise<string[]> {
  const workspace = await workspaceOrNull(ctx);
  if (!workspace) return [];
  const lines = [`Workspace: ${workspace.dir} (${workspace.mode} mode)`];
  const opts = { ...gitOptionsFor(workspace), timeoutSeconds: 5 };
  if (!(await isRepository(opts))) {
    lines.push('Not a git repository.');
    return lines;
  }
  lines.push(`Branch: ${await currentBranch(opts)}`);
  const last = await git(['log', '-1', '--no-color', '--pretty=format:%h %s', ...NO_SIGNATURE], opts);
  lines.push(last.exitCode === 0 && last.stdout.trim() !== '' ? `Last commit: ${last.stdout.trim()}` : 'No commits yet.');
  const status = await git(['status', '--porcelain', '--untracked-files=normal', '--', '.'], opts);
  if (status.exitCode === 0) {
    const changed = status.stdout.split('\n').map((line) => line.slice(3).trim()).filter(Boolean);
    if (changed.length === 0) {
      lines.push('Working tree clean.');
    } else {
      const named = changed.slice(0, CARRY_OVER_PATHS).join(', ');
      const more = changed.length > CARRY_OVER_PATHS ? ` and ${changed.length - CARRY_OVER_PATHS} more` : '';
      lines.push(`Uncommitted: ${changed.length} file${changed.length === 1 ? '' : 's'} (${named}${more})`);
    }
  }
  return lines;
}

export const developerCarryOver: CarryOverContributor = {
  lines: (_request, ctx) => carryOverLines(ctx),
};
