/**
 * `developer.env` (docs/owner-secrets.md §3, §4, acceptance 3): the
 * destination and its target check, the delivery of a workspace's bindings
 * into a real child's environment, a pending card and a refusal skipping the
 * variable by name, and the write/edit refusal for content that carries a
 * stored value. A real Postgres — core migrated first, then this plugin's
 * schema, because the uses live in `core.*` — a real temp workspace and real
 * children; a memory vault stands in for the keychain, the way core's own
 * secrets suite runs. Skipped without a database, like every DB suite here.
 *
 * The value under test is written into this file's own assertions, where it
 * may live: what the tests also prove is that it never reaches a tool result,
 * a use row or a card — every such place is read back and checked for it.
 */
import { lstat, mkdir, mkdtemp, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { Pool } from 'pg';
import {
  ToolRegistry,
  configurePluginHost,
  configureSecretScrubbing,
  createMemoryVault,
  createPluginHost,
  createPool,
  createSecretsManifest,
  decideApproval,
  executeApproved,
  hostBindingOf,
  migrate,
  migrateCore,
  ownerSecretVaultName,
  primeSecretScrubber,
  putOwnerSecret,
  resetPluginHost,
  resetSecretDestinations,
  secretDestination,
  setSecretScrubSource,
  testDatabaseUrl,
  type CoreToolContext,
  type SecretRule,
} from '@buddi/core/testing';
import { captureToolchainPath } from './exec.js';
import { realpathish } from './paths.js';
import { manifest } from './index.js';
import { ENV_KIND, envDestination, takeDelivered } from './secrets.js';
import { setMode, setWorkspaceDir } from './store.js';
import { stopProcess } from './processes.js';

const databaseUrl = await testDatabaseUrl();
const suite = databaseUrl ? describe : describe.skip;

const TEST_DB = `buddi_developer_secrets_${process.pid}`;
const SECRET_NAME = 'Example Agency admin password';
const TOKEN_NAME = 'Example Agency api token';
const VALUE = 'correct-horse-battery-staple-9f2a';
const TOKEN_VALUE = 'tok-3b1f9d2c8a7e5f60a1b2';
const NOW = new Date('2026-09-24T12:00:00Z');
/** The one conversation the runs happen in: a session tool needs its id, and an approval row needs the row. */
const CONVERSATION_ID = '00000000-0000-4000-8000-00000000c0ff';

/** The child commands: one echoes a variable, one writes it to a file of its own. */
const SHOW = "const name = process.argv[2];\nconsole.log(name + '=' + (process.env[name] ?? ''));\n";
const KEEP = "import { writeFile } from 'node:fs/promises';\nawait writeFile(process.argv[3], process.env[process.argv[2]] ?? '');\n";

suite('developer.env (owner secrets)', () => {
  let admin: Pool;
  let pool: Pool;
  let vault: ReturnType<typeof createMemoryVault>;
  let registry: ToolRegistry;
  let root: string;
  let workspace: string;
  let other: string;
  let alias: string;
  let toolchainPath: string;

  const contextFor = (agentId: string): CoreToolContext => {
    const facts: CoreToolContext = {
      db: pool,
      ownerId: 'test',
      now: () => NOW,
      timezone: 'UTC',
      agentId,
      // One real conversation for the whole suite: a session tool's call
      // carries its id, and an approval row references the row.
      conversationId: CONVERSATION_ID,
      sessionTools: manifest.tools.map((tool) => tool.name),
      ownerRequest: { id: 'request-1', text: 'check the example agency', expiresAt: Date.now() + 600_000 },
    };
    return { ...facts, buddi: createPluginHost(hostBindingOf(manifest), facts) };
  };

  const call = async (name: string, args: unknown, agentId = 'developer'): Promise<any> => {
    const result = await registry.invoke(name, args, contextFor(agentId));
    if (!result.ok) throw new Error(`${name} refused (${result.reason}): ${result.message}`);
    return (result as { output: unknown }).output;
  };

  const toolNamed = (name: string) =>
    manifest.tools.find((tool) => tool.name === name) as { execute: (args: any, ctx: any) => Promise<any> };

  /** A run through the registry; the answer is the tool's own result. */
  const runResult = async (command: string): Promise<any> => {
    const result = await registry.invoke('developer.run', { command }, contextFor('developer'));
    if (!result.ok) throw new Error(`developer.run refused (${result.reason}): ${result.message}`);
    return (result as { output: unknown }).output;
  };

  /** One stored secret, bound to one variable of the test workspace, scrubber rebuilt. */
  const bind = async (name: string, value: string, variable: string, rule: SecretRule = 'pre-approved'): Promise<void> => {
    await putOwnerSecret(pool, vault, {
      name,
      value,
      bindings: [{ kind: ENV_KIND, target: { workspace, variable }, rule }],
    });
    await primeSecretScrubber();
  };

  beforeAll(async () => {
    admin = createPool(databaseUrl as string);
    await admin.query(`drop database if exists ${TEST_DB}`);
    await admin.query(`create database ${TEST_DB}`);
    const testUrl = new URL(databaseUrl as string);
    testUrl.pathname = `/${TEST_DB}`;
    pool = createPool(testUrl.toString());
    await migrateCore(pool);
    await migrate(pool, { schema: manifest.schema, dir: manifest.migrationsDir });
    await pool.query(`insert into core.conversations (id, agent_id) values ($1, 'developer')`, [CONVERSATION_ID]);

    root = await realpathish(await mkdtemp(path.join(tmpdir(), 'buddi-developer-secrets-')));
    workspace = path.join(root, 'project');
    other = path.join(root, 'elsewhere');
    alias = path.join(root, 'alias');
    await mkdir(workspace, { recursive: true });
    await mkdir(other, { recursive: true });
    await symlink(workspace, alias);
    // Process logs go under the temp data directory, not the owner's home.
    process.env.BUDDI_DATA_DIR = path.join(root, 'data');
    await mkdir(path.join(root, 'data'), { recursive: true });
    const toolchain = await captureToolchainPath();
    toolchainPath = toolchain;
    await writeFile(path.join(workspace, 'show.mjs'), SHOW);
    await writeFile(path.join(workspace, 'keep.mjs'), KEEP);
    await setWorkspaceDir(pool, 'developer', workspace, NOW, { toolchainPath, gitPath: '' });
  }, 120_000);

  beforeEach(async () => {
    vault = createMemoryVault();
    configurePluginHost({ vault });
    configureSecretScrubbing(pool, vault, process.env);
    registry = new ToolRegistry();
    // Core's own approval tool beside the plugin's: what an approved
    // first-time card runs, the way the gateway registers it.
    registry.register(createSecretsManifest());
    registry.register(manifest);
    await pool.query('truncate core.secrets, core.secret_uses, core.actions cascade');
  });

  afterEach(() => {
    resetPluginHost();
    resetSecretDestinations();
  });

  afterAll(async () => {
    setSecretScrubSource(null);
    await pool?.end().catch(() => {});
    if (admin) {
      await admin.query(`drop database if exists "${TEST_DB}"`).catch(() => {});
      await admin.end().catch(() => {});
    }
    if (root) await rm(root, { recursive: true, force: true });
    delete process.env.BUDDI_DATA_DIR;
  });

  it('registers developer.env from the manifest, and checks the exact workspace and variable', async () => {
    // Declared in the manifest beside `uses: ['secrets']`, so `register()` is
    // what stood it up; a use of it from another plugin is refused by core.
    expect(secretDestination(ENV_KIND)?.kind).toBe('developer.env');
    const host = contextFor('developer').buddi!;
    // The same directory spelled through a symlink, and the variable spelled
    // lower case: both normalise to the one target the binding names.
    expect(
      await envDestination.checkTarget(
        { workspace: alias, variable: 'admin_password' },
        { workspace, variable: 'ADMIN_PASSWORD' },
        host,
      ),
    ).toBe(true);
    // A different directory, a different variable, a name that is not a
    // variable name, and a target that is not a target at all.
    expect(
      await envDestination.checkTarget({ workspace: other, variable: 'ADMIN_PASSWORD' }, { workspace, variable: 'ADMIN_PASSWORD' }, host),
    ).toBe(false);
    expect(
      await envDestination.checkTarget({ workspace, variable: 'API_TOKEN' }, { workspace, variable: 'ADMIN_PASSWORD' }, host),
    ).toBe(false);
    expect(
      await envDestination.checkTarget({ workspace, variable: '2BAD' }, { workspace, variable: 'ADMIN_PASSWORD' }, host),
    ).toBe(false);
    expect(await envDestination.checkTarget('ADMIN_PASSWORD', { workspace, variable: 'ADMIN_PASSWORD' }, host)).toBe(false);
    // One line, for the card and the Settings row.
    expect(envDestination.describe({ workspace, variable: 'ADMIN_PASSWORD' })).toBe(
      `the ADMIN_PASSWORD variable of the workspace at ${workspace}`,
    );
  });

  it('delivers a bound secret through the area, and refuses another workspace', async () => {
    await bind(SECRET_NAME, VALUE, 'ADMIN_PASSWORD');
    const host = contextFor('developer').buddi!;
    const asked = await host.secrets!.use(SECRET_NAME, ENV_KIND, { workspace: alias, variable: 'admin_password' });
    expect(asked).toEqual({ done: true, use: expect.any(String) });
    // What `deliver` handed over is what the run that asked takes: the value,
    // and only there.
    expect(takeDelivered((asked as { use: string }).use)).toBe(VALUE);
    const elsewhere = await host.secrets!.use(SECRET_NAME, ENV_KIND, { workspace: other, variable: 'ADMIN_PASSWORD' });
    expect(elsewhere).toEqual({ refused: expect.stringContaining('is not bound to') });
    expect(JSON.stringify(elsewhere)).not.toContain(VALUE);
  });

  it("delivers the workspace's binding into a real child's environment, and nowhere else", async () => {
    await setMode(pool, 'developer', 'run', NOW);
    // Nothing bound yet: an ordinary run's result carries no secrets field.
    const quiet = await runResult('node show.mjs ADMIN_PASSWORD');
    expect(quiet.secrets).toBeUndefined();

    await bind(SECRET_NAME, VALUE, 'ADMIN_PASSWORD');

    // The child echoes the variable: the captured output is the scrubbed
    // form — the marker, never the value (acceptance 3, "a deliberate env
    // print shows ‹secret:…›").
    const echoed = await runResult('node show.mjs ADMIN_PASSWORD');
    expect(echoed.secrets).toEqual({ delivered: ['ADMIN_PASSWORD'], skipped: [] });
    expect(echoed.plain).toContain(`ADMIN_PASSWORD=‹secret:${SECRET_NAME}›`);
    expect(JSON.stringify(echoed)).not.toContain(VALUE);

    // And the child really saw the value: it wrote it to a file of its own,
    // which the test reads from disk, past every result and event.
    await runResult('node keep.mjs ADMIN_PASSWORD captured.txt');
    expect(await readFile(path.join(workspace, 'captured.txt'), 'utf8')).toBe(VALUE);

    // Every use is a row, and no row carries the value.
    const { rows } = await pool.query(`select * from core.secret_uses`);
    expect(rows.length).toBeGreaterThan(0);
    expect(JSON.stringify(rows)).not.toContain(VALUE);
  });

  it('starts a process with the binding in its environment, and no trace in the result', async () => {
    await bind(SECRET_NAME, VALUE, 'ADMIN_PASSWORD');
    const ctx = contextFor('developer');
    const start = await registry.invoke(
      'developer.start',
      { name: 'envy', command: 'node keep.mjs ADMIN_PASSWORD started.txt' },
      ctx,
    );
    expect(start.ok, JSON.stringify(start)).toBe(true);
    const result = (start as { output: { secrets: { delivered: string[]; skipped: unknown[] } } }).output;
    expect(result.secrets).toEqual({ delivered: ['ADMIN_PASSWORD'], skipped: [] });
    expect(JSON.stringify(result)).not.toContain(VALUE);
    // The process, not the result, is where the value went.
    let wrote = '';
    for (let i = 0; i < 50 && wrote === ''; i += 1) {
      wrote = await readFile(path.join(workspace, 'started.txt'), 'utf8').catch(() => '');
      if (wrote === '') await new Promise((resolve) => setTimeout(resolve, 100));
    }
    expect(wrote).toBe(VALUE);
    await stopProcess(ctx, 'developer', 'envy');
  }, 30_000);

  it("skips a variable waiting on the owner's card, and delivers it once decided", async () => {
    await setMode(pool, 'developer', 'run', NOW);
    await bind(TOKEN_NAME, TOKEN_VALUE, 'API_TOKEN', 'first-time');

    const first = await runResult('node keep.mjs API_TOKEN pending.txt');
    expect(first.secrets).toEqual({
      delivered: [],
      skipped: [{ variable: 'API_TOKEN', why: expect.stringContaining('the owner has a card') }],
    });
    expect(JSON.stringify(first)).not.toContain(TOKEN_VALUE);
    expect(await readFile(path.join(workspace, 'pending.txt'), 'utf8')).toBe('');

    // The card core drew: the destination's own words, naming the variable.
    const { rows } = await pool.query(`select id, canonical_args, preview from core.actions where tool = 'secrets.use'`);
    expect(rows).toHaveLength(1);
    expect(rows[0].preview).toContain(`the API_TOKEN variable of the workspace at ${workspace}`);
    expect(rows[0].canonical_args.secret).toBe(TOKEN_NAME);

    // The owner decides on any surface; the next run delivers.
    const actionId = String(rows[0].id);
    expect((await decideApproval(pool, { actionId, decision: 'approved', by: 'owner', via: 'web', now: NOW })).ok).toBe(true);
    const executed = await executeApproved(pool, { actionId, registry, ctx: contextFor('developer'), worker: 'test', now: NOW });
    expect(executed, JSON.stringify(executed)).toMatchObject({ ok: true });
    const second = await runResult('node keep.mjs API_TOKEN decided.txt');
    expect(second.secrets).toEqual({ delivered: ['API_TOKEN'], skipped: [] });
    expect(await readFile(path.join(workspace, 'decided.txt'), 'utf8')).toBe(TOKEN_VALUE);
  }, 30_000);

  it('skips a refused binding with a clean note, and never the refusal verbatim', async () => {
    await setMode(pool, 'developer', 'run', NOW);
    await putOwnerSecret(pool, vault, {
      name: 'Ghost token',
      value: 'ghost-value-0000',
      bindings: [{ kind: ENV_KIND, target: { workspace, variable: 'GHOST_TOKEN' }, rule: 'pre-approved' }],
    });
    // The binding stands; the value does not — the use refuses, and the note
    // in the result is the plugin's own sentence, not the refusal's.
    const { rows } = await pool.query(`select id from core.secrets where name = 'Ghost token'`);
    await vault.delete(ownerSecretVaultName(String(rows[0].id)));
    await primeSecretScrubber();

    const result = await runResult('node keep.mjs GHOST_TOKEN gone.txt');
    expect(result.secrets).toEqual({
      delivered: [],
      skipped: [{ variable: 'GHOST_TOKEN', why: 'the binding refused this use, so nothing was delivered' }],
    });
    expect(JSON.stringify(result)).not.toContain('ghost-value-0000');
    expect(await readFile(path.join(workspace, 'gone.txt'), 'utf8')).toBe('');
  });

  it('refuses content that carries a stored value, whatever the file', async () => {
    await setMode(pool, 'developer', 'edit', NOW);
    await bind(SECRET_NAME, VALUE, 'ADMIN_PASSWORD');

    // A `.env` headed for the workspace: refused, naming the secret to bind.
    const refused = await registry.invoke(
      'developer.write',
      { path: 'config/settings.env', content: `HOST=localhost\nADMIN_PASSWORD=${VALUE}\n` },
      contextFor('developer'),
    );
    expect(refused.ok).toBe(false);
    if (!refused.ok) {
      expect(refused.reason).toBe('tool-error');
      expect(refused.message).toContain(`‹secret:${SECRET_NAME}›`);
      expect(refused.message).toContain('Bind it instead');
    }
    await expect(lstat(path.join(workspace, 'config', 'settings.env'))).rejects.toThrow();

    // Not a `.env` at all — the file is never the test.
    const notes = await registry.invoke(
      'developer.write',
      { path: 'notes.md', content: `remember: ${VALUE}\n` },
      contextFor('developer'),
    );
    expect(notes.ok).toBe(false);
    await expect(lstat(path.join(workspace, 'notes.md'))).rejects.toThrow();

    // Ordinary `.env` configuration passes unchanged…
    expect(await call('developer.write', { path: '.env', content: 'PORT=3000\nHOST=localhost\nLOG_LEVEL=info\n' })).toMatchObject({
      created: true,
    });
    // …and so does prose that merely says the word password.
    expect(await call('developer.write', { path: 'notes.md', content: 'The password field is required.\n' })).toMatchObject({
      created: true,
    });
  });

  it('refuses the value at the card, so no approval is drawn for a write that cannot happen', async () => {
    await setMode(pool, 'developer', 'ask', NOW);
    await bind(SECRET_NAME, VALUE, 'ADMIN_PASSWORD');
    const refused = await registry.invoke(
      'developer.write',
      { path: 'settings.env', content: `ADMIN_PASSWORD=${VALUE}\n` },
      contextFor('developer'),
    );
    expect(refused.ok).toBe(false);
    if (!refused.ok) expect(refused.message).toContain(`‹secret:${SECRET_NAME}›`);
    // No card: describe said no before one was recorded.
    const { rows } = await pool.query(`select 1 from core.actions where tool = 'developer.write'`);
    expect(rows).toHaveLength(0);
    await setMode(pool, 'developer', 'edit', NOW);
  });

  it('refuses a value in an edit replacement, and lets the value be cleaned out of a file', async () => {
    await setMode(pool, 'developer', 'edit', NOW);
    await bind(SECRET_NAME, VALUE, 'ADMIN_PASSWORD');
    // The old story: the value is already in the file, written by hand before
    // the rule existed. Putting it back is refused…
    await writeFile(path.join(workspace, '.env'), `HOST=localhost\nADMIN_PASSWORD=${VALUE}\nPORT=3000\n`);
    const again = await registry.invoke(
      'developer.edit',
      { path: '.env', old: 'PORT=3000', new: `PORT=3000\nADMIN_PASSWORD=${VALUE}` },
      contextFor('developer'),
    );
    expect(again.ok).toBe(false);
    if (!again.ok) expect(again.message).toContain(`‹secret:${SECRET_NAME}›`);

    // …and deleting the line that carries it is not: the check is on what
    // goes into the file, so the value can always be cleaned back out.
    const cleaned = await call('developer.edit', {
      path: '.env',
      old: `ADMIN_PASSWORD=${VALUE}\n`,
      new: '# the password is bound, not written\n',
    });
    expect(cleaned.replacements).toBe(1);
    const after = await readFile(path.join(workspace, '.env'), 'utf8');
    expect(after).not.toContain(VALUE);
    expect(after).toContain('HOST=localhost');
  });

  it('degrades honestly when the owner\'s secrets are not available in this process', async () => {
    await setMode(pool, 'developer', 'run', NOW);
    await bind(SECRET_NAME, VALUE, 'ADMIN_PASSWORD');
    const ctx = contextFor('developer');

    // The secrets area absent: no delivery, one line in the result.
    const stripped = { ...ctx, buddi: { ...ctx.buddi, secrets: undefined } };
    const without = await toolNamed('developer.run').execute(
      { command: 'node show.mjs ADMIN_PASSWORD' },
      { ...stripped, actionId: 'degrade-1' },
    );
    expect(without.secrets).toEqual({
      delivered: [],
      skipped: [],
      note: 'owner secrets are not available in this process, so no variables were delivered.',
    });
    expect(without.plain).toContain('ADMIN_PASSWORD=');

    // And the same honesty when the listing itself cannot be read.
    const broken = {
      ...ctx,
      buddi: {
        ...ctx.buddi!,
        secrets: { ...ctx.buddi!.secrets!, list: async () => { throw new Error('no vault here'); } },
      },
    };
    const failed = await toolNamed('developer.run').execute(
      { command: 'node show.mjs ADMIN_PASSWORD' },
      { ...broken, actionId: 'degrade-2' },
    );
    expect(failed.secrets).toEqual({
      delivered: [],
      skipped: [],
      note: "the owner's secrets could not be read, so no variables were delivered.",
    });
    expect(JSON.stringify(failed)).not.toContain(VALUE);
  });
});