/**
 * The workspace itself, and the three things only the owner may change.
 *
 * `developer.workspace` is the one gated tool a *model* can reach: it is the
 * grant, and §2 says the card names the directory and what it contains. The
 * other three are `ownerOnly` — the Settings page's select, its button and its
 * toggle — and are never listed to any model (`ToolRegistry.list` leaves them
 * out, and `invoke` refuses them for anybody but the owner's own path).
 */
import { lstat, mkdir, readdir, realpath, stat } from 'node:fs/promises';
import path from 'node:path';
import type { EffectDescription, ToolContext } from '@buddi/core/plugin';
import { z } from 'zod';
import type { ToolDefinition } from '@buddi/core/plugin';
import { PathRefused, denyList, isInside, realpathish, resolveWorkspaceDir } from '../paths.js';
import { git, isRepository } from '../git.js';
import { captureToolchainPath, resolveProgram } from '../exec.js';
import { ensureHooksDir, hooksDir } from '../runtime.js';
import { stopAllFor, stopEverything } from '../processes.js';
import { forgetTestRuns } from '../summarise.js';
import {
  MODES,
  forgetAllowedCommand,
  getSettings,
  getWorkspace,
  listAllowedCommands,
  listProcesses,
  listWorkspaces,
  requireAgent,
  setMode,
  setSettings,
  setWorkspaceDir,
  type Mode,
} from '../store.js';

const workspaceInput = z.object({
  dir: z
    .string()
    .min(1)
    .max(4096)
    .describe('The absolute path of the directory to work in, on the machine buddi runs on.'),
  create: z
    .boolean()
    .optional()
    .describe(
      'true to start a new project: if the directory does not exist yet, the owner approves creating ' +
        'it (empty, the last folder only; its parent must exist). An existing directory is used as it is.',
    ),
});

/** A folder name the create path accepts: a plain name, not hidden, not a path. */
const FOLDER_NAME = /^[\p{L}\p{N}_][\p{L}\p{N}._ -]*$/u;
const FOLDER_NAME_MAX = 100;

/** What the card says the new folder will be. Read-only; throws on a refusal. */
export interface NewFolderPlan {
  dir: string;
  parent: string;
  name: string;
}

/**
 * The create path's checks, run at describe time and again just before the
 * `mkdir`.
 *
 * Only the last segment is ever created: the parent must already exist and be
 * a directory, and its realpath is what the new folder is placed under, so a
 * symlinked parent is followed once, here, and the target the owner sees is
 * the real one. That target then goes through `resolveWorkspaceDir` — the
 * same deny list, protected paths, home and root checks an existing workspace
 * gets — and must not exist yet.
 *
 * The name is a plain folder name: no `.` or `..` segment anywhere in the
 * path, no leading dot (a project is not a hidden folder, and every dotfolder
 * worth refusing — `.ssh`, `.config`, `.git` — starts with one), and at most
 * 100 characters.
 */
export async function planNewFolder(dir: string, protectedPaths?: readonly string[]): Promise<NewFolderPlan> {
  if (!path.isAbsolute(dir)) {
    throw new PathRefused(
      `refused: ${dir} is not an absolute path. A workspace is one absolute directory on this machine.`,
      'absolute',
    );
  }
  const segments = dir.split('/').filter((part) => part !== '');
  if (segments.some((part) => part === '.' || part === '..') || dir.includes('\\')) {
    throw new PathRefused(
      `refused: ${dir} contains "." or ".." or a backslash. Name the new folder by its plain absolute path.`,
      'dotdot',
    );
  }
  const name = segments.at(-1) ?? '';
  if (name === '' || name.length > FOLDER_NAME_MAX || !FOLDER_NAME.test(name) || name.trim() !== name) {
    throw new PathRefused(
      `refused: "${name}" is not a folder name a new project can have. Use letters, digits, ` +
        `"-", "_", "." or spaces, not starting with a dot, at most ${FOLDER_NAME_MAX} characters.`,
      'outside',
    );
  }
  const rawParent = path.dirname(path.resolve(dir));
  const parentInfo = await stat(rawParent).catch(() => undefined);
  if (parentInfo === undefined) {
    throw new PathRefused(
      `refused: ${rawParent} does not exist. Only the last folder is created; its parent must already be there.`,
      'outside',
    );
  }
  if (!parentInfo.isDirectory()) {
    throw new PathRefused(`refused: ${rawParent} is not a directory.`, 'outside');
  }
  const parent = await realpath(rawParent);
  const target = path.join(parent, name);
  const resolved = await resolveWorkspaceDir(target, { protectedPaths });
  if (resolved !== target) {
    throw new PathRefused(`refused: ${target} resolves to ${resolved}; name the folder by its real path.`, 'symlink');
  }
  if ((await lstat(target).catch(() => undefined)) !== undefined) {
    throw new PathRefused(
      `refused: ${target} already exists, and the owner approved a new, empty folder. ` +
        'Call developer.workspace again so they see what is in it.',
      'outside',
    );
  }
  return { dir: target, parent, name };
}

/** Does anything — a directory, a file, a dangling link — answer to this path? */
async function exists(dir: string): Promise<boolean> {
  return (await lstat(path.resolve(dir)).catch(() => undefined)) !== undefined;
}

/**
 * What the card says the directory is. Read-only, and it throws on a refusal.
 *
 * It also captures, and therefore *shows*, the two things every later command
 * depends on: the PATH the owner's login shell reports, and the git binary on
 * it. They are read here, once, because after this there is no shell — the
 * owner is approving a toolchain as much as a directory.
 */
export async function describeDirectory(dir: string, protectedPaths?: readonly string[]): Promise<{
  dir: string;
  entries: string[];
  gitRemote: string | null;
  isRepo: boolean;
  toolchainPath: string;
  gitPath: string;
}> {
  // `resolveWorkspaceDir` throws `PathRefused` for `~/.ssh`, `~/.buddi`,
  // buddi's data directory and the vault — which is exactly the "describe
  // throws" case: there is no card to show, because there is nothing to
  // approve.
  const resolved = await resolveWorkspaceDir(dir, { protectedPaths });
  const info = await stat(resolved).catch(() => undefined);
  if (info === undefined) {
    throw new PathRefused(
      `refused: ${resolved} does not exist. To start a new project there, call developer.workspace again ` +
        'with create: true; the owner approves the new folder.',
      'outside',
    );
  }
  if (!info.isDirectory()) {
    throw new PathRefused(`refused: ${resolved} is not a directory.`, 'outside');
  }
  const entries = (await readdir(resolved, { withFileTypes: true }))
    .sort((a, b) => a.name.localeCompare(b.name))
    .slice(0, 40)
    .map((entry) => (entry.isDirectory() ? `${entry.name}/` : entry.name));
  const toolchainPath = await captureToolchainPath();
  const gitPath = (await resolveProgram('git', toolchainPath)) ?? '';
  const opts = {
    cwd: resolved,
    gitPath,
    toolchainPath,
    hooksDir: hooksDir(),
  };
  const isRepo = await isRepository(opts);
  let gitRemote: string | null = null;
  if (isRepo) {
    const remote = await git(['remote', 'get-url', 'origin'], opts);
    gitRemote = remote.exitCode === 0 ? remote.stdout.trim() : null;
  }
  return { dir: resolved, entries, gitRemote, isRepo, toolchainPath, gitPath };
}

export const workspaceTool: ToolDefinition<z.infer<typeof workspaceInput>, unknown> = {
  name: 'developer.workspace',
  description:
    'Set or change the directory you work in. Everything else you can do happens inside it, so ' +
    'this is the one thing the owner grants: they see the directory and what is in it before ' +
    'saying yes. Changing it stops every process you started. To start a new project in a folder ' +
    'that does not exist yet, pass create: true and the owner approves creating it, empty.',
  tier: 'gated',
  input: workspaceInput,
  async describe(input, ctx): Promise<EffectDescription> {
    if (input.create === true && !(await exists(input.dir))) {
      const plan = await planNewFolder(input.dir, ctx.buddi!.owner.protectedPaths);
      const toolchainPath = await captureToolchainPath();
      const gitPath = (await resolveProgram('git', toolchainPath)) ?? '';
      const agentId = requireAgent(ctx);
      const mode = (await getWorkspace(ctx.buddi!.db, agentId))?.mode ?? 'run';
      return {
        envelope: {
          tool: 'developer.workspace',
          dir: plan.dir,
          parent: plan.parent,
          create: true,
          entries: [],
          gitRemote: null,
          isRepo: false,
          toolchainPath,
          gitPath,
        },
        preview:
          `Create a new, empty folder ${plan.name} in ${plan.parent} and work there in ${mode} mode. ` +
          `This agent will read, edit and run code in ${plan.dir}.\n` +
          `Commands there run with this PATH and no shell: ${toolchainPath}\n` +
          `git is ${gitPath || '(not on that PATH; git actions will be refused)'}.\n` +
          'In run mode a short list of programs runs without asking you — including this project\'s ' +
          'own scripts (npm test, make), which run as you.',
      };
    }
    const summary = await describeDirectory(input.dir, ctx.buddi!.owner.protectedPaths);
    const contents = summary.entries.length === 0 ? '(empty)' : summary.entries.join(', ');
    return {
      envelope: {
        tool: 'developer.workspace',
        dir: summary.dir,
        entries: summary.entries,
        gitRemote: summary.gitRemote,
        isRepo: summary.isRepo,
        toolchainPath: summary.toolchainPath,
        gitPath: summary.gitPath,
      },
      preview:
        `Let this agent read, edit and run code in ${summary.dir}. ` +
        (summary.isRepo
          ? `It is a git repository${summary.gitRemote ? ` whose origin is ${summary.gitRemote}` : ' with no remote'}. `
          : 'It is not a git repository. ') +
        `It contains: ${contents}.\n` +
        `Commands there run with this PATH and no shell: ${summary.toolchainPath}\n` +
        `git is ${summary.gitPath || '(not on that PATH; git actions will be refused)'}.\n` +
        'In run mode a short list of programs runs without asking you — including this project\'s ' +
        'own scripts (npm test, make), which run as you.',
    };
  },
  async execute(input, ctx) {
    const actionId = ctx.actionId?.trim();
    if (!actionId) {
      throw new Error('developer.workspace: no approved action id in the tool context; refusing.');
    }
    const agentId = requireAgent(ctx);
    const protectedPaths = ctx.buddi!.owner.protectedPaths;
    // What the owner approved decides whether a folder is made, not what is
    // on disk now: a card that said "new, empty folder" never adopts one that
    // appeared since, and a card that showed a directory never creates one.
    // Without an approved effect (a direct call), the disk decides.
    const approved = ctx.approvedEffect?.envelope as { create?: unknown; dir?: unknown } | undefined;
    const createNew =
      input.create === true && (approved !== undefined ? approved.create === true : !(await exists(input.dir)));
    let target = input.dir;
    if (createNew) {
      const plan = await planNewFolder(input.dir, protectedPaths);
      if (approved !== undefined && approved.dir !== plan.dir) {
        throw new PathRefused(
          `refused: the new folder now resolves to ${plan.dir}, not the ${String(approved.dir)} the owner approved.`,
          'outside',
        );
      }
      try {
        await mkdir(plan.dir, { mode: 0o755 });
      } catch (err) {
        if ((err as NodeJS.ErrnoException).code === 'EEXIST') {
          throw new PathRefused(
            `refused: ${plan.dir} appeared after the owner approved a new, empty folder. ` +
              'Call developer.workspace again so they see what is in it.',
            'outside',
          );
        }
        throw err;
      }
      const made = await lstat(plan.dir);
      if (!made.isDirectory() || (await realpath(plan.dir)) !== plan.dir) {
        throw new PathRefused(`refused: ${plan.dir} is not the folder that was just created.`, 'symlink');
      }
      target = plan.dir;
    }
    const summary = await describeDirectory(target, protectedPaths);
    const previous = await getWorkspace(ctx.buddi!.db, agentId);
    // §4: processes are "killed when the workspace changes". A dev server for
    // the old directory is a process about nothing.
    const stopped =
      previous && previous.dir !== summary.dir
        ? await stopAllFor(ctx, agentId, { toolchainPath: previous.toolchainPath })
        : [];
    if (previous && previous.dir !== summary.dir) forgetTestRuns(agentId);
    // The empty directory `core.hooksPath` points at, made before the first
    // git call rather than lazily inside one.
    await ensureHooksDir();
    const workspace = await setWorkspaceDir(ctx.buddi!.db, agentId, summary.dir, ctx.buddi!.clock.now(), {
      toolchainPath: summary.toolchainPath,
      gitPath: summary.gitPath,
    });
    return {
      workspace: { dir: workspace.dir, mode: workspace.mode },
      toolchainPath: workspace.toolchainPath,
      gitPath: workspace.gitPath,
      previousDir: previous?.dir ?? null,
      stoppedProcesses: stopped.map((row) => row.name),
      isRepo: summary.isRepo,
      gitRemote: summary.gitRemote,
      note: `Working in ${workspace.dir}, in ${workspace.mode} mode.`,
    };
  },
};

/* ------------------------------------------------------------------ *
 * Owner-only: the Settings page's three writes
 * ------------------------------------------------------------------ */

const setModeInput = z.object({
  agent: z.string().min(1).max(64).describe('The agent whose workspace this is.'),
  mode: z.enum(['ask', 'edit', 'run']).describe('ask, edit or run.'),
});

/**
 * The mode, set by the owner on the Settings page.
 *
 * §3: "a per-agent setting, changed by the owner on the agent's page, never by
 * the agent". `ownerOnly` is the enforcement, not the comment: no model is
 * ever shown this tool, and `registry.invoke` refuses it for any agent id but
 * the owner's own.
 */
export const setModeTool: ToolDefinition<z.infer<typeof setModeInput>, unknown> = {
  name: 'developer.set_mode',
  description: "Set an agent's workspace mode. The owner's own, from the Developer settings page.",
  tier: 'auto',
  ownerOnly: true,
  input: setModeInput,
  async execute(input, ctx) {
    const workspace = await setMode(ctx.buddi!.db, input.agent, input.mode as Mode, ctx.buddi!.clock.now());
    return {
      agent: workspace.agentId,
      mode: workspace.mode,
      note: `${workspace.agentId} is now in ${workspace.mode} mode in ${workspace.dir}.`,
    };
  },
};

export const stopAllTool: ToolDefinition<Record<string, never>, unknown> = {
  name: 'developer.stop_all',
  description: 'Stop every process every developer agent started. The owner\'s own.',
  tier: 'auto',
  ownerOnly: true,
  input: z.object({}).strict(),
  async execute(_input, ctx) {
    const stopped = await stopEverything(ctx);
    return {
      stopped: stopped.map((row) => `${row.agentId}/${row.name}`),
      note:
        stopped.length === 0
          ? 'Nothing was running.'
          : `Stopped ${stopped.length} process${stopped.length === 1 ? '' : 'es'}.`,
    };
  },
};

const forgetInput = z.object({
  id: z.coerce.number().int().positive().describe('The standing allow to remove.'),
});

/** Revoke one "always" the owner said on a card. The owner's own. */
export const forgetCommandTool: ToolDefinition<z.infer<typeof forgetInput>, unknown> = {
  name: 'developer.forget_command',
  description: "Forget a command you allowed for good. The owner's own, from the Developer settings page.",
  tier: 'auto',
  ownerOnly: true,
  input: forgetInput,
  async execute(input, ctx) {
    const removed = await forgetAllowedCommand(ctx.buddi!.db, input.id);
    return {
      id: input.id,
      removed,
      note: removed ? 'Forgotten. The next such command is a card again.' : 'There was nothing to forget.',
    };
  },
};

const settingsInput = z.object({
  tailscaleRoutes: z
    .enum(['true', 'false'])
    .describe('Whether a started process gets a tailnet route on its port.'),
});

export const setSettingsTool: ToolDefinition<z.infer<typeof settingsInput>, unknown> = {
  name: 'developer.set_settings',
  description: "The Developer settings. The owner's own.",
  tier: 'auto',
  ownerOnly: true,
  input: settingsInput,
  async execute(input, ctx) {
    const settings = await setSettings(
      ctx.buddi!.db,
      { tailscaleRoutes: input.tailscaleRoutes === 'true' },
      ctx.buddi!.clock.now(),
    );
    return {
      ...settings,
      note: settings.tailscaleRoutes
        ? 'New processes will get a tailnet route on their port.'
        : 'Tailnet routes are off. Previews stay behind the dashboard.',
    };
  },
};

/* ------------------------------------------------------------------ *
 * The page's reads
 * ------------------------------------------------------------------ */

/** Every workspace, with its mode and how many processes it is running. */
export async function workspaceRows(ctx: ToolContext): Promise<{
  workspaces: Array<{
    agent: string;
    dir: string;
    mode: Mode;
    processes: number;
    toolchainPath: string;
    inDataDir: boolean;
  }>;
  tailscaleRoutes: string;
}> {
  const [workspaces, processes, settings] = await Promise.all([
    listWorkspaces(ctx.buddi!.db),
    listProcesses(ctx.buddi!.db),
    getSettings(ctx.buddi!.db),
  ]);
  const denied = await Promise.all(denyList().map((dir) => realpathish(dir)));
  const rows = await Promise.all(
    workspaces.map(async (workspace) => {
      const resolved = await realpathish(workspace.dir);
      return {
        agent: workspace.agentId,
        dir: workspace.dir,
        mode: workspace.mode,
        processes: processes.filter((row) => row.agentId === workspace.agentId).length,
        toolchainPath: workspace.toolchainPath,
        // Shown on the page, so a workspace that became a refused path after
        // it was granted — the owner moved their data directory — is visible
        // rather than only failing at the next tool call.
        inDataDir: denied.some((dir) => isInside(dir, resolved)),
      };
    }),
  );
  return { workspaces: rows, tailscaleRoutes: String(settings.tailscaleRoutes) };
}

/** Every standing allow, for the page. */
export async function allowedCommandRows(ctx: ToolContext): Promise<{
  allowed: Array<{ id: number; agent: string; dir: string; command: string; scope: string; since: string }>;
  count: number;
}> {
  const rows = await listAllowedCommands(ctx.buddi!.db);
  return {
    allowed: rows.map((row) => ({
      id: row.id,
      agent: row.agentId,
      dir: row.dir,
      command: row.prefix ? `${row.argv.join(' ')} …` : row.argv.join(' '),
      scope: row.prefix ? 'any command starting so' : 'exactly this',
      since: row.createdAt.toISOString(),
    })),
    count: rows.length,
  };
}

/** Every running process, for the page. */
export async function processRows(ctx: ToolContext): Promise<{
  processes: Array<{ agent: string; name: string; pid: number; command: string; port: number | null; log: string }>;
  count: number;
}> {
  const rows = await listProcesses(ctx.buddi!.db);
  return {
    processes: rows.map((row) => ({
      agent: row.agentId,
      name: row.name,
      pid: row.pid,
      command: row.command,
      port: row.port,
      log: path.basename(row.logPath),
    })),
    count: rows.length,
  };
}

export const MODE_OPTIONS = MODES.map((mode) => ({ value: mode, label: mode }));
