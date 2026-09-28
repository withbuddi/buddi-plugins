/**
 * Everything this plugin keeps: the workspace an agent works in, the mode the
 * owner chose for it, the processes it started, and the one settings row.
 *
 * Every read takes the `ToolContext` rather than a pool, because the agent id
 * is half of every key here and a tool that guessed it would be a tool that
 * read somebody else's workspace. `requireAgent` is where that fails closed.
 */
import type { DbArea, ToolContext } from '@buddi/core/plugin';

export type Mode = 'ask' | 'edit' | 'run';

export const MODES: readonly Mode[] = ['ask', 'edit', 'run'];

export interface Workspace {
  agentId: string;
  dir: string;
  mode: Mode;
  /**
   * The owner's own PATH, captured once at `developer.workspace` time and
   * shown on that approval card. Every command runs with this and no shell.
   */
  toolchainPath: string;
  /** The absolute git binary resolved from that PATH at the same moment. */
  gitPath: string;
  createdAt: string;
  updatedAt: string;
}

export interface ProcessRow {
  agentId: string;
  name: string;
  pid: number;
  command: string;
  startedAt: string;
  /**
   * What `ps -o lstart=` said when this pid was started. A pid is not an
   * identity — after a reboot a recycled one reads as alive — and this is the
   * other half of it, checked before anything is signalled.
   */
  startedAtNative: string;
  port: number | null;
  logPath: string;
}

export interface Settings {
  tailscaleRoutes: boolean;
}

type Db = Pick<DbArea, 'query'>;

/**
 * The agent this call is for.
 *
 * `ctx.agentId` is optional in the contract and the loop fills it in for every
 * call it makes. Absent, something is calling a workspace tool from outside a
 * run: refuse rather than fall back to a shared workspace, which is the
 * "the agent id is missing so this must be shared" failure docs/plugins.md §6
 * names by hand.
 */
export function requireAgent(ctx: ToolContext): string {
  const agentId = ctx.agentId?.trim();
  if (!agentId) {
    throw new Error(
      'developer: no agent id in the tool context; a workspace belongs to one agent and this call has none.',
    );
  }
  return agentId;
}

function toWorkspace(row: {
  agent_id: string;
  dir: string;
  mode: string;
  toolchain_path: string;
  git_path: string;
  created_at: Date;
  updated_at: Date;
}): Workspace {
  return {
    agentId: row.agent_id,
    dir: row.dir,
    mode: row.mode as Mode,
    toolchainPath: row.toolchain_path,
    gitPath: row.git_path,
    createdAt: row.created_at.toISOString(),
    updatedAt: row.updated_at.toISOString(),
  };
}

const WORKSPACE_COLUMNS =
  'agent_id, dir, mode, toolchain_path, git_path, created_at, updated_at';

export async function getWorkspace(db: Db, agentId: string): Promise<Workspace | undefined> {
  const { rows } = await db.query(
    `select ${WORKSPACE_COLUMNS} from developer.workspaces where agent_id = $1`,
    [agentId],
  );
  const row = rows[0] as Parameters<typeof toWorkspace>[0] | undefined;
  return row ? toWorkspace(row) : undefined;
}

/**
 * "You have no workspace yet", as a **result** rather than an exception.
 *
 * Having no workspace is the expected first state of every developer agent,
 * and the first thing a new one does is find out. A throw makes that a red
 * tool failure in the transcript — the shape reserved for something going
 * wrong — when what happened is an ordinary answer to an ordinary question.
 * So it is a refusal object: `ok: false` and one sentence saying what to do.
 */
export interface Refusal {
  ok: false;
  refusal: string;
}

export function isRefusal(value: unknown): value is Refusal {
  return typeof value === 'object' && value !== null && 'refusal' in value;
}

export function noWorkspace(agentId: string): Refusal {
  return {
    ok: false,
    refusal:
      `${agentId} has no workspace yet, so there is nothing to read, edit or run in. Ask the owner ` +
      'to grant one with developer.workspace, naming the directory; these tools do nothing outside ' +
      'a directory they were given.',
  };
}

/**
 * The workspace, or the refusal above.
 *
 * Every file and command tool starts here, so "you have no workspace" is one
 * sentence written once, and it says what the owner has to do rather than
 * what the query returned.
 */
export async function workspaceOrRefusal(ctx: ToolContext): Promise<Workspace | Refusal> {
  const agentId = requireAgent(ctx);
  const workspace = await getWorkspace(ctx.buddi!.db, agentId);
  return workspace ?? noWorkspace(agentId);
}

/**
 * The workspace, or a throw.
 *
 * Kept for the places where absence really is a defect — `tierFor` reads it
 * through `workspaceOrNull` instead, and every `execute` returns the refusal.
 */
export async function requireWorkspace(ctx: ToolContext): Promise<Workspace> {
  const found = await workspaceOrRefusal(ctx);
  if (isRefusal(found)) throw new Error(`developer: ${found.refusal}`);
  return found;
}

/** The workspace, or nothing: what `tierFor` asks, because it may not throw. */
export async function workspaceOrNull(ctx: ToolContext): Promise<Workspace | undefined> {
  const agentId = ctx.agentId?.trim();
  if (!agentId) return undefined;
  return getWorkspace(ctx.buddi!.db, agentId);
}

export async function listWorkspaces(db: Db): Promise<Workspace[]> {
  const { rows } = await db.query(
    `select ${WORKSPACE_COLUMNS} from developer.workspaces order by agent_id`,
  );
  return (rows as Array<Parameters<typeof toWorkspace>[0]>).map(toWorkspace);
}

export async function setWorkspaceDir(
  db: Db,
  agentId: string,
  dir: string,
  now: Date,
  toolchain: { toolchainPath: string; gitPath: string } = { toolchainPath: '', gitPath: '' },
): Promise<Workspace> {
  const { rows } = await db.query(
    `insert into developer.workspaces (agent_id, dir, toolchain_path, git_path, created_at, updated_at)
       values ($1, $2, $4, $5, $3, $3)
     on conflict (agent_id) do update set dir = excluded.dir, toolchain_path = excluded.toolchain_path,
       git_path = excluded.git_path, updated_at = excluded.updated_at
     returning ${WORKSPACE_COLUMNS}`,
    [agentId, dir, now, toolchain.toolchainPath, toolchain.gitPath],
  );
  return toWorkspace(rows[0] as Parameters<typeof toWorkspace>[0]);
}

/**
 * The mode, set by the owner and by nobody else.
 *
 * The check constraint in the migration is the second half of the enum in
 * `MODES`: a mode this code does not know can never be in the table, so
 * reading one back and switching on it is total.
 */
export async function setMode(db: Db, agentId: string, mode: Mode, now: Date): Promise<Workspace> {
  const { rows } = await db.query(
    `update developer.workspaces set mode = $2, updated_at = $3 where agent_id = $1
     returning ${WORKSPACE_COLUMNS}`,
    [agentId, mode, now],
  );
  const row = rows[0] as Parameters<typeof toWorkspace>[0] | undefined;
  if (!row) throw new Error(`developer: ${agentId} has no workspace, so it has no mode to set.`);
  return toWorkspace(row);
}

/* ------------------------------------------------------------------ *
 * Commands the owner allowed for good
 * ------------------------------------------------------------------ */

export interface AllowedCommand {
  id: number;
  agentId: string;
  dir: string;
  argv: string[];
  /** Any command beginning with `argv`, rather than exactly `argv`. */
  prefix: boolean;
  createdAt: Date;
}

function toAllowed(row: {
  id: string | number;
  agent_id: string;
  dir: string;
  argv: unknown;
  prefix: boolean;
  created_at: Date;
}): AllowedCommand {
  return {
    id: Number(row.id),
    agentId: row.agent_id,
    dir: row.dir,
    argv: Array.isArray(row.argv) ? row.argv.map(String) : [],
    prefix: row.prefix,
    createdAt: row.created_at,
  };
}

const ALLOWED_COLUMNS = 'id, agent_id, dir, argv, prefix, created_at';

/** Every standing allow, or only those for one workspace (agent and directory). */
export async function listAllowedCommands(
  db: Db,
  workspace?: { agentId: string; dir: string },
): Promise<AllowedCommand[]> {
  const { rows } = workspace
    ? await db.query(
        `select ${ALLOWED_COLUMNS} from developer.allowed_commands
          where agent_id = $1 and dir = $2 order by id`,
        [workspace.agentId, workspace.dir],
      )
    : await db.query(`select ${ALLOWED_COLUMNS} from developer.allowed_commands order by agent_id, id`);
  return (rows as Array<Parameters<typeof toAllowed>[0]>).map(toAllowed);
}

/** Remember one decision. Saying it twice is one row. */
export async function allowCommand(
  db: Db,
  input: { agentId: string; dir: string; argv: string[]; prefix: boolean; now: Date },
): Promise<AllowedCommand> {
  const { rows } = await db.query(
    `insert into developer.allowed_commands (agent_id, dir, argv, prefix, created_at)
       values ($1, $2, $3::jsonb, $4, $5)
     on conflict (agent_id, dir, argv, prefix) do update set created_at = developer.allowed_commands.created_at
     returning ${ALLOWED_COLUMNS}`,
    [input.agentId, input.dir, JSON.stringify(input.argv), input.prefix, input.now],
  );
  return toAllowed(rows[0] as Parameters<typeof toAllowed>[0]);
}

export async function forgetAllowedCommand(db: Db, id: number): Promise<boolean> {
  const { rowCount } = await db.query('delete from developer.allowed_commands where id = $1', [id]);
  return (rowCount ?? 0) > 0;
}

/* ------------------------------------------------------------------ *
 * Processes
 * ------------------------------------------------------------------ */

/** §4: "At most 4 per agent." */
export const MAX_PROCESSES_PER_AGENT = 4;

function toProcess(row: {
  agent_id: string;
  name: string;
  pid: number;
  command: string;
  started_at: Date;
  started_at_native: string;
  port: number | null;
  log_path: string;
}): ProcessRow {
  return {
    agentId: row.agent_id,
    name: row.name,
    pid: row.pid,
    command: row.command,
    startedAt: row.started_at.toISOString(),
    startedAtNative: row.started_at_native,
    port: row.port,
    logPath: row.log_path,
  };
}

const PROCESS_COLUMNS =
  'agent_id, name, pid, command, started_at, started_at_native, port, log_path';

export async function listProcesses(db: Db, agentId?: string): Promise<ProcessRow[]> {
  const { rows } = agentId
    ? await db.query(
        `select ${PROCESS_COLUMNS}
           from developer.processes where agent_id = $1 order by name`,
        [agentId],
      )
    : await db.query(
        `select ${PROCESS_COLUMNS}
           from developer.processes order by agent_id, name`,
      );
  return (rows as Array<Parameters<typeof toProcess>[0]>).map(toProcess);
}

/**
 * The one process of this name, whoever started it.
 *
 * `processes(name)` is unique (migration 003), which is what lets the
 * gateway's preview lookup — a name and nothing else — mean one thing.
 */
export async function getProcessByName(db: Db, name: string): Promise<ProcessRow | undefined> {
  const { rows } = await db.query(
    `select ${PROCESS_COLUMNS} from developer.processes where name = $1`,
    [name],
  );
  const row = rows[0] as Parameters<typeof toProcess>[0] | undefined;
  return row ? toProcess(row) : undefined;
}

export async function getProcess(
  db: Db,
  agentId: string,
  name: string,
): Promise<ProcessRow | undefined> {
  const { rows } = await db.query(
    `select ${PROCESS_COLUMNS}
       from developer.processes where agent_id = $1 and name = $2`,
    [agentId, name],
  );
  const row = rows[0] as Parameters<typeof toProcess>[0] | undefined;
  return row ? toProcess(row) : undefined;
}

export async function recordProcess(db: Db, row: Omit<ProcessRow, 'startedAt'>, now: Date): Promise<void> {
  await db.query(
    `insert into developer.processes (agent_id, name, pid, command, started_at, started_at_native, port, log_path)
       values ($1, $2, $3, $4, $5, $6, $7, $8)
     on conflict (agent_id, name) do update
       set pid = excluded.pid, command = excluded.command, started_at = excluded.started_at,
           started_at_native = excluded.started_at_native,
           port = excluded.port, log_path = excluded.log_path`,
    [row.agentId, row.name, row.pid, row.command, now, row.startedAtNative, row.port, row.logPath],
  );
}

export async function setProcessPort(
  db: Db,
  agentId: string,
  name: string,
  port: number,
): Promise<void> {
  await db.query(`update developer.processes set port = $3 where agent_id = $1 and name = $2`, [
    agentId,
    name,
    port,
  ]);
}

export async function forgetProcess(db: Db, agentId: string, name: string): Promise<boolean> {
  const { rowCount } = await db.query(
    `delete from developer.processes where agent_id = $1 and name = $2`,
    [agentId, name],
  );
  return (rowCount ?? 0) > 0;
}

/* ------------------------------------------------------------------ *
 * Settings
 * ------------------------------------------------------------------ */

export async function getSettings(db: Db): Promise<Settings> {
  const { rows } = await db.query(`select tailscale_routes from developer.settings limit 1`);
  const row = rows[0] as { tailscale_routes: boolean } | undefined;
  return { tailscaleRoutes: row?.tailscale_routes ?? false };
}

export async function setSettings(db: Db, next: Settings, now: Date): Promise<Settings> {
  await db.query(
    `insert into developer.settings (only_row, tailscale_routes, updated_at) values (true, $1, $2)
     on conflict (only_row) do update set tailscale_routes = excluded.tailscale_routes, updated_at = excluded.updated_at`,
    [next.tailscaleRoutes, now],
  );
  return getSettings(db);
}
