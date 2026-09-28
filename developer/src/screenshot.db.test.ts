/**
 * `developer.screenshot` end to end: a real Postgres with core migrated (the
 * Files library is `core.artifacts`), a real process the agent started, and a
 * real headless Chromium when this machine has one.
 *
 * Skipped without `DATABASE_URL`. The one test that needs Chromium says so
 * and skips when it is not installed.
 */
import http from 'node:http';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import type { Pool } from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { ToolRegistry, createPool, resolveDataDir, runMigrations, createPluginHost, hostBindingOf } from '@buddi/core/testing';
import type { CoreToolContext } from '@buddi/core/testing';
import { testDatabaseUrl } from '@buddi/core/testing';
import { manifest } from './index.js';
import { realpathish } from './paths.js';
import { captureToolchainPath, resolveProgram } from './exec.js';
import { ensureHooksDir } from './runtime.js';
import { setWorkspaceDir, getWorkspace, type Workspace } from './store.js';
import { startProcess, stopAllFor, watchForPort } from './processes.js';
import { CHROMIUM_INSTALL_COMMAND, chromiumAvailable } from './screenshot.js';

const databaseUrl = await testDatabaseUrl();
const suite = databaseUrl ? describe : describe.skip;
const haveChromium = await chromiumAvailable();
if (!haveChromium) {
  console.warn(
    `developer.screenshot: no Chromium on this machine, so the real screenshot is skipped. ` +
      `Install it with \`${CHROMIUM_INSTALL_COMMAND}\`.`,
  );
}

const TEST_DB = `buddi_developer_shot_test_${process.pid}`;
const PORT = 46110;

/** A page with one thing of its own and one thing from elsewhere. */
const SERVER = `
import http from 'node:http';
const port = Number(process.argv[2]);
http.createServer((req, res) => {
  if (req.url === '/style.css') { res.setHeader('content-type', 'text/css'); return res.end('body{background:#c00}'); }
  res.setHeader('content-type', 'text/html');
  res.end('<!doctype html><link rel="stylesheet" href="/style.css"><h1>hello</h1><img src="http://example.com/x.png">');
}).listen(port, '127.0.0.1', () => console.log('listening on port ' + port));
`;

suite('developer.screenshot (postgres)', () => {
  let admin: Pool;
  let pool: Pool;
  let root: string;
  let foreign: http.Server;
  let foreignPort = 0;
  const registry = new ToolRegistry();

  const ctx = (): CoreToolContext => {
    const facts: CoreToolContext = {
      db: pool,
      ownerId: 'test',
      now: () => new Date(),
      timezone: 'UTC',
      agentId: 'developer',
      conversationId: 'conversation-1',
      sessionTools: manifest.tools.map((tool) => tool.name),
      ownerRequest: { id: 'request-1', text: 'look at it', expiresAt: Date.now() + 600_000 },
    };
    return { ...facts, buddi: createPluginHost(hostBindingOf(manifest), facts) };
  };

  const invoke = (args: unknown) => registry.invoke('developer.screenshot', args, ctx());

  beforeAll(async () => {
    admin = createPool(databaseUrl as string);
    await admin.query(`drop database if exists ${TEST_DB}`);
    await admin.query(`create database ${TEST_DB}`);
    const url = new URL(databaseUrl as string);
    url.pathname = `/${TEST_DB}`;
    pool = createPool(url.toString());
    // Core and this plugin: the library record lives in core.artifacts.
    await runMigrations(pool, [manifest]);
    registry.register(manifest);

    root = await realpathish(await mkdtemp(path.join(tmpdir(), 'buddi-developer-shot-')));
    const workspace = path.join(root, 'project');
    await mkdir(workspace, { recursive: true });
    await mkdir(path.join(root, 'data'), { recursive: true });
    process.env.BUDDI_DATA_DIR = path.join(root, 'data');
    await ensureHooksDir();
    await writeFile(path.join(workspace, 'server.mjs'), SERVER);
    const toolchainPath = await captureToolchainPath();
    const gitPath = (await resolveProgram('git', toolchainPath)) ?? '';
    await setWorkspaceDir(pool, 'developer', workspace, new Date(), { toolchainPath, gitPath });
    const ws = (await getWorkspace(pool, 'developer')) as Workspace;

    const started = await startProcess(
      ctx(),
      'developer',
      ws,
      { name: 'web', command: `node server.mjs ${PORT}` },
      { tailscaleRoutes: false, settleMs: 0 },
    );
    const port = await watchForPort(ctx(), 'developer', started.process, {}, { everyMs: 150, watchMs: 20_000 });
    expect(port).toBe(PORT);

    // A server on this machine that is not the agent's: the test runner's own.
    foreign = http.createServer((_req, res) => res.end('not yours'));
    await new Promise<void>((resolve) => foreign.listen(0, '127.0.0.1', resolve));
    foreignPort = (foreign.address() as { port: number }).port;
  }, 60_000);

  afterAll(async () => {
    if (pool) await stopAllFor(ctx(), 'developer').catch(() => {});
    foreign?.close();
    await pool?.end();
    if (admin) {
      await admin.query(`drop database if exists ${TEST_DB}`);
      await admin.end();
    }
    if (root) await rm(root, { recursive: true, force: true });
  });

  it('is a read: auto in every mode, declared session', async () => {
    const tool = manifest.tools.find((candidate) => candidate.name === 'developer.screenshot');
    expect(tool?.tier).toBe('session');
    expect(await tool?.tierFor?.({ name: 'web' }, ctx())).toMatchObject({ tier: 'auto' });
  });

  it('refuses a port its process tree does not hold', async () => {
    const result = await invoke({ name: 'web', port: foreignPort });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.message).toContain(`port ${foreignPort} is not one web is listening on`);
      expect(result.message).toContain(`it holds ${PORT}`);
    }
    const database = await invoke({ name: 'web', port: 5432 });
    expect(database.ok).toBe(false);
    const nobody = await invoke({ name: 'nobody' });
    expect(nobody.ok).toBe(false);
    if (!nobody.ok) expect(nobody.message).toContain('no process called nobody');
  });

  it('refuses a URL, in the path or as an argument of its own', async () => {
    for (const bad of ['http://example.com/', `http://127.0.0.1:${foreignPort}/`, '//example.com/']) {
      const result = await invoke({ name: 'web', path: bad });
      expect(result.ok, bad).toBe(false);
      if (!result.ok) expect(result.message).toContain('takes no URL and no host');
    }
    for (const extra of [{ url: 'http://example.com/' }, { host: 'example.com' }]) {
      const result = await invoke({ name: 'web', ...extra });
      expect(result.ok).toBe(false);
    }
    const count = await pool.query('select count(*)::int as n from core.artifacts');
    expect(count.rows[0].n).toBe(0);
  });

  it.skipIf(!haveChromium)(
    'takes a real screenshot of its own server, blocks the rest, and keeps it in the Files library',
    async () => {
      const result = await invoke({ name: 'web', path: '/', width: 800, height: 600 });
      if (!result.ok) throw new Error(result.message);
      const output = result.output as Record<string, any>;
      expect(output).toMatchObject({
        name: 'web',
        port: PORT,
        path: '/',
        viewport: { width: 800, height: 600 },
        fullPage: false,
        status: 200,
        loaded: true,
      });
      expect(output.blocked).toBeGreaterThanOrEqual(1);
      expect(output.artifacts).toEqual([{ id: output.id }]);
      expect(output.id).toMatch(/^[0-9a-f-]{36}$/);
      expect(output.note).toContain('Files library');

      const { rows } = await pool.query(
        'select mime, kind, size_bytes, created_by, storage_path, filename from core.artifacts where id = $1',
        [output.id],
      );
      expect(rows[0]).toMatchObject({
        mime: 'image/png',
        kind: 'image',
        created_by: 'developer',
        filename: `web-${PORT}-root.png`,
      });
      expect(Number(rows[0].size_bytes)).toBe(output.sizeBytes);
      const bytes = await readFile(path.join(resolveDataDir(), rows[0].storage_path));
      expect(bytes.subarray(0, 8)).toEqual(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]));
      // PNG IHDR: width then height, big-endian.
      expect(bytes.readUInt32BE(16)).toBe(800);
      expect(bytes.readUInt32BE(20)).toBe(600);
    },
    60_000,
  );
});
