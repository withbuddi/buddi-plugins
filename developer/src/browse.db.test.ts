/**
 * The Files tab's reads, against a real Postgres and a real temp directory:
 * run through `pageQueryContext`, the read-only context the gateway hands
 * every page query, so "cannot write" holds here exactly as it does live.
 */
import { execFile } from 'node:child_process';
import { mkdtemp, mkdir, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';
import type { Pool } from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { QueryRefusal, createPluginHost, createPool, hostBindingOf, isPageFile, migrate, pageQueryContext, type PageFile, type CoreToolContext } from '@buddi/core/testing';
import { testDatabaseUrl } from '@buddi/core/testing';
import { manifest } from './index.js';
import { ARCHIVE_LIMITS } from './archive.js';
import { realpathish } from './paths.js';
import { setWorkspaceDir } from './store.js';

const run = promisify(execFile);
const databaseUrl = await testDatabaseUrl();
const suite = databaseUrl ? describe : describe.skip;
const TEST_DB = `buddi_developer_browse_${process.pid}`;

/** A 1×1 PNG: the header is what matters. */
const PNG = Buffer.from(
  '89504e470d0a1a0a0000000d49484452000000010000000108060000001f15c4890000000d49444154789c6360000002000100' +
    '05fe02fe0000000049454e44ae426082',
  'hex',
);

suite('the Files tab queries (postgres)', () => {
  let admin: Pool;
  let pool: Pool;
  let root: string;
  let workspace: string;
  let outside: string;

  const ctx = (): CoreToolContext => {
    const facts = pageQueryContext({ db: pool, ownerId: 'test', now: () => new Date(), timezone: 'UTC' });
    return { ...facts, buddi: createPluginHost(hostBindingOf(manifest), facts) };
  };

  const ask = async (name: string, params: Record<string, string>): Promise<any> => {
    const query = manifest.queries!.find((q) => q.name === name)!;
    return query.produce(query.params.parse(params), ctx());
  };

  const bytesOf = async (file: PageFile): Promise<Buffer> => {
    if (Buffer.isBuffer(file.body)) return file.body;
    const chunks: Buffer[] = [];
    for await (const chunk of file.body as AsyncIterable<Buffer>) chunks.push(chunk);
    return Buffer.concat(chunks);
  };

  beforeAll(async () => {
    admin = createPool(databaseUrl as string);
    await admin.query(`drop database if exists ${TEST_DB}`);
    await admin.query(`create database ${TEST_DB}`);
    const url = new URL(databaseUrl as string);
    url.pathname = `/${TEST_DB}`;
    pool = createPool(url.toString());
    await migrate(pool, { schema: manifest.schema, dir: manifest.migrationsDir });

    root = await realpathish(await mkdtemp(path.join(tmpdir(), 'buddi-developer-browse-')));
    workspace = path.join(root, 'site');
    outside = path.join(root, 'outside');
    await mkdir(path.join(workspace, 'src', 'deep'), { recursive: true });
    await mkdir(outside, { recursive: true });
    await writeFile(path.join(workspace, 'index.html'), '<h1>hello</h1>\n');
    await writeFile(path.join(workspace, 'src', 'app.ts'), 'export const a = 1;\n');
    await writeFile(path.join(workspace, 'src', 'deep', 'b.ts'), 'export const b = 2;\n');
    await writeFile(path.join(workspace, 'logo.png'), PNG);
    await writeFile(path.join(workspace, 'doc.pdf'), '%PDF-1.4\n%%EOF\n');
    await writeFile(path.join(workspace, 'blob.bin'), Buffer.from([0, 1, 2, 3]));
    await writeFile(path.join(outside, 'secret.txt'), 'not yours\n');
    await symlink(path.join(outside, 'secret.txt'), path.join(workspace, 'link.txt'));
    await symlink(outside, path.join(workspace, 'escape'));
    await setWorkspaceDir(pool, 'developer', workspace, new Date(), { toolchainPath: process.env.PATH ?? '', gitPath: '' });
  }, 60_000);

  afterAll(async () => {
    await pool?.end();
    if (admin) {
      await admin.query(`drop database if exists ${TEST_DB}`);
      await admin.end();
    }
    if (root) await rm(root, { recursive: true, force: true });
  });

  it('names the queries it reads a workspace with, each a query of its own', () => {
    const names = new Set(manifest.queries!.map((q) => q.name));
    for (const name of Object.values(manifest.files!)) expect(names.has(name)).toBe(true);
  });

  it('says which agent has a workspace and which has none', async () => {
    expect(await ask(manifest.files!.workspace, { agent: 'developer' })).toEqual({
      workspace: { name: 'site', dir: workspace },
    });
    expect(await ask(manifest.files!.workspace, { agent: 'finance' })).toEqual({ workspace: null });
  });

  it('lists one folder, folders first, and skips a link rather than listing it', async () => {
    const listed = await ask(manifest.files!.list, { agent: 'developer' });
    expect(listed.path).toBe('');
    expect(listed.entries.map((e: { name: string }) => e.name)).toEqual([
      'src',
      'blob.bin',
      'doc.pdf',
      'index.html',
      'logo.png',
    ]);
    expect(listed.skipped).toBe(2);
    const src = await ask(manifest.files!.list, { agent: 'developer', path: 'src' });
    expect(src.entries.map((e: { path: string }) => e.path)).toEqual(['src/deep', 'src/app.ts']);
    const file = src.entries.find((e: { name: string }) => e.name === 'app.ts');
    expect(file.bytes).toBe(20);
    expect(typeof file.mtimeMs).toBe('number');
  });

  it('refuses a path that leaves the workspace, by "..", by an absolute path or through a link', async () => {
    for (const bad of ['..', '../outside', outside, 'escape', 'escape/secret.txt']) {
      await expect(ask(manifest.files!.list, { agent: 'developer', path: bad })).rejects.toBeInstanceOf(QueryRefusal);
    }
    for (const bad of ['../outside/secret.txt', path.join(outside, 'secret.txt'), 'link.txt', 'escape/secret.txt']) {
      await expect(ask(manifest.files!.read, { agent: 'developer', path: bad })).rejects.toBeInstanceOf(QueryRefusal);
      await expect(ask(manifest.files!.stat, { agent: 'developer', path: bad })).rejects.toBeInstanceOf(QueryRefusal);
    }
    await expect(ask(manifest.files!.archive, { agent: 'developer', path: 'escape' })).rejects.toBeInstanceOf(QueryRefusal);
  });

  it('refuses an agent that has no workspace', async () => {
    await expect(ask(manifest.files!.list, { agent: 'finance' })).rejects.toThrow(/no workspace/);
  });

  it('says what each file is, with its size and when it was written', async () => {
    const types = async (p: string) => (await ask(manifest.files!.stat, { agent: 'developer', path: p })).type;
    expect(await types('index.html')).toBe('text');
    expect(await types('logo.png')).toBe('image');
    expect(await types('doc.pdf')).toBe('pdf');
    expect(await types('blob.bin')).toBe('other');
    const stat = await ask(manifest.files!.stat, { agent: 'developer', path: 'src/app.ts' });
    expect(stat).toMatchObject({ path: 'src/app.ts', name: 'app.ts', bytes: 20, mime: 'text/plain; charset=utf-8' });
  });

  it('reads a file as bytes, inline or as a download, cacheable only when versioned', async () => {
    const shown = await ask(manifest.files!.read, { agent: 'developer', path: 'logo.png', v: '70-1' });
    expect(isPageFile(shown)).toBe(true);
    expect(shown).toMatchObject({ contentType: 'image/png', disposition: 'inline', filename: 'logo.png', size: PNG.length, immutable: true });
    expect((await bytesOf(shown)).equals(PNG)).toBe(true);
    const saved = await ask(manifest.files!.read, { agent: 'developer', path: 'index.html', download: '1' });
    expect(saved).toMatchObject({ disposition: 'attachment', immutable: false });
    expect((await bytesOf(saved)).toString()).toBe('<h1>hello</h1>\n');
    await expect(ask(manifest.files!.read, { agent: 'developer', path: 'src' })).rejects.toBeInstanceOf(QueryRefusal);
  });

  it('zips a folder, links left out, and unzip reads it back', async () => {
    const archive: PageFile = await ask(manifest.files!.archive, { agent: 'developer', path: 'src' });
    expect(archive).toMatchObject({ contentType: 'application/zip', disposition: 'attachment', filename: 'src.zip' });
    const file = path.join(root, 'src.zip');
    await writeFile(file, await bytesOf(archive));
    const { stdout } = await run('unzip', ['-Z1', file]);
    expect(stdout.trim().split('\n').sort()).toEqual(['app.ts', 'deep/b.ts']);
    await run('unzip', ['-o', '-q', file, '-d', path.join(root, 'unzipped')]);
    expect(await readFile(path.join(root, 'unzipped', 'deep', 'b.ts'), 'utf8')).toBe('export const b = 2;\n');

    const whole: PageFile = await ask(manifest.files!.archive, { agent: 'developer' });
    await writeFile(file, await bytesOf(whole));
    const listed = (await run('unzip', ['-Z1', file])).stdout;
    expect(listed).not.toMatch(/secret|link\.txt/);
  });

  it('refuses an archive over the cap, naming the cap', async () => {
    const before = { ...ARCHIVE_LIMITS };
    try {
      ARCHIVE_LIMITS.files = 2;
      await expect(ask(manifest.files!.archive, { agent: 'developer' })).rejects.toThrow(/archive cap of 100 MB or 2 files/);
      ARCHIVE_LIMITS.files = before.files;
      ARCHIVE_LIMITS.bytes = 10;
      await expect(ask(manifest.files!.archive, { agent: 'developer' })).rejects.toThrow(/archive cap/);
    } finally {
      Object.assign(ARCHIVE_LIMITS, before);
    }
  });

  it('refuses a parameter the query does not know', () => {
    const query = manifest.queries!.find((q) => q.name === manifest.files!.read)!;
    expect(query.params.safeParse({ agent: 'developer', path: 'a', extra: '1' }).success).toBe(false);
    expect(query.params.safeParse({ agent: '../x', path: 'a' }).success).toBe(false);
  });
});
