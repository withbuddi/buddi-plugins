/**
 * The boundary, one test per way out of it — on real filesystem objects.
 *
 * Acceptance §10.2 ("a path outside the workspace is refused in every tool,
 * including through a symlink") plus what the reviews added: a symlink is now
 * refused rather than resolved, `.git/` is not writable, and the deny list
 * covers the credentials and the shell rc files that would have re-armed the
 * whole problem.
 */
import { mkdtemp, mkdir, rm, symlink, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  PathRefused,
  configuresGit,
  denyList,
  isInside,
  realpathish,
  resolveInside,
  resolveWorkspaceDir,
} from './paths.js';

let root: string;
let workspace: string;
let outside: string;

beforeAll(async () => {
  root = await realpathish(await mkdtemp(path.join(os.tmpdir(), 'buddi-developer-paths-')));
  workspace = path.join(root, 'workspace');
  outside = path.join(root, 'outside');
  await mkdir(path.join(workspace, 'src'), { recursive: true });
  await mkdir(path.join(workspace, '.git', 'hooks'), { recursive: true });
  await mkdir(outside, { recursive: true });
  await writeFile(path.join(workspace, 'src', 'a.ts'), 'export const a = 1;\n');
  await writeFile(path.join(outside, 'secret.txt'), 'nope\n');
  await symlink(path.join(outside, 'secret.txt'), path.join(workspace, 'escape.txt'));
  await symlink(outside, path.join(workspace, 'escape-dir'));
  await symlink(path.join(workspace, 'src', 'a.ts'), path.join(workspace, 'inside-link.ts'));
});

afterAll(async () => {
  if (root) await rm(root, { recursive: true, force: true });
});

const refusal = async (relative: string, opts = {}): Promise<PathRefused> => {
  try {
    await resolveInside(workspace, relative, opts);
  } catch (err) {
    return err as PathRefused;
  }
  throw new Error(`${relative} was not refused`);
};

describe('resolveInside', () => {
  it('resolves an ordinary path inside the workspace', async () => {
    expect(await resolveInside(workspace, 'src/a.ts')).toBe(path.join(workspace, 'src', 'a.ts'));
  });

  it('resolves a file that is not there yet, under a directory that is', async () => {
    expect(await resolveInside(workspace, 'src/new/deep.ts')).toBe(
      path.join(workspace, 'src', 'new', 'deep.ts'),
    );
  });

  it('refuses an absolute path, even one that lands inside', async () => {
    expect((await refusal(path.join(workspace, 'src', 'a.ts'))).rule).toBe('absolute');
    expect((await refusal('/etc/passwd')).rule).toBe('absolute');
  });

  it('refuses "..", however it is spelled', async () => {
    expect((await refusal('../outside/secret.txt')).rule).toBe('dotdot');
    expect((await refusal('src/../../outside/secret.txt')).rule).toBe('dotdot');
  });

  /**
   * The change the reviews forced. Resolving a link and comparing the answer
   * is a statement about where it points *now*; a process inside the
   * workspace can move it between the check and the open. So a link is
   * refused — including one that stays inside, because there is no way to
   * tell the two apart at the moment that matters.
   */
  it('refuses a symlink, wherever it points', async () => {
    expect((await refusal('escape.txt')).rule).toBe('symlink');
    expect((await refusal('escape-dir/secret.txt')).rule).toBe('symlink');
    expect((await refusal('inside-link.ts')).rule).toBe('symlink');
  });

  it('says what to do about a symlink, rather than only refusing it', async () => {
    expect((await refusal('escape.txt')).message).toMatch(/Replace it with the real file/);
  });

  it('refuses the root unless the caller asked for it', async () => {
    expect((await refusal('')).rule).toBe('outside');
    expect(await resolveInside(workspace, '', { allowRoot: true })).toBe(workspace);
  });

  it('reads .git, and never writes it', async () => {
    // Reading a hook is how an agent understands a repository.
    expect(await resolveInside(workspace, '.git/hooks/pre-commit')).toBe(
      path.join(workspace, '.git', 'hooks', 'pre-commit'),
    );
    // Writing one is arbitrary code with no card, the next time git runs.
    expect((await refusal('.git/hooks/pre-commit', { forWrite: true })).rule).toBe('git-internals');
    expect((await refusal('.git/config', { forWrite: true })).rule).toBe('git-internals');
    expect((await refusal('src/../.git/config', { forWrite: true })).rule).toBe('dotdot');
  });

  it('refuses the deny list even when the workspace is above it', async () => {
    const home = path.join(root, 'home');
    await mkdir(path.join(home, '.ssh'), { recursive: true });
    await writeFile(path.join(home, '.ssh', 'id_ed25519'), 'key\n');
    await expect(resolveInside(home, '.ssh/id_ed25519', { home })).rejects.toThrow(/never readable/);
  });

  it('refuses every credential and shell rc file the reviews named', async () => {
    const home = path.join(root, 'home-creds');
    await mkdir(home, { recursive: true });
    for (const file of [
      '.npmrc',
      '.netrc',
      '.gitconfig',
      '.zshenv',
      '.zprofile',
      '.bashrc',
      '.bash_profile',
      '.profile',
    ]) {
      await expect(resolveInside(home, file, { home })).rejects.toThrow(/never readable/);
    }
    for (const dir of ['.config/gh', 'Library/Keychains', '.docker', '.kube']) {
      await expect(resolveInside(home, `${dir}/x`, { home })).rejects.toThrow(/never readable/);
    }
  });

  it('allows an ancestor of a denied file, and still refuses the file itself', async () => {
    // `~/.zprofile -> <workspace>/dotfiles/zprofile` is a common dotfiles
    // setup; it must not make the workspace root unlistable.
    const home = path.join(root, 'home3');
    const ws = path.join(home, 'projects');
    await mkdir(path.join(ws, 'dotfiles'), { recursive: true });
    await writeFile(path.join(ws, 'dotfiles', 'zprofile'), 'export X=1\n');
    await symlink(path.join(ws, 'dotfiles', 'zprofile'), path.join(home, '.zprofile'));
    expect(await resolveInside(ws, '', { home, allowRoot: true })).toBe(ws);
    expect(await resolveInside(ws, 'dotfiles', { home })).toBe(path.join(ws, 'dotfiles'));
    await expect(resolveInside(ws, 'dotfiles/zprofile', { home })).rejects.toThrow(
      /never readable/,
    );
  });

  it("refuses buddi's own data directory and the vault", async () => {
    const home = path.join(root, 'home2');
    const data = path.join(home, 'buddi-data');
    await mkdir(path.join(data, 'artifacts'), { recursive: true });
    const env = { BUDDI_DATA_DIR: data, BUDDI_VAULT_FILE: path.join(data, 'vault.json') };
    await expect(resolveInside(home, 'buddi-data/artifacts/x.pdf', { home, env })).rejects.toThrow(
      /never readable/,
    );
    await expect(resolveInside(home, 'buddi-data/vault.json', { home, env })).rejects.toThrow(
      /never readable/,
    );
  });

  it('refuses a toolchain directory that happens to be inside the workspace', async () => {
    const bin = path.join(workspace, 'tools', 'bin');
    await mkdir(bin, { recursive: true });
    await expect(
      resolveInside(workspace, 'tools/bin/node', { toolchainPath: `${bin}:/usr/bin` }),
    ).rejects.toThrow(/never readable/);
    // …and it is an ordinary path when it is not on the PATH.
    expect(await resolveInside(workspace, 'tools/bin/node')).toBe(path.join(bin, 'node'));
  });
});

describe('configuresGit', () => {
  it("names the two files that make git run other people's code", () => {
    expect(configuresGit('.gitattributes')).toBe(true);
    expect(configuresGit('sub/.gitmodules')).toBe(true);
    expect(configuresGit('src/a.ts')).toBe(false);
  });
});

describe('resolveWorkspaceDir', () => {
  it('requires an absolute directory', async () => {
    await expect(resolveWorkspaceDir('project')).rejects.toThrow(/absolute/);
  });

  it('refuses a workspace inside a denied directory', async () => {
    const home = path.join(root, 'home3');
    await mkdir(path.join(home, '.buddi', 'plugins'), { recursive: true });
    await expect(resolveWorkspaceDir(path.join(home, '.buddi', 'plugins'), { home })).rejects.toThrow(
      /never a workspace/,
    );
  });

  it('refuses the filesystem and the home directory themselves', async () => {
    const home = path.join(root, 'home4');
    await mkdir(home, { recursive: true });
    await expect(resolveWorkspaceDir(home, { home })).rejects.toThrow(/not a workspace/);
    await expect(resolveWorkspaceDir('/', { home })).rejects.toThrow(/whole filesystem/);
  });

  it('allows a workspace that merely sits above a denied directory', async () => {
    const home = path.join(root, 'home5');
    const project = path.join(home, 'project');
    await mkdir(path.join(home, '.ssh'), { recursive: true });
    await mkdir(project, { recursive: true });
    expect(await resolveWorkspaceDir(project, { home })).toBe(await realpathish(project));
  });
});

describe('the deny list', () => {
  it('names what the spec names, whatever the environment says', () => {
    const list = denyList({ home: '/home/owner', env: {} });
    for (const entry of [
      '/home/owner/.ssh',
      '/home/owner/.aws',
      '/home/owner/.buddi',
      '/home/owner/.buddi/vault.json',
      '/home/owner/.npmrc',
      '/home/owner/.netrc',
      '/home/owner/.gitconfig',
      '/home/owner/.zshenv',
      '/home/owner/Library/Keychains',
    ]) {
      expect(list).toContain(entry);
    }
  });

  it('follows an installation that moved its data, and the toolchain', () => {
    const list = denyList({
      home: '/home/owner',
      env: { BUDDI_DATA_DIR: '/srv/buddi' },
      toolchainPath: '/opt/tools/bin:relative:/usr/bin',
    });
    expect(list).toContain('/srv/buddi');
    expect(list).toContain('/opt/tools/bin');
    expect(list).not.toContain('relative');
  });
});

describe('isInside', () => {
  it('counts the directory itself', () => {
    expect(isInside('/a/b', '/a/b')).toBe(true);
    expect(isInside('/a/b', '/a/b/c')).toBe(true);
    expect(isInside('/a/b', '/a/bc')).toBe(false);
    expect(isInside('/a/b', '/a')).toBe(false);
  });

  it('compares case-insensitively where the filesystem does', () => {
    // APFS is case-insensitive by default, so `.SSH` and `.ssh` are the same
    // directory and the deny list has to agree — including for one that does
    // not exist yet, where `realpath` cannot canonicalise anything.
    const expected = process.platform === 'darwin';
    expect(isInside('/home/owner/.ssh', '/home/owner/.SSH/id')).toBe(expected);
  });
});

describe("the owner's agent files and skills", () => {
  it('reads them, and refuses a write into an agent\'s own skills directory even inside the workspace', async () => {
    // buddi's own repository granted as a workspace: private/agents is inside it.
    const agents = path.join(workspace, 'private', 'agents');
    await mkdir(path.join(agents, 'developer', 'skills'), { recursive: true });
    const opts = { protectedPaths: [agents], env: {} };
    expect(await resolveInside(workspace, 'private/agents/developer/skills/x.md', opts)).toBe(
      path.join(agents, 'developer', 'skills', 'x.md'),
    );
    const refused = await resolveInside(workspace, 'private/agents/developer/skills/x.md', { ...opts, forWrite: true })
      .then(() => null, (err: unknown) => err as PathRefused);
    expect(refused?.rule).toBe('protected');
    expect(refused?.message).toMatch(/learning\.propose_skill/);
    // The rest of the workspace is still writable.
    expect(await resolveInside(workspace, 'src/b.ts', { ...opts, forWrite: true })).toBe(path.join(workspace, 'src', 'b.ts'));
  });

  it('takes BUDDI_AGENTS_DIR too, and never grants a workspace inside one', async () => {
    const agents = path.join(root, 'pinned-agents');
    await mkdir(path.join(agents, 'dev'), { recursive: true });
    await expect(resolveWorkspaceDir(path.join(agents, 'dev'), { env: { BUDDI_AGENTS_DIR: agents }, home: root + '-home' }))
      .rejects.toThrow(/never a workspace/);
  });
});
