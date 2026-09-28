/**
 * The boundary. One function, used by every tool that names a path.
 *
 * §2 of the spec, and then what two reviews added to it:
 *
 *  - **No symlink component, anywhere inside the workspace.** The first
 *    version realpath'd the whole path and compared the result, which is
 *    correct about *where the link points now* and says nothing about where it
 *    points a microsecond later: a process inside the workspace — the agent's
 *    own dev server, a package's postinstall — can swap a directory component
 *    for a symlink between the check and the open. So the walk below refuses a
 *    symlink component outright. A link is a way out until proven otherwise,
 *    and a workspace that genuinely contains symlinks needs them replaced;
 *    that is stated in the spec and in `buddi.md`.
 *  - **`.git/` is not writable.** A hook, `core.hooksPath`, an `[alias] x =
 *    !sh -c …`, a clean filter: each is code that runs with no card the next
 *    time `git` is invoked. Reads of `.git` are allowed — they are how an
 *    agent understands a repository — writes are not.
 *  - **The deny list grew** to cover every credential, every shell rc file
 *    (which would re-arm itself) and buddi's own plumbing.
 *
 * It remains a rule this plugin enforces, not an operating-system one (§9).
 * The residual is the window between this check and the syscall after it;
 * `files.ts` closes what it can with `O_NOFOLLOW` and a same-directory
 * `rename`, and the rest is stated rather than hidden.
 */
import { constants, promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

/**
 * A refusal the owner and the model both read. Never a defect. Flagged
 * `refusal` (core's `ToolRefusal` convention) so that thrown from `describe`
 * it reaches them as it stands, not as "could not describe this effect".
 */
export class PathRefused extends Error {
  readonly refusal = true;
  constructor(
    message: string,
    readonly rule:
      | 'outside'
      | 'absolute'
      | 'dotdot'
      | 'denied'
      | 'symlink'
      | 'git-internals'
      | 'protected'
      | 'no-workspace',
  ) {
    super(message);
    this.name = 'PathRefused';
  }
}

export interface DenyListOptions {
  env?: NodeJS.ProcessEnv;
  /** The home directory, injectable so a test does not depend on the runner's. */
  home?: string;
  /** The workspace's captured toolchain PATH; its directories are never reachable. */
  toolchainPath?: string | undefined;
  /**
   * Directories no write may land in, from the gateway (`ToolContext.protectedPaths`):
   * the owner's agent files and skills. Readable; never written, and never a workspace.
   */
  protectedPaths?: readonly string[] | undefined;
}

/**
 * The owner's agent files and skills: every agent's persona, allowlist and
 * skills, learned ones included (docs/learning.md §6). An agent learns
 * by proposing a skill, never by writing one, so a workspace that contains
 * these directories — buddi's own repository, say — still refuses a write
 * into them. From the gateway, plus the two variables that pin them.
 */
export function protectedList(opts: DenyListOptions = {}): string[] {
  const env = opts.env ?? process.env;
  const out = [...(opts.protectedPaths ?? [])];
  for (const key of ['BUDDI_AGENTS_DIR', 'BUDDI_SKILLS_DIR']) {
    const value = env[key]?.trim();
    if (value) out.push(value);
  }
  return [...new Set(out.filter((dir) => path.isAbsolute(dir)).map((dir) => path.resolve(dir)))];
}

/** The protected directory `target` (already resolved) lies in, or undefined. */
export async function protectedHolding(target: string, opts: DenyListOptions = {}): Promise<string | undefined> {
  for (const guarded of protectedList(opts)) {
    const guardedReal = await realpathish(guarded);
    if (isInside(guardedReal, target)) return guardedReal;
  }
  return undefined;
}

/**
 * The directories and files nothing may reach, whatever the workspace is.
 *
 * `resolveDataDir` from core is deliberately not called: it resolves
 * `<repo>/data` from *core's own* installed location when `BUDDI_DATA_DIR` is
 * unset, which for a plugin loaded out of the owner's plugins directory is a
 * path inside `node_modules`. `~/.buddi` is the honest fallback for a plugin
 * and is on the list unconditionally.
 */
export function denyList(opts: DenyListOptions = {}): string[] {
  const env = opts.env ?? process.env;
  const home = opts.home ?? os.homedir();
  const under = (...parts: string[]): string => path.join(home, ...parts);
  const out = [
    // Credentials and keys.
    under('.ssh'),
    under('.aws'),
    under('.gnupg'),
    under('.netrc'),
    under('.npmrc'),
    under('.pypirc'),
    under('.docker'),
    under('.kube'),
    under('.config', 'gh'),
    under('.config', 'gcloud'),
    under('Library', 'Keychains'),
    // Anything that runs on the owner's next login, or their next git call.
    under('.gitconfig'),
    under('.config', 'git'),
    under('.zshenv'),
    under('.zprofile'),
    under('.zshrc'),
    under('.bashrc'),
    under('.bash_profile'),
    under('.profile'),
    under('.config', 'fish'),
    // buddi's own plumbing.
    under('.buddi'),
  ];
  const buddiHome = env.BUDDI_HOME?.trim();
  if (buddiHome) out.push(path.resolve(buddiHome));
  const dataDir = env.BUDDI_DATA_DIR?.trim();
  if (dataDir) out.push(path.resolve(dataDir));
  const pluginsFile = env.BUDDI_PLUGINS_FILE?.trim();
  if (pluginsFile) out.push(path.dirname(path.resolve(pluginsFile)));
  const vaultFile = env.BUDDI_VAULT_FILE?.trim();
  if (vaultFile) {
    out.push(path.resolve(vaultFile));
    out.push(path.dirname(path.resolve(vaultFile)));
  } else {
    out.push(path.join(buddiHome ? path.resolve(buddiHome) : under('.buddi'), 'vault.json'));
  }
  // The toolchain's own directories: a `PATH` entry that happens to sit inside
  // the workspace would let an edit replace the `node` the next command runs.
  for (const entry of (opts.toolchainPath ?? '').split(':')) {
    const dir = entry.trim();
    if (dir !== '' && path.isAbsolute(dir)) out.push(path.resolve(dir));
  }
  return [...new Set(out)];
}

/** macOS compares paths case-insensitively; so must the deny list, there. */
function sameCase(value: string): string {
  return process.platform === 'darwin' ? value.toLowerCase() : value;
}

/** Is `child` `parent` itself, or inside it? Both already resolved. */
export function isInside(parent: string, child: string): boolean {
  const a = sameCase(parent);
  const b = sameCase(child);
  if (a === b) return true;
  const rel = path.relative(a, b);
  return rel !== '' && !rel.startsWith('..') && !path.isAbsolute(rel);
}

/**
 * `realpath` of the deepest existing ancestor, with the rest appended.
 *
 * Used for the *workspace root* and for the deny list, both of which are paths
 * the owner or the installation named. A candidate path a model wrote goes
 * through `resolveInside`, which walks instead.
 */
export async function realpathish(candidate: string): Promise<string> {
  let head = path.resolve(candidate);
  const tail: string[] = [];
  for (;;) {
    try {
      const resolved = await fs.realpath(head);
      return tail.length === 0 ? resolved : path.join(resolved, ...tail.reverse());
    } catch {
      const parent = path.dirname(head);
      if (parent === head) return path.resolve(candidate);
      tail.push(path.basename(head));
      head = parent;
    }
  }
}

/** Git's own directory, and the files that make git run other people's code. */
const GIT_INTERNALS = new Set(['.git', '.hg', '.svn']);
const GIT_CONFIGURING_FILES = new Set(['.gitmodules', '.gitattributes']);

/** Is this workspace-relative path one of the files that configure git? */
export function configuresGit(relative: string): boolean {
  return relative.split(/[\\/]/).some((part) => GIT_CONFIGURING_FILES.has(part));
}

export interface ResolveInsideOptions extends DenyListOptions {
  /** Allow the workspace root itself (`developer.list` with no path). */
  allowRoot?: boolean;
  /** This path is about to be written: `.git/` and friends are refused. */
  forWrite?: boolean;
}

/**
 * The one entry point. Returns an absolute path inside the workspace with no
 * symlink component, or throws `PathRefused` naming the rule.
 */
export async function resolveInside(
  workspace: string,
  candidate: string,
  opts: ResolveInsideOptions = {},
): Promise<string> {
  const relative = candidate ?? '';
  if (path.isAbsolute(relative)) {
    throw new PathRefused(
      `refused: ${relative} is an absolute path. Every path is relative to the workspace.`,
      'absolute',
    );
  }
  const parts = relative.split(/[\\/]/).filter((part) => part !== '' && part !== '.');
  if (parts.includes('..')) {
    throw new PathRefused(`refused: ${relative} contains "..", which leaves the workspace.`, 'dotdot');
  }
  if (parts.length === 0 && opts.allowRoot !== true) {
    throw new PathRefused('refused: no path was given.', 'outside');
  }
  if (opts.forWrite === true) {
    const internal = parts.find((part) => GIT_INTERNALS.has(part));
    if (internal !== undefined) {
      throw new PathRefused(
        `refused: ${relative} is inside ${internal}. A hook, an alias or a clean filter written there ` +
          'is code that runs the next time git does, with no card. It can be read; it is never written.',
        'git-internals',
      );
    }
  }

  const root = await realpathish(workspace);
  // Walk it. Every component that exists must be an ordinary file or
  // directory — never a symlink — and the first one that is not there ends
  // the walk: what does not exist cannot be a link.
  let current = root;
  for (const part of parts) {
    current = path.join(current, part);
    let info;
    try {
      info = await fs.lstat(current);
    } catch {
      break;
    }
    if (info.isSymbolicLink()) {
      throw new PathRefused(
        `refused: ${path.relative(root, current)} is a symbolic link, and a link is a way out of the ` +
          'workspace whatever it points at today. Replace it with the real file or directory.',
        'symlink',
      );
    }
  }
  const target = path.join(root, ...parts);
  if (!isInside(root, target)) {
    throw new PathRefused(
      `refused: ${relative} resolves to ${target}, which is outside the workspace ${root}.`,
      'outside',
    );
  }
  // A path inside a denied directory, or the denied file itself, is refused.
  // A path *above* one is not: `~/.zprofile` symlinked into a dotfiles
  // project under the workspace must not make every ancestor unlistable. The
  // tree walks step over the denied entry itself, and a read or write that
  // names it comes back through here and is refused then.
  for (const denied of denyList(opts)) {
    const deniedReal = await realpathish(denied);
    if (isInside(deniedReal, target)) {
      throw new PathRefused(
        `refused: ${relative} resolves to ${target}, inside ${deniedReal}, which is never readable or writable from a workspace.`,
        'denied',
      );
    }
  }
  if (opts.forWrite === true) {
    const guardedReal = await protectedHolding(target, opts);
    if (guardedReal !== undefined) {
      throw new PathRefused(
        `refused: ${relative} resolves to ${target}, inside ${guardedReal}: the owner's agent files and skills. ` +
          'No tool writes there. To keep a procedure, propose it with learning.propose_skill; the owner decides.',
        'protected',
      );
    }
  }
  return target;
}

/**
 * Open the final component without following a link, then prove the thing
 * that is open is the thing that was checked.
 *
 * `O_NOFOLLOW` closes the last component: between the walk and this call it
 * could have become a link, and that is an `ELOOP` rather than an open of
 * somebody else's file. It says nothing about the *directories* above it,
 * which could have been swapped in the same window — so afterwards the
 * components are walked again with `lstat` (no link anywhere), and the open
 * descriptor's `(dev, ino)` is compared with `lstat` of the path that was
 * validated. A mismatch means the name now points at something else, and the
 * handle is closed and the call refused.
 *
 * What is left — and §9 says so rather than implying otherwise — is the
 * window between this check and the read or write on the descriptor. It
 * cannot be closed from user space without holding the directory open for the
 * whole operation, and it is the ordinary race any unprivileged program has.
 */
export async function openNoFollow(
  file: string,
  flags: number,
  opts: { root?: string } = {},
): Promise<fs.FileHandle> {
  let handle: fs.FileHandle;
  try {
    handle = await fs.open(file, flags | constants.O_NOFOLLOW);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ELOOP') {
      throw new PathRefused(
        `refused: ${path.basename(file)} became a symbolic link between the check and the open.`,
        'symlink',
      );
    }
    throw err;
  }
  try {
    await confirmOpened(handle, file, opts.root);
  } catch (err) {
    await handle.close().catch(() => undefined);
    throw err;
  }
  return handle;
}

/** The open descriptor is the path that was validated, and no link is above it. */
async function confirmOpened(
  handle: fs.FileHandle,
  file: string,
  root: string | undefined,
): Promise<void> {
  if (root !== undefined) {
    const parts = path.relative(root, file).split(path.sep).filter((part) => part !== '');
    let current = root;
    for (const part of parts) {
      current = path.join(current, part);
      const info = await fs.lstat(current).catch(() => undefined);
      if (info === undefined) break;
      if (info.isSymbolicLink()) {
        throw new PathRefused(
          `refused: ${path.relative(root, current)} became a symbolic link while the file was being opened.`,
          'symlink',
        );
      }
    }
  }
  const [opened, named] = await Promise.all([handle.stat(), fs.lstat(file)]);
  if (opened.dev !== named.dev || opened.ino !== named.ino) {
    throw new PathRefused(
      `refused: ${path.basename(file)} is not the file that was checked — it was replaced between the check and the open.`,
      'symlink',
    );
  }
}

/**
 * The same rules applied to a *workspace directory* the owner is naming.
 *
 * Absolute is required here rather than refused — it is the one path in the
 * plugin that is not relative to anything. A workspace may sit above a denied
 * directory (a home directory sits above all of them) but may not *be* one,
 * and may not be `/` or the home directory itself: a workspace is a project,
 * and "everything" is not a project.
 */
export async function resolveWorkspaceDir(
  dir: string,
  opts: DenyListOptions = {},
): Promise<string> {
  if (!path.isAbsolute(dir)) {
    throw new PathRefused(
      `refused: ${dir} is not an absolute path. A workspace is one absolute directory on this machine.`,
      'absolute',
    );
  }
  const resolved = await realpathish(dir);
  const home = await realpathish(opts.home ?? os.homedir());
  if (resolved === path.parse(resolved).root) {
    throw new PathRefused('refused: the whole filesystem is not a workspace.', 'denied');
  }
  if (isInside(resolved, home) && isInside(home, resolved)) {
    throw new PathRefused(
      'refused: your home directory is not a workspace. Name the project inside it.',
      'denied',
    );
  }
  for (const denied of [...denyList(opts), ...protectedList(opts)]) {
    const deniedReal = await realpathish(denied);
    if (isInside(deniedReal, resolved)) {
      throw new PathRefused(
        `refused: ${resolved} is inside ${deniedReal}, which is never a workspace.`,
        'denied',
      );
    }
  }
  return resolved;
}
