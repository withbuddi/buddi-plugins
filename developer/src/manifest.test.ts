/**
 * The manifest, through core's own validation — and acceptance §10.5, which
 * is a property of the manifest rather than of a run.
 *
 * `ToolRegistry.register` derives a JSON Schema from every zod input, parses
 * every view descriptor and every page descriptor, and checks that each page
 * only names queries and tools this plugin contributes. Registering here is
 * the cheapest proof this plugin will load, and it needs no database.
 */
import { describe, expect, it } from 'vitest';
import { ToolRegistry } from '@buddi/core/testing';
import type { CoreToolContext } from '@buddi/core/testing';
import { manifest } from './index.js';

import { DEVELOPER_NOTICE } from './pages.js';
import { tierForCommand, tierForGit, tierForWrite } from './modes.js';
import { classifyCommand } from './parser.js';
import { classifyForRunList } from './runlist.js';
import { branchNameFor, slugify } from './git.js';

/** Tools a model can be granted: everything that is not the owner's own. */
const modelFacing = manifest.tools.filter((tool) => tool.ownerOnly !== true);

describe('the developer manifest', () => {
  it('registers in a tool registry, pages and views included', () => {
    const registry = new ToolRegistry();
    expect(() => registry.register(manifest)).not.toThrow();
    expect(registry.has('developer.run')).toBe(true);
  });

  it('namespaces every tool to the plugin', () => {
    for (const tool of manifest.tools) {
      expect(tool.name.startsWith('developer.')).toBe(true);
    }
  });

  /**
   * Acceptance §10.5: "A delegate of the developer agent gets none of its
   * tools." This is the construction that makes it true. Every tool a model
   * can be granted declares `session` — which the runtime resolves an agent's
   * grants from, and which `invoke` refuses at `delegationDepth >= 1` — except
   * `developer.workspace`, which is `gated` and is the grant itself. Not one
   * of them declares `auto`, so there is no tool here that a delegate could
   * execute even if it somehow held the name.
   */
  it('gives a delegate nothing: every model-facing tool is session or gated, never auto', () => {
    for (const tool of modelFacing) {
      expect([tool.name, tool.tier]).toEqual([tool.name, tool.tier === 'gated' ? 'gated' : 'session']);
      expect(tool.tier === 'auto').toBe(false);
    }
    expect(manifest.tools.find((tool) => tool.name === 'developer.workspace')?.tier).toBe('gated');
    expect(modelFacing.filter((tool) => tool.tier === 'session').length).toBe(modelFacing.length - 1);
  });

  it('refuses a session tool to a delegate, through the registry itself', async () => {
    const registry = new ToolRegistry();
    registry.register(manifest);
    const ctx = {
      db: null as never,
      ownerId: 'owner',
      now: () => new Date(),
      timezone: 'UTC',
      agentId: 'developer',
      conversationId: 'c1',
      // A delegate: one delegation deep, and no owner request of its own.
      delegationDepth: 1,
      sessionTools: ['developer.read'],
      ownerRequest: { id: 'r1', text: 'go', expiresAt: Date.now() + 60_000 },
    } satisfies CoreToolContext;
    const result = await registry.invoke('developer.read', { path: 'a.ts' }, ctx);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.reason).toBe('session-not-authorized');
  });

  it('keeps the owner\'s own tools out of every model\'s list', () => {
    const registry = new ToolRegistry();
    registry.register(manifest);
    const listed = registry.list().map((tool) => tool.name);
    for (const name of ['developer.set_mode', 'developer.stop_all', 'developer.set_settings']) {
      expect(manifest.tools.find((tool) => tool.name === name)?.ownerOnly).toBe(true);
      expect(listed).not.toContain(name);
    }
  });

  it('describes every tool that can ever be gated', () => {
    for (const name of [
      'developer.workspace',
      'developer.write',
      'developer.edit',
      'developer.run',
      'developer.start',
      'developer.git',
    ]) {
      const tool = manifest.tools.find((candidate) => candidate.name === name);
      expect([name, typeof tool?.describe]).toEqual([name, 'function']);
    }
  });

  it('narrows its tier per call, on every tool that has more than one', () => {
    for (const tool of modelFacing) {
      if (tool.tier !== 'session') continue;
      expect([tool.name, typeof tool.tierFor]).toEqual([tool.name, 'function']);
    }
  });

  it('refuses a gated execute with no approved action id', async () => {
    const workspace = manifest.tools.find((tool) => tool.name === 'developer.workspace');
    await expect(
      workspace?.execute(
        { dir: '/tmp' },
        {},
      ),
    ).rejects.toThrow(/action id/);
  });

  it('reaches no host, and says so', () => {
    expect(manifest.network).toEqual([]);
  });

  it('proposes one agent, granted this plugin\'s model-facing tools and its own memory, nothing else', () => {
    const agent = manifest.agents?.[0];
    expect(agent?.id).toBe('developer');
    expect(agent?.tools.filter((name) => name.startsWith('developer.')).sort()).toEqual(
      modelFacing.map((tool) => tool.name).sort(),
    );
    expect(agent?.tools.filter((name) => !name.startsWith('developer.')).sort()).toEqual([
      'memory.forget',
      'memory.get_preferences',
      'memory.note',
      'memory.recall',
      'memory.remember_preference',
    ]);
    expect(agent?.tools.some((name) => name.startsWith('platform.'))).toBe(false);
    expect(agent?.skills?.length).toBe(1);
  });

  it('tells the agent to keep how a project runs as a private note named for the project', () => {
    const body = manifest.agents?.[0]?.skills?.[0]?.body ?? '';
    expect(body).toContain('memory.note');
    expect(body).toContain('memory.recall');
    expect(body).toMatch(/private note that names the project/);
  });

  it('puts the sentence from §8 on the settings page', () => {
    const page = manifest.pages?.[0];
    expect(page?.place).toBe('settings');
    expect(JSON.stringify(page)).toContain(DEVELOPER_NOTICE);
    expect(DEVELOPER_NOTICE).toContain('with the rights of your user');
  });

  it('contributes a query for every one its page names', () => {
    const named = [...JSON.stringify(manifest.pages).matchAll(/"query":"([a-z_]+)"/g)].map(
      (match) => match[1],
    );
    const contributed = new Set(manifest.queries?.map((query) => query.name));
    for (const name of named) expect(contributed.has(name as string)).toBe(true);
  });
});

describe('the mode, as the tier of one call', () => {
  const clean = classifyForRunList('pnpm test');
  const install = classifyForRunList('npm install');

  it('gates every write in ask mode and nothing else', () => {
    expect(tierForWrite('ask').tier).toBe('gated');
    expect(tierForWrite('edit').tier).toBe('auto');
    expect(tierForWrite('run').tier).toBe('auto');
  });

  it('gates every command in ask and edit, and a listed one only in run', () => {
    expect(tierForCommand('ask', clean).tier).toBe('gated');
    expect(tierForCommand('edit', clean).tier).toBe('gated');
    expect(tierForCommand('run', clean).tier).toBe('auto');
  });

  /** Acceptance §10.3: `npm install` is gated in run mode, with the rule named. */
  it('gates an install in run mode, and says which rule', () => {
    const decision = tierForCommand('run', install, classifyCommand('npm install', { workspace: '/w' }));
    expect(decision.tier).toBe('gated');
    expect(decision.reason).toContain('installs packages');
  });

  it('names the rule for a destroyer too', () => {
    const decision = tierForCommand(
      'run',
      classifyForRunList('rm -rf .'),
      classifyCommand('rm -rf .', { workspace: '/w' }),
    );
    expect(decision.tier).toBe('gated');
    expect(decision.reason).toContain('rm');
  });

  it('lets a read of the repository through in every mode', () => {
    for (const mode of ['ask', 'edit', 'run'] as const) {
      expect(tierForGit(mode, 'status').tier).toBe('auto');
      expect(tierForGit(mode, 'diff').tier).toBe('auto');
    }
  });

  /**
   * The row of §4 that changed. `git add` runs a repository's own clean
   * filters and `commit` its own hooks, both of them code in files an agent
   * can write, so a commit is auto only where running code is already what
   * the mode means.
   */
  it('commits without a card only in run mode', () => {
    expect(tierForGit('ask', 'commit').tier).toBe('gated');
    expect(tierForGit('edit', 'commit').tier).toBe('gated');
    expect(tierForGit('edit', 'commit').reason).toContain('filters and hooks');
    expect(tierForGit('run', 'commit').tier).toBe('auto');
  });

  it('creates a branch on the mode, as before', () => {
    expect(tierForGit('ask', 'branch').tier).toBe('gated');
    expect(tierForGit('edit', 'branch').tier).toBe('auto');
  });
});

describe('the branch an agent commits on', () => {
  it('is buddi/<agent>/<task>', () => {
    expect(branchNameFor('developer', 'Add a test for the stale-balance flag')).toBe(
      'buddi/developer/add-a-test-for-the-stale-balance-flag',
    );
  });

  it('survives a task nobody would put in a ref name', () => {
    expect(slugify('  !!!  ')).toBe('work');
    expect(branchNameFor('dev', '../../etc/passwd')).toBe('buddi/dev/etc-passwd');
  });
});
