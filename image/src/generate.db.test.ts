/**
 * `image.generate` end to end on a real Postgres with core migrated: account
 * selection and its refusals, the per-conversation approval, provenance in
 * the Files library, references, and the daily cap. Backends are a fake
 * host image call and a local fake Images API server.
 *
 * Skipped without `DATABASE_URL`.
 */
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import type { Pool } from 'pg';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import {
  ToolRegistry, createPluginHost, createPool, decideApproval, executeApproved, hostBindingOf, runMigrations, saveArtifact,
  type ProviderAccountListing, type ProviderAccountsAccess, type CoreToolContext,
} from '@buddi/core/testing';
import { testDatabaseUrl } from '@buddi/core/testing';
import { manifest } from './index.js';
import { NO_ACCOUNT } from './generate.js';
import { setSettings } from './store.js';
import { PNG_1x1, pngOf } from './testing/fixtures.js';

const databaseUrl = await testDatabaseUrl();
const suite = databaseUrl ? describe : describe.skip;
const TEST_DB = `buddi_image_test_${process.pid}`;

// Stored before codex-direct: the gateway still lists gpt-5, which the image plugin neither shows nor sends.
const CODEX: ProviderAccountListing = { id: 'codex-1', label: 'ChatGPT Plus', kind: 'codex', enabled: true, configured: true, defaultModel: 'gpt-5' };
const LOCAL: ProviderAccountListing = { id: 'flux-1', label: 'Local FLUX', kind: 'openai-compatible', enabled: true, configured: true, defaultModel: 'llama3' };
const GEMINI: ProviderAccountListing = { id: 'gem-1', label: 'Gemini', kind: 'openai-compatible', enabled: true, configured: true, defaultModel: 'gemini-2.5-flash', baseUrl: 'https://generativelanguage.googleapis.com/v1beta/openai' };
const CLAUDE: ProviderAccountListing = { id: 'claude-1', label: 'Claude', kind: 'anthropic', enabled: true, configured: true, defaultModel: 'claude-sonnet-4-5' };

suite('image.generate (postgres)', () => {
  let admin: Pool;
  let pool: Pool;
  let dataDir: string;
  let server: http.Server;
  let base = '';
  let lastApi: { url: string; body: Buffer } | null = null;
  let accounts: ProviderAccountListing[] = [];
  let codexMode = 'png';
  const registry = new ToolRegistry();

  const providerAccounts: ProviderAccountsAccess = {
    list: () => accounts,
    resolve: async (id, model) => {
      if (id !== LOCAL.id) throw new Error('not an HTTP account');
      return { kind: 'openai', baseUrl: base, credentialKind: 'api-key', secret: 'sk-test', model, compatible: true };
    },
    withCodexProfile: async () => {
      throw new Error('the image plugin no longer stages a Codex profile');
    },
    generateCodexImage: async (id) => {
      if (id !== CODEX.id) throw new Error('This is not a Codex account.');
      return codexMode === 'png'
        ? { bytes: pngOf(640, 480), mime: 'image/png' }
        : { bytes: Buffer.from('I could not draw that, sorry.'), mime: 'image/png' };
    },
  };

  let conversationId = '';
  const ctx = (over: Partial<CoreToolContext> = {}): CoreToolContext => {
    const facts: CoreToolContext = {
      db: pool, ownerId: 'owner', now: () => new Date(), timezone: 'America/New_York',
      agentId: 'illustrator', conversationId, providerAccounts, ...over,
    };
    return { ...facts, buddi: createPluginHost(hostBindingOf(manifest), facts) };
  };

  beforeAll(async () => {
    dataDir = await mkdtemp(path.join(tmpdir(), 'buddi-image-data-'));
    process.env.BUDDI_DATA_DIR = dataDir;
    admin = createPool(databaseUrl as string);
    await admin.query(`drop database if exists ${TEST_DB}`);
    await admin.query(`create database ${TEST_DB}`);
    const url = new URL(databaseUrl as string);
    url.pathname = `/${TEST_DB}`;
    pool = createPool(url.toString());
    await runMigrations(pool, [manifest]);
    registry.register(manifest);
    server = http.createServer((req, res) => {
      const chunks: Buffer[] = [];
      req.on('data', (c: Buffer) => chunks.push(c));
      req.on('end', () => {
        lastApi = { url: req.url ?? '', body: Buffer.concat(chunks) };
        res.setHeader('content-type', 'application/json');
        res.end(JSON.stringify({ data: [{ b64_json: pngOf(1536, 1024).toString('base64') }] }));
      });
    });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    base = `http://127.0.0.1:${(server.address() as AddressInfo).port}/v1`;
  });

  afterAll(async () => {
    await pool?.end();
    await admin?.query(`drop database if exists ${TEST_DB}`);
    await admin?.end();
    server?.close();
    await rm(dataDir, { recursive: true, force: true });
  });

  beforeEach(async () => {
    accounts = [CODEX, LOCAL, GEMINI, CLAUDE];
    codexMode = 'png';
    await pool.query('delete from image.generation');
    await pool.query('delete from image.settings');
    // What choosing on Settings → Image (or migrations/002) leaves: the accounts bound to this plugin.
    await pool.query(
      `insert into core.plugin_account_bindings (plugin, account_id) select 'image', unnest($1::text[]) on conflict do nothing`,
      [[CODEX.id, LOCAL.id, GEMINI.id, CLAUDE.id]],
    );
    const { rows } = await pool.query(`insert into core.conversations (agent_id) values ('illustrator') returning id::text as id`);
    conversationId = (rows[0] as { id: string }).id;
  });

  const run = (args: unknown, over: Partial<CoreToolContext> = {}) => registry.invoke('image.generate', args, ctx(over));

  /** Straight to execute, as an approved action or a later call would. */
  const execute = (args: Record<string, unknown>, over: Partial<CoreToolContext> = {}) =>
    manifest.tools.find((t) => t.name === 'image.generate')!.execute(args as never, ctx(over)) as Promise<Record<string, unknown>>;

  it('refuses with how to connect an account when none can draw', async () => {
    accounts = [CLAUDE];
    await expect(execute({ prompt: 'a fox' })).rejects.toThrow(NO_ACCOUNT);
    accounts = [];
    await expect(execute({ prompt: 'a fox' })).rejects.toThrow(/Settings → Model accounts/);
    await expect(execute({ prompt: 'a fox' }, { providerAccounts: undefined })).rejects.toThrow(NO_ACCOUNT);
  });

  it('asks the owner to choose when accounts exist but none is chosen, and refuses a kind with no backend', async () => {
    await expect(execute({ prompt: 'a fox' })).rejects.toThrow(/no image account is chosen yet/);
    await setSettings(pool, { accountId: CLAUDE.id, model: null, dailyCap: 30 }, new Date());
    await expect(execute({ prompt: 'a fox' })).rejects.toThrow(/anthropic account, and there is no image backend/);
    accounts = [{ ...CODEX, configured: false }];
    await setSettings(pool, { accountId: CODEX.id, model: null, dailyCap: 30 }, new Date());
    await expect(execute({ prompt: 'a fox' })).rejects.toThrow(/is not connected. Connect it in Settings → Model accounts/);
  });

  it('refuses before any approval when there is no account to draw with, and raises no card', async () => {
    const cards = async () => (await pool.query(`select count(*)::int as n from core.actions where tool = 'image.generate'`)).rows[0].n as number;
    const before = await cards();
    expect(await run({ prompt: 'a fox' })).toEqual({
      ok: false, reason: 'tool-error',
      message: 'refused: no image account is chosen yet. The owner picks one in Settings → Image.',
    });
    accounts = [CLAUDE];
    expect(await run({ prompt: 'a fox' })).toEqual({ ok: false, reason: 'tool-error', message: NO_ACCOUNT });
    expect(await cards()).toBe(before);
  });

  it('the settings tool offers and accepts only accounts with a backend', async () => {
    const settings = manifest.tools.find((t) => t.name === 'image.set_settings')!;
    await expect(settings.execute({ account: CLAUDE.id, dailyCap: 30 } as never, ctx({ agentId: 'owner' }))).rejects.toThrow(/cannot make images/);
    const saved = (await settings.execute({ account: LOCAL.id, model: 'flux-dev', dailyCap: '12' } as never, ctx({ agentId: 'owner' }))) as { note: string };
    expect(saved.note).toMatch(/Local FLUX with flux-dev, up to 12 a day/);
    const query = manifest.queries!.find((q) => q.name === 'settings')!;
    const view = (await query.produce({}, ctx())) as { choices: Array<{ id: string; label: string }>; account: string; dailyCap: number };
    expect(view.choices).toEqual([
      { id: CODEX.id, label: 'ChatGPT Plus — ChatGPT subscription, default model gpt-5.5 (ready)' },
      { id: LOCAL.id, label: 'Local FLUX — OpenAI-compatible Images API, set a model (untested)' },
      { id: GEMINI.id, label: 'Gemini — Gemini (Imagen), default model imagen-4.0-generate-001 (ready)' },
    ]);
    expect(view).toMatchObject({ account: LOCAL.id, dailyCap: 12 });
  });

  it('shows a compatible server as untested, with no chat model as its default, until one picture came back', async () => {
    const query = manifest.queries!.find((q) => q.name === 'settings')!;
    type Row = { id: string; defaultModel: string; state: string };
    const rows = async () => ((await query.produce({}, ctx())) as { accounts: Row[] }).accounts;
    const local = async () => (await rows()).find((r) => r.id === LOCAL.id)!;
    expect(await local()).toMatchObject({ defaultModel: 'set a model', state: 'untested' });
    // The ChatGPT account shows the image default, not the stale gpt-5 the gateway lists.
    expect((await rows()).find((r) => r.id === CODEX.id)).toMatchObject({ defaultModel: 'gpt-5.5', state: 'ready' });
    expect((await rows()).find((r) => r.id === GEMINI.id)).toMatchObject({ defaultModel: 'imagen-4.0-generate-001', state: 'ready' });

    // A failed call leaves it untested.
    await setSettings(pool, { accountId: LOCAL.id, model: 'flux-dev', dailyCap: 30 }, new Date());
    const ref = await saveArtifact(pool, { bytes: Buffer.from('not a picture'), mime: 'image/png', filename: 'x.png', createdBy: 'owner' });
    await expect(execute({ prompt: 'x', references: [ref.id] })).rejects.toThrow(/is not an image/);
    expect((await local()).state).toBe('untested');

    await execute({ prompt: 'a fox' });
    expect(await local()).toMatchObject({ defaultModel: 'set a model', state: 'ready' });
    // Disabled still says so, whatever it drew before.
    accounts = [CODEX, { ...LOCAL, enabled: false }, GEMINI, CLAUDE];
    expect((await local()).state).toBe('disabled');
  });

  it('the first call in a conversation is a card; approved, it stores the image with provenance; the next one runs', async () => {
    await setSettings(pool, { accountId: CODEX.id, model: null, dailyCap: 30 }, new Date());
    const first = await run({ prompt: 'A red fox asleep on a mossy stone', name: 'Sleeping fox', aspect: 'landscape' });
    expect(first).toMatchObject({ ok: false, reason: 'approval-required' });
    const actionId = (first as { actionId: string }).actionId;
    expect((first as { preview: string }).preview).toMatch(/^Generate one landscape image with ChatGPT Plus · gpt-5.5: "A red fox/);
    await decideApproval(pool, { actionId, decision: 'approved', by: 'owner', via: 'web' });
    const done = await executeApproved(pool, { actionId, registry, ctx: ctx(), worker: 'test' });
    expect(done).toMatchObject({ ok: true });
    const output = (done as unknown as { result: Record<string, unknown> }).result;
    expect(output).toMatchObject({ name: 'sleeping-fox.png', width: 640, height: 480, backend: 'codex', account: 'ChatGPT Plus', model: 'gpt-5.5' });
    expect(output.forAgent).toMatch(/You have not seen it/);
    expect(output.forAgent).toMatch(/starting "I asked for…".*never "I generated"/);
    expect(output.prompt).toBe('A red fox asleep on a mossy stone');
    expect(output).not.toHaveProperty('note');

    const { rows } = await pool.query(`select created_by, conversation_id::text, caption, mime from core.artifacts where id = $1`, [output.id]);
    expect(rows[0]).toMatchObject({ created_by: 'illustrator', conversation_id: conversationId, mime: 'image/png' });
    expect(rows[0].caption).toContain('A red fox asleep on a mossy stone');
    const gen = await pool.query(`select agent_id, conversation_id::text, prompt, backend, account_id, model from image.generation where artifact_id = $1`, [output.id]);
    expect(gen.rows[0]).toEqual({ agent_id: 'illustrator', conversation_id: conversationId, prompt: 'A red fox asleep on a mossy stone', backend: 'codex', account_id: CODEX.id, model: 'gpt-5.5' });

    const second = await run({ prompt: 'The same fox, awake' });
    expect(second).toMatchObject({ ok: true });
    // A colleague this conversation delegated to runs too…
    const { rows: child } = await pool.query(`insert into core.conversations (agent_id) values ('illustrator') returning id::text as id`);
    await pool.query(`insert into core.events (kind, conversation_id, payload) values ('delegation.started', $1, $2::jsonb)`,
      [conversationId, JSON.stringify({ from: 'buddy', to: 'illustrator', conversationId: child[0].id })]);
    expect(await run({ prompt: 'a third fox' }, { conversationId: child[0].id })).toMatchObject({ ok: true });
    // …and a new conversation asks again.
    const { rows: other } = await pool.query(`insert into core.conversations (agent_id) values ('illustrator') returning id::text as id`);
    expect(await run({ prompt: 'a fox' }, { conversationId: other[0].id })).toMatchObject({ reason: 'approval-required' });
  });

  it('an image approved in a delegated conversation lets the next delegation from the same asking conversation run', async () => {
    await setSettings(pool, { accountId: CODEX.id, model: null, dailyCap: 30 }, new Date());
    // The asking conversation, and two colleague conversations it opened —
    // the owner's case: @playground asked @art twice in one thread.
    const { rows: asker } = await pool.query(`insert into core.conversations (agent_id) values ('playground') returning id::text as id`);
    const opened = async (): Promise<string> => {
      const { rows } = await pool.query(`insert into core.conversations (agent_id) values ('illustrator') returning id::text as id`);
      await pool.query(`insert into core.events (kind, conversation_id, payload) values ('delegation.started', $1, $2::jsonb)`,
        [asker[0].id, JSON.stringify({ from: 'playground', to: 'illustrator', conversationId: rows[0].id })]);
      return rows[0].id as string;
    };
    const first = await opened();
    const card = await run({ prompt: 'a fisherman' }, { conversationId: first });
    expect(card).toMatchObject({ reason: 'approval-required' });
    // Approved in the asker's dock: the same row, decided once.
    await decideApproval(pool, { actionId: (card as { actionId: string }).actionId, decision: 'approved', by: 'owner', via: 'web' });
    expect(await run({ prompt: 'a boat' }, { conversationId: await opened() })).toMatchObject({ ok: true });
  });

  it('refuses what the ChatGPT subscription returned when it is not an image, and stores nothing', async () => {
    await setSettings(pool, { accountId: CODEX.id, model: null, dailyCap: 30 }, new Date());
    codexMode = 'text';
    await expect(execute({ prompt: 'a fox' })).rejects.toThrow(/not an image/);
    expect((await pool.query('select count(*)::int as n from image.generation')).rows[0].n).toBe(0);
  });

  it('sends library references to an OpenAI-compatible account as an edit, and refuses an id that is not an image', async () => {
    await setSettings(pool, { accountId: LOCAL.id, model: 'flux-dev', dailyCap: 30 }, new Date());
    const ref = await saveArtifact(pool, { bytes: PNG_1x1, mime: 'image/png', filename: 'fox.png', createdBy: 'owner' });
    const out = await execute({ prompt: 'same fox, new pose', references: [ref.id] });
    expect(lastApi!.url).toBe('/v1/images/edits');
    expect(lastApi!.body.includes(PNG_1x1)).toBe(true);
    expect(out).toMatchObject({ backend: 'openai-compatible', account: 'Local FLUX', model: 'flux-dev', width: 1536, height: 1024 });
    const gen = await pool.query(`select reference_ids::text[] as refs from image.generation where artifact_id = $1`, [out.id]);
    expect(gen.rows[0].refs).toEqual([ref.id]);

    const text = await saveArtifact(pool, { bytes: Buffer.from('not a picture'), mime: 'image/png', filename: 'liar.png', createdBy: 'owner' });
    await expect(execute({ prompt: 'x', references: [text.id] })).rejects.toThrow(/is not an image/);
    await expect(execute({ prompt: 'x', references: ['00000000-0000-4000-8000-000000000000'] })).rejects.toThrow(/not a file in the Files library/);
    await expect(run({ prompt: 'x', references: ['a', 'b', 'c', 'd', 'e'] })).resolves.toMatchObject({ reason: 'invalid-args' });
  });

  it('refuses beyond the daily cap, with the count', async () => {
    await setSettings(pool, { accountId: LOCAL.id, model: null, dailyCap: 2 }, new Date());
    await execute({ prompt: 'one' });
    await execute({ prompt: 'two' });
    await expect(execute({ prompt: 'three' })).rejects.toThrow(/2 images have been made today, and the daily limit is 2/);
  });
});
