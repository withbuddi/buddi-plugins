/**
 * The developer's lines in the carry-over note: the workspace, branch, last
 * commit and what is uncommitted, read from real git in a throwaway repo.
 */
import { execFileSync } from 'node:child_process';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import type { ToolContext } from '@buddi/core/plugin';
import manifest from './index.js';
import { carryOverLines, developerCarryOver } from './carryover.js';
import { gitOut } from './git.js';
import { realpathish } from './paths.js';

const dirs: string[] = [];
const gitPath = execFileSync('which', ['git'], { encoding: 'utf8' }).trim();

afterEach(async () => {
  await Promise.all(dirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

async function workspaceDir(init: boolean): Promise<string> {
  const dir = await realpathish(await mkdtemp(path.join(tmpdir(), 'buddi-developer-carry-')));
  dirs.push(dir);
  if (init) {
    const opts = { cwd: dir };
    await gitOut(['init', '--quiet', '--initial-branch=main'], opts);
    await gitOut(['config', 'user.email', 'test@example.invalid'], opts);
    await gitOut(['config', 'user.name', 'Test'], opts);
  }
  return dir;
}

/** A context whose database knows one workspace, for agent `dev`. */
function ctxFor(dir: string | null, agentId = 'dev'): ToolContext {
  const now = new Date('2026-10-01T00:00:00Z');
  return {
    agentId,
    buddi: {
      db: {
        query: async () => ({
          rows: dir === null ? [] : [{ agent_id: agentId, dir, mode: 'edit', toolchain_path: process.env.PATH ?? '', git_path: gitPath, created_at: now, updated_at: now }],
        }),
      },
    },
  } as unknown as ToolContext;
}

describe('the developer carry-over lines', () => {
  it('name the workspace, branch, last commit and uncommitted files', async () => {
    const dir = await workspaceDir(true);
    await writeFile(path.join(dir, 'README.md'), '# fixture\n');
    await gitOut(['add', '--all'], { cwd: dir });
    await gitOut(['commit', '--no-verify', '--quiet', '-m', 'Add the readme'], { cwd: dir });
    await gitOut(['switch', '--quiet', '--create', 'buddi/dev/dark-mode'], { cwd: dir });
    await writeFile(path.join(dir, 'README.md'), '# changed\n');
    await writeFile(path.join(dir, 'new.ts'), 'export const a = 1;\n');

    const lines = await carryOverLines(ctxFor(dir));
    expect(lines[0]).toBe(`Workspace: ${dir} (edit mode)`);
    expect(lines).toContain('Branch: buddi/dev/dark-mode');
    expect(lines.find((l) => l.startsWith('Last commit: '))).toMatch(/^Last commit: [0-9a-f]{7,} Add the readme$/);
    expect(lines.find((l) => l.startsWith('Uncommitted: '))).toBe('Uncommitted: 2 files (README.md, new.ts)');
    // Names only: never a file's contents.
    expect(lines.join('\n')).not.toContain('export const a');
  });

  it('say the tree is clean, and that there are no commits yet', async () => {
    const dir = await workspaceDir(true);
    const lines = await carryOverLines(ctxFor(dir));
    expect(lines).toContain('Branch: main');
    expect(lines).toContain('No commits yet.');
    expect(lines).toContain('Working tree clean.');
  });

  it('say when the workspace is not a repository', async () => {
    const dir = await workspaceDir(false);
    expect(await carryOverLines(ctxFor(dir))).toEqual([`Workspace: ${dir} (edit mode)`, 'Not a git repository.']);
  });

  it('are nothing for an agent with no workspace', async () => {
    expect(await carryOverLines(ctxFor(null))).toEqual([]);
  });

  it('are what the manifest contributes', async () => {
    expect(manifest.carryOver).toBe(developerCarryOver);
    const dir = await workspaceDir(false);
    expect(await manifest.carryOver!.lines({ agentId: 'dev', conversationId: 'c1', reason: 'idle' }, ctxFor(dir))).toContain('Not a git repository.');
  });
});

describe('the developer agent template', () => {
  it('defaults its chats to a day of idle before a fresh one', () => {
    expect(manifest.agents?.[0]?.idleRollover).toBe('1d');
  });
});
