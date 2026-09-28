/**
 * The speech tools and the page end to end on a real Postgres with core
 * migrated: the owner's choices and their refusals, the per-conversation
 * approval, the Files library, the caps, and the page's queries, Test and
 * play buttons. The backend is a local fake OpenAI audio server.
 *
 * Skipped without `DATABASE_URL`.
 */
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import type { Pool } from 'pg';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import {
  ToolRegistry, createPluginHost, createPool, decideApproval, executeApproved, hostBindingOf, runMigrations, saveArtifact,
  testDatabaseUrl, type CoreToolContext, type ProviderAccountListing, type ProviderAccountsAccess,
} from '@buddi/core/testing';
import { manifest } from './index.js';
import { NOT_SET } from './choose.js';
import { clearModelCache } from './backends/openai.js';
import { getSettings, recordUsage, setSettings, type Settings } from './store.js';
import { fakeAudioServer, fakeInstalled, freshVoice, OGG_CLIP, type FakeAudioServer } from './testing/fixtures.js';

const databaseUrl = await testDatabaseUrl();
const suite = databaseUrl ? describe : describe.skip;
const TEST_DB = `buddi_speech_test_${process.pid}`;

const OPENAI: ProviderAccountListing = { id: 'oa-1', label: 'OpenAI key', kind: 'openai', enabled: true, configured: true, defaultModel: 'gpt-5' };
const LOCAL: ProviderAccountListing = { id: 'local-1', label: 'speaches', kind: 'openai-compatible', enabled: true, configured: true, defaultModel: 'llama3' };
const OLLAMA: ProviderAccountListing = { id: 'ollama-1', label: 'Ollama Cloud', kind: 'openai-compatible', enabled: true, configured: true, defaultModel: 'gpt-oss' };
const CODEX: ProviderAccountListing = { id: 'codex-1', label: 'ChatGPT Plus', kind: 'codex', enabled: true, configured: true, defaultModel: 'gpt-5.6' };
const CLAUDE: ProviderAccountListing = { id: 'claude-1', label: 'Claude', kind: 'anthropic', enabled: true, configured: true, defaultModel: 'claude-sonnet-5' };

const settingsWith = (over: { listen?: Partial<Settings['listening']>; speak?: Partial<Settings['speaking']>; transcribeCap?: number; sayCap?: number }): Settings => ({
  listening: { backend: null, accountId: null, model: null, languages: [], ...over.listen },
  speaking: { backend: null, accountId: null, model: null, voice: null, voices: {}, ...over.speak },
  transcribeCap: over.transcribeCap ?? 200,
  sayCap: over.sayCap ?? 200,
});

suite('speech tools (postgres)', () => {
  let admin: Pool;
  let pool: Pool;
  let dataDir: string;
  let fake: FakeAudioServer;
  let accounts: ProviderAccountListing[] = [];
  const registry = new ToolRegistry();

  const providerAccounts: ProviderAccountsAccess = {
    list: () => accounts,
    generateCodexImage: async () => {
      throw new Error('speech makes no images');
    },
    resolve: async (id, model) => ({
      kind: 'openai', baseUrl: id === OLLAMA.id ? 'https://ollama.com/v1' : fake.base, credentialKind: 'api-key', secret: 'sk-test', model,
      ...(id === OPENAI.id ? {} : { compatible: true }),
    }),
    withCodexProfile: async () => { throw new Error('not here'); },
  };

  let conversationId = '';
  const ctx = (over: Partial<CoreToolContext> = {}): CoreToolContext => {
    const facts: CoreToolContext = {
      db: pool, ownerId: 'owner', now: () => new Date(), timezone: 'Europe/Paris',
      agentId: 'buddy', conversationId, providerAccounts, ...over,
    };
    return { ...facts, buddi: createPluginHost(hostBindingOf(manifest), facts) };
  };
  const owner = () => ctx({ agentId: 'owner', conversationId: undefined });
  const tool = (name: string) => manifest.tools.find((t) => t.name === name)!;
  const run = (name: string, args: unknown, over: Partial<CoreToolContext> = {}) => registry.invoke(name, args, ctx(over));
  const execute = (name: string, args: Record<string, unknown>, over: Partial<CoreToolContext> = {}) =>
    tool(name).execute(args as never, ctx(over)) as Promise<Record<string, unknown>>;
  const query = (name: string, params: Record<string, unknown> = {}) =>
    manifest.queries!.find((q) => q.name === name)!.produce(params, ctx()) as Promise<Record<string, unknown>>;

  beforeAll(async () => {
    dataDir = await mkdtemp(path.join(tmpdir(), 'buddi-speech-data-'));
    process.env.BUDDI_DATA_DIR = dataDir;
    admin = createPool(databaseUrl as string);
    await admin.query(`drop database if exists ${TEST_DB}`);
    await admin.query(`create database ${TEST_DB}`);
    const url = new URL(databaseUrl as string);
    url.pathname = `/${TEST_DB}`;
    pool = createPool(url.toString());
    await runMigrations(pool, [manifest]);
    registry.register(manifest);
    fake = await fakeAudioServer();
  });

  afterAll(async () => {
    await pool?.end();
    await admin?.query(`drop database if exists ${TEST_DB}`);
    await admin?.end();
    await fake?.close();
    await rm(dataDir, { recursive: true, force: true });
  });

  beforeEach(async () => {
    accounts = [OPENAI, LOCAL, OLLAMA, CODEX, CLAUDE];
    fake.seen.length = 0;
    fake.answer = (req) => req.url.endsWith('/audio/speech')
      ? { status: 200, type: 'audio/ogg', body: freshVoice() }
      : { status: 200, body: JSON.stringify({ text: 'Hello from buddi. This is a test.' }) };
    await pool.query('delete from speech.usage');
    await pool.query('delete from speech.settings');
    await pool.query('delete from core.plugin_account_bindings');
    const { rows } = await pool.query(`insert into core.conversations (agent_id) values ('buddy') returning id::text as id`);
    conversationId = (rows[0] as { id: string }).id;
  });

  /** What choosing on the page leaves: the settings, and the account bound. */
  const choose = async (s: Settings) => {
    await setSettings(pool, s, new Date());
    for (const id of [s.listening.accountId, s.speaking.accountId]) {
      if (id) await pool.query(`insert into core.plugin_account_bindings (plugin, account_id) values ('speech', $1) on conflict do nothing`, [id]);
    }
  };

  const voiceNote = () => saveArtifact(pool, { bytes: OGG_CLIP, mime: 'audio/ogg', filename: 'voice.ogg', createdBy: 'owner' });

  it('refuses with one sentence naming Settings → Speech when nothing is set up, and raises no card', async () => {
    const note = await voiceNote();
    expect(await run('speech.transcribe', { artifactId: note.id })).toEqual({ ok: false, reason: 'tool-error', message: NOT_SET.listening });
    expect(await run('speech.say', { text: 'hi' })).toEqual({ ok: false, reason: 'tool-error', message: NOT_SET.speaking });
    const cards = await pool.query(`select count(*)::int as n from core.actions where tool like 'speech.%'`);
    expect(cards.rows[0].n).toBe(0);
    await choose(settingsWith({ listen: { backend: 'whisper-local' } }));
    await expect(execute('speech.transcribe', { artifactId: note.id })).rejects.toThrow(/Whisper on this computer is not installed. The owner installs it on Settings → Speech, or with buddi speech install whisper/);
    await choose(settingsWith({ listen: { backend: 'openai', accountId: 'gone' } }));
    await expect(execute('speech.transcribe', { artifactId: note.id })).rejects.toThrow(/no longer exists/);
    accounts = [{ ...OPENAI, configured: false }];
    await choose(settingsWith({ listen: { backend: 'openai', accountId: OPENAI.id } }));
    await expect(execute('speech.transcribe', { artifactId: note.id })).rejects.toThrow(/is not connected. Connect it in Settings → Model accounts/);
  });

  it('the settings tool offers and accepts only qualifying accounts, binds the one chosen, and refuses a local one not installed', async () => {
    const set = tool('speech.set_settings');
    await expect(set.execute({ side: 'listening', backend: 'openai', account: CODEX.id } as never, owner())).rejects.toThrow(/not an OpenAI account/);
    await expect(set.execute({ side: 'speaking', backend: 'openai-compatible', account: CLAUDE.id } as never, owner())).rejects.toThrow(/not an OpenAI-compatible account/);
    await expect(set.execute({ side: 'listening', backend: 'whisper-local' } as never, owner())).rejects.toThrow(/Install Whisper on this computer first/);
    await expect(set.execute({ side: 'speaking', backend: 'openai-compatible', account: OLLAMA.id } as never, owner())).rejects.toThrow(/Ollama Cloud serves no audio routes/);
    const nine = ['en', 'fr', 'es', 'de', 'pt', 'it', 'nl', 'ar', 'zh'];
    await expect(set.execute({ side: 'listening', backend: 'openai', account: OPENAI.id, languages: nine } as never, owner())).rejects.toThrow('Choose at most 8 languages.');
    await expect(set.execute({ side: 'listening', backend: 'openai', account: OPENAI.id, languages: ['French'] } as never, owner())).rejects.toThrow(/from the list/);
    const saved = (await set.execute({ side: 'listening', backend: 'openai', account: OPENAI.id, model: '', languages: ['fr', 'FR', 'en'] } as never, owner())) as { note: string };
    expect(saved.note).toBe('Saved. Listening uses OpenAI.');
    // "Other…" takes the typed id.
    await set.execute({ side: 'speaking', backend: 'openai-compatible', account: LOCAL.id, model: '__other__', modelOther: 'kokoro', voice: 'af_bella' } as never, owner());
    await set.execute({ side: 'limits', transcribeCap: '50', sayCap: '60' } as never, owner());
    expect(await getSettings(pool)).toEqual(settingsWith({
      listen: { backend: 'openai', accountId: OPENAI.id, model: null, languages: ['fr', 'en'] },
      // No voice per language saved: the one voice reads as the voice of its language.
      speak: { backend: 'openai-compatible', accountId: LOCAL.id, model: 'kokoro', voice: 'af_bella', voices: { en: 'af_bella' } },
      transcribeCap: 50, sayCap: 60,
    }));
    const bound = await pool.query(`select account_id from core.plugin_account_bindings where plugin = 'speech' order by 1`);
    expect(bound.rows.map((r) => r.account_id)).toEqual(expect.arrayContaining([OPENAI.id, LOCAL.id]));
    // A model may never call it.
    expect(await run('speech.set_settings', { side: 'limits', transcribeCap: 1 })).toMatchObject({ ok: false });
  });

  it('the page reads the choices, the qualifying accounts per service, the voices and what leaves', async () => {
    await choose(settingsWith({ listen: { backend: 'openai', accountId: OPENAI.id }, speak: { backend: 'openai-compatible', accountId: LOCAL.id } }));
    const page = await query('settings');
    expect(page).toMatchObject({
      listenBackend: 'openai', listenAccount: OPENAI.id, speakBackend: 'openai-compatible', transcribeCap: 200, sayCap: 200,
      listenModelDefault: 'gpt-4o-mini-transcribe', speakModelDefault: 'gpt-4o-mini-tts',
      leavesListening: 'Listening: The recording goes to OpenAI (api.openai.com), which sends back the text.',
    });
    expect(page).toMatchObject({
      listenStatus: 'Listening: OpenAI key · gpt-4o-mini-transcribe.',
      speakStatus: 'Speaking: speaches · gpt-4o-mini-tts.',
    });
    expect((page.listenBackends as Array<{ id: string }>).map((b) => b.id)).toEqual(['openai', 'openai-compatible', 'whisper-local', 'off']);
    expect(page.accounts).toEqual(expect.arrayContaining([{ label: 'ChatGPT Plus', kind: 'codex', offered: 'no audio routes' }]));
    expect(((await query('listen_accounts', { listenBackend: 'openai' })).choices as Array<{ id: string }>).map((c) => c.id)).toEqual([OPENAI.id]);
    expect(((await query('speak_accounts', { speakBackend: 'openai-compatible' })).choices as Array<{ id: string }>).map((c) => c.id)).toEqual([LOCAL.id, OLLAMA.id]);
    expect(((await query('speak_accounts', {})).choices as Array<{ id: string }>).map((c) => c.id)).toEqual([OPENAI.id, LOCAL.id, OLLAMA.id]);
    expect(((await query('voices', { speakBackend: 'openai' })).voices as unknown[]).length).toBe(11);
    expect(await query('voices', {})).toEqual({ voices: [] });
    await choose(settingsWith({}));
    expect(await query('settings')).toMatchObject({
      listenStatus: 'Listening: not set up. Pick a service below, or install Whisper.',
      speakStatus: 'Speaking: not set up. Pick a service below, or install Kokoro.',
    });
  });

  it('the model pickers list what the account offers, cached, with the default first and Other… last', async () => {
    clearModelCache();
    await choose(settingsWith({ listen: { backend: 'openai', accountId: OPENAI.id }, speak: { backend: 'openai-compatible', accountId: LOCAL.id, model: 'my-tts' } }));
    fake.answer = (req) => req.url.endsWith('/models')
      ? { status: 200, body: JSON.stringify({ data: [{ id: 'gpt-5' }, { id: 'whisper-1' }, { id: 'gpt-4o-transcribe' }, { id: 'gpt-4o-mini-transcribe' }, { id: 'tts-1' }, { id: 'gpt-4o-mini-tts' }] }) }
      : { status: 200, body: '{}' };
    const listen = (await query('listen_models', { listenBackend: 'openai', account: OPENAI.id })).choices as Array<{ id: string; label: string }>;
    expect(listen).toEqual([
      { id: 'gpt-4o-mini-transcribe', label: 'gpt-4o-mini-transcribe (default)' },
      { id: 'gpt-4o-transcribe', label: 'gpt-4o-transcribe' },
      { id: 'whisper-1', label: 'whisper-1' },
      { id: '__other__', label: 'Other…' },
    ]);
    const models = fake.seen.filter((s) => s.url === '/v1/models');
    expect(models).toHaveLength(1);
    expect(models[0]!.method).toBe('GET');
    expect(models[0]!.headers.authorization).toBe('Bearer sk-test');
    // Cached per account: the speaking side of the same account asks nothing.
    const speakSame = (await query('speak_models', { speakBackend: 'openai', account: OPENAI.id })).choices as Array<{ id: string }>;
    expect(speakSame.map((c) => c.id)).toEqual(['gpt-4o-mini-tts', 'tts-1', '__other__']);
    expect(fake.seen.filter((s) => s.url === '/v1/models')).toHaveLength(1);
    // A server that fails: the default, the saved model, and Other….
    fake.answer = () => ({ status: 500, body: 'no' });
    const failed = (await query('speak_models', { speakBackend: 'openai-compatible', account: LOCAL.id })).choices as Array<{ id: string }>;
    expect(failed.map((c) => c.id)).toEqual(['gpt-4o-mini-tts', 'my-tts', '__other__']);
    // No account chosen yet: the default alone; a local backend: its one model.
    expect(((await query('listen_models', { listenBackend: 'openai' })).choices as Array<{ id: string }>).map((c) => c.id)).toEqual(['gpt-4o-mini-transcribe', '__other__']);
    expect(((await query('listen_models', { listenBackend: 'whisper-local' })).choices as Array<{ id: string }>).map((c) => c.id)).toEqual(['whisper-small (q8)']);
    expect(await query('listen_models', {})).toEqual({ choices: [] });
  });

  it('the page shows the languages, and warns when Kokoro would get a note in another', async () => {
    await choose(settingsWith({ listen: { backend: 'openai', accountId: OPENAI.id, languages: ['en', 'fr', 'ja', 'de'] }, speak: { backend: 'kokoro-local' } }));
    expect(await query('settings')).toMatchObject({
      listenLanguages: ['en', 'fr', 'ja', 'de'],
      listenModel: 'gpt-4o-mini-transcribe',
      speakNotice: 'No Japanese or German voice on this computer; Japanese and German replies use the cloud speaker when one is set, else text.',
    });
    await choose(settingsWith({ listen: { languages: ['en', 'fr', 'es'] }, speak: { backend: 'kokoro-local' } }));
    expect((await query('settings')).speakNotice).toBe('');
    await choose(settingsWith({ listen: { languages: ['en'] }, speak: { backend: 'kokoro-local' } }));
    expect((await query('settings')).speakNotice).toBe('');
    // An earlier version's one hint reads as a one-element list until the next save.
    await pool.query(`update speech.settings set listen_languages = '{}', listen_language = 'French'`);
    expect((await getSettings(pool)).listening.languages).toEqual(['fr']);
  });

  it('reads an earlier single voice as the voice of the first language until a save writes the map', async () => {
    await choose(settingsWith({ listen: { languages: ['fr', 'en'] }, speak: { backend: 'openai', accountId: OPENAI.id } }));
    const earlier = async (voice: string, languages: string[]) => {
      await pool.query(`update speech.settings set speak_voice = $1, speak_voices = '{}'::jsonb, listen_languages = $2`, [voice, languages]);
      return (await getSettings(pool)).speaking;
    };
    expect(await earlier('coral', ['fr', 'en'])).toMatchObject({ voice: 'coral', voices: { fr: 'coral' } });
    expect(await earlier('coral', [])).toMatchObject({ voice: 'coral', voices: { en: 'coral' } });
    // A Kokoro voice goes to its own language when the owner speaks it.
    expect(await earlier('af_heart', ['fr', 'en'])).toMatchObject({ voice: 'af_heart', voices: { en: 'af_heart' } });
    // Saved, the map is what was written.
    const saved = await setSettings(pool, { ...(await getSettings(pool)), speaking: { ...(await getSettings(pool)).speaking, voices: { fr: 'ff_siwis', en: 'bf_emma' } } }, new Date());
    expect(saved.speaking.voices).toEqual({ fr: 'ff_siwis', en: 'bf_emma' });
    expect((await pool.query(`select speak_voices from speech.settings`)).rows[0].speak_voices).toEqual({ fr: 'ff_siwis', en: 'bf_emma' });
  });

  it('transcribe: the first call in a conversation is a card; approved, it returns the text and counts; the next one runs', async () => {
    await choose(settingsWith({ listen: { backend: 'openai', accountId: OPENAI.id, languages: ['en'] } }));
    const note = await voiceNote();
    const first = await run('speech.transcribe', { artifactId: note.id });
    expect(first).toMatchObject({ ok: false, reason: 'approval-required' });
    expect((first as { preview: string }).preview).toMatch(/^Transcribe "voice.ogg" \(4 KB\) with OpenAI key · gpt-4o-mini-transcribe\. The recording goes to OpenAI/);
    const actionId = (first as { actionId: string }).actionId;
    await decideApproval(pool, { actionId, decision: 'approved', by: 'owner', via: 'web' });
    const done = await executeApproved(pool, { actionId, registry, ctx: ctx(), worker: 'test' });
    expect(done).toMatchObject({ ok: true, result: { text: 'Hello from buddi. This is a test.' } });
    expect(fake.seen.at(-1)!.body.toString('latin1')).toMatch(/name="language"\r\n\r\nen/);

    expect(await run('speech.transcribe', { artifactId: note.id, language: 'fr' })).toMatchObject({ ok: true });
    expect(fake.seen.at(-1)!.body.toString('latin1')).toMatch(/name="language"\r\n\r\nfr/);
    // Several languages: the service is sent none, and detects.
    await choose(settingsWith({ listen: { backend: 'openai', accountId: OPENAI.id, languages: ['en', 'fr'] } }));
    expect(await run('speech.transcribe', { artifactId: note.id })).toMatchObject({ ok: true });
    expect(fake.seen.at(-1)!.body.toString('latin1')).not.toContain('name="language"');
    const used = await pool.query(`select side, agent_id, conversation_id::text, artifact_id::text, backend, model from speech.usage`);
    expect(used.rows).toHaveLength(3);
    expect(used.rows[0]).toMatchObject({ side: 'listen', agent_id: 'buddy', conversation_id: conversationId, artifact_id: note.id, backend: 'openai', model: 'gpt-4o-mini-transcribe' });
    // speech.say still asks on its own.
    await choose(settingsWith({ listen: { backend: 'openai', accountId: OPENAI.id }, speak: { backend: 'openai', accountId: OPENAI.id } }));
    expect(await run('speech.say', { text: 'hi' })).toMatchObject({ reason: 'approval-required' });
    // A new conversation asks again.
    const { rows: other } = await pool.query(`insert into core.conversations (agent_id) values ('buddy') returning id::text as id`);
    expect(await run('speech.transcribe', { artifactId: note.id }, { conversationId: other[0].id })).toMatchObject({ reason: 'approval-required' });
    // The owner acting themselves (Telegram's voice note) is never asked, and still counts.
    expect(await run('speech.transcribe', { artifactId: note.id }, { agentId: 'owner', conversationId: undefined })).toMatchObject({ ok: true });
    expect(await run('speech.say', { text: 'hi' }, { agentId: 'owner', conversationId: undefined })).toMatchObject({ ok: true });
    const owned = await pool.query(`select side from speech.usage where agent_id = 'owner' order by side`);
    expect(owned.rows).toEqual([{ side: 'listen' }, { side: 'speak' }]);
  });

  it('transcribe refuses what is not audio, what is too large to send, and an unknown id', async () => {
    await choose(settingsWith({ listen: { backend: 'openai', accountId: OPENAI.id } }));
    const pdf = await saveArtifact(pool, { bytes: Buffer.from('%PDF-1.4'), mime: 'application/pdf', filename: 'x.pdf', createdBy: 'owner' });
    await expect(execute('speech.transcribe', { artifactId: pdf.id })).rejects.toThrow(/x.pdf is not an audio file/);
    const liar = await saveArtifact(pool, { bytes: Buffer.from('<html>'), mime: 'audio/ogg', filename: 'liar.ogg', createdBy: 'owner' });
    await expect(execute('speech.transcribe', { artifactId: liar.id })).rejects.toThrow(/liar.ogg is not audio this plugin can send/);
    await expect(execute('speech.transcribe', { artifactId: '00000000-0000-4000-8000-000000000000' })).rejects.toThrow(/not a file in the Files library/);
    await pool.query(`update core.artifacts set size_bytes = $2 where id = $1`, [liar.id, 26 * 1024 * 1024]);
    await expect(execute('speech.transcribe', { artifactId: liar.id })).rejects.toThrow(/larger than 25 MB/);
    expect(fake.seen).toHaveLength(0);
  });

  it('say: stores an OGG/Opus voice in the Files library with provenance, with the owner\'s voice, and refuses what is not audio', async () => {
    await choose(settingsWith({ speak: { backend: 'openai', accountId: OPENAI.id, voice: 'coral' } }));
    const out = await execute('speech.say', { text: 'Your train leaves at nine.' });
    expect(out).toMatchObject({ name: 'your-train-leaves-at-nine.ogg', mime: 'audio/ogg', voice: 'coral', backend: 'openai', account: 'OpenAI key', model: 'gpt-4o-mini-tts' });
    expect(out.artifacts).toEqual([{ id: out.id }]);
    expect(JSON.parse(fake.seen.at(-1)!.body.toString())).toEqual({ model: 'gpt-4o-mini-tts', input: 'Your train leaves at nine.', voice: 'coral', response_format: 'opus' });
    const { rows } = await pool.query(`select created_by, conversation_id::text, mime, kind, caption from core.artifacts where id = $1`, [out.id]);
    expect(rows[0]).toMatchObject({ created_by: 'buddy', conversation_id: conversationId, mime: 'audio/ogg', kind: 'audio' });
    expect(rows[0].caption).toContain('Your train leaves at nine.');

    await expect(execute('speech.say', { text: 'x', voice: 'darth' })).rejects.toThrow(/"darth" is not an OpenAI voice/);
    // The service's content type is not trusted: the bytes are.
    fake.answer = () => ({ status: 200, type: 'audio/ogg', body: '<html>maintenance</html>' });
    await expect(execute('speech.say', { text: 'x' })).rejects.toThrow('refused: what came back is not audio, so nothing was stored.');
    // A compatible server that answers MP3 to an opus request: kept as what it is.
    await choose(settingsWith({ speak: { backend: 'openai-compatible', accountId: LOCAL.id, voice: 'af_bella' } }));
    fake.answer = () => ({ status: 200, type: 'application/octet-stream', body: Buffer.concat([Buffer.from('ID3'), Buffer.alloc(8), freshVoice()]) });
    expect(await execute('speech.say', { text: 'hello there' })).toMatchObject({ name: 'hello-there.mp3', mime: 'audio/mpeg', voice: 'af_bella' });
    expect(await run('speech.say', { text: 'x'.repeat(4001) })).toMatchObject({ reason: 'invalid-args' });
  });

  it('say: sends the backend the text rewritten for the ear, and keeps what was written in the caption', async () => {
    await choose(settingsWith({ speak: { backend: 'openai', accountId: OPENAI.id, voice: 'coral' } }));
    const out = await execute('speech.say', { text: '**@ledger** says: -6626.35 USD 🎉', handles: { ledger: 'Ledger' } });
    expect(JSON.parse(fake.seen.at(-1)!.body.toString()).input).toBe('Ledger says: minus 6,626 dollars and 35 cents.');
    expect(out.text).toBe('**@ledger** says: -6626.35 USD 🎉');
    expect(await run('speech.say', { text: 'hi', handles: { ledger: 7 } })).toMatchObject({ reason: 'invalid-args' });
  });

  it('telegram_voice: reads null until chosen, sets either half, and is the owner\'s own', async () => {
    const tv = (args: Record<string, unknown>) => tool('speech.telegram_voice').execute(args as never, owner()) as Promise<Record<string, unknown>>;
    expect(await tv({})).toEqual({ when: null, form: null });
    expect(await query('settings')).toMatchObject({ telegramWhen: 'spoken', telegramForm: 'voice' });
    expect(await tv({ form: 'both' })).toMatchObject({ when: null, form: 'both', note: 'Saved. On Telegram, a voice note answers yours, with its text as the caption.' });
    expect(await tv({ when: 'off' })).toMatchObject({ when: 'off', form: 'both', note: 'Saved. On Telegram, answers are text only.' });
    expect(await query('settings')).toMatchObject({ telegramWhen: 'off', telegramForm: 'both' });
    expect(await run('speech.telegram_voice', {})).toMatchObject({ ok: false });
    expect(await run('speech.telegram_voice', { when: 'loud' }, { agentId: 'owner', conversationId: undefined })).toMatchObject({ reason: 'invalid-args' });
    await pool.query(`update speech.settings set telegram_voice_when = null, telegram_voice_form = null`);
  });

  it('refuses beyond each daily cap, with the count', async () => {
    await choose(settingsWith({ listen: { backend: 'openai', accountId: OPENAI.id }, speak: { backend: 'openai', accountId: OPENAI.id }, transcribeCap: 1, sayCap: 2 }));
    const note = await voiceNote();
    await execute('speech.transcribe', { artifactId: note.id });
    await expect(execute('speech.transcribe', { artifactId: note.id })).rejects.toThrow(/1 recordings have been transcribed today, and the daily limit is 1/);
    await execute('speech.say', { text: 'one' });
    await execute('speech.say', { text: 'two' });
    await expect(execute('speech.say', { text: 'three' })).rejects.toThrow(/2 replies have been spoken today, and the daily limit is 2/);
  });

  it("the Listening Test transcribes the bundled clip; Speaking has no Test that writes to Files", async () => {
    await choose(settingsWith({ listen: { backend: 'openai', accountId: OPENAI.id } }));
    const heard = (await tool('speech.test').execute({ side: 'listening' } as never, owner())) as { note: string };
    expect(heard.note).toMatch(/^Heard: "Hello from buddi. This is a test."/);
    expect(fake.seen.at(-1)!.body.includes(OGG_CLIP)).toBe(true);
    expect(await run('speech.test', { side: 'speaking' }, { agentId: 'owner', conversationId: undefined })).toMatchObject({ reason: 'invalid-args' });
    const page = JSON.stringify(manifest.pages);
    expect(page).not.toContain("'speaking'");
    expect(manifest.pages![0]!.body.some((c) => c.kind === 'section' && c.title === 'Speaking' && (c.actions?.length ?? 0) > 0)).toBe(false);
  });

  it('preview: says the sample with the unsaved choices, plays it back, and keeps and counts nothing', async () => {
    // Saved: nothing at all. The form holds OpenAI, an account and a voice.
    await choose(settingsWith({ speak: { voice: 'shimmer' }, sayCap: 1 }));
    // Today's one spoken reply is already used: the sample is not a reply, and plays anyway.
    await recordUsage(pool, { side: 'speak', agentId: 'buddy', conversationId: null, artifactId: null, backend: 'openai', accountId: OPENAI.id, model: 'tts-1', chars: 3, bytes: 3, now: new Date() });
    const before = (await pool.query('select count(*)::int as n from core.artifacts')).rows[0].n;
    const used = (await pool.query('select count(*)::int as n from speech.usage')).rows[0].n;
    const out = (await run('speech.preview', { backend: 'openai', account: OPENAI.id, model: 'gpt-4o-mini-tts', voice: 'nova' }, { agentId: 'owner', conversationId: undefined })) as {
      ok: boolean; output: { play: { mime: string; data: string } };
    };
    expect(out.ok).toBe(true);
    expect(out.output.play.mime).toBe('audio/ogg');
    expect(Buffer.from(out.output.play.data, 'base64').subarray(0, 4).toString('latin1')).toBe('OggS');
    const sent = JSON.parse(fake.seen.at(-1)!.body.toString());
    expect(sent).toMatchObject({ input: "Hi, I'm buddi. This is how I sound.", voice: 'nova', model: 'gpt-4o-mini-tts' });
    expect((await pool.query('select count(*)::int as n from core.artifacts')).rows[0].n).toBe(before);
    expect((await pool.query('select count(*)::int as n from speech.usage')).rows[0].n).toBe(used);
    // Nothing was saved either.
    expect((await getSettings(pool)).speaking.backend).toBeNull();
    // A row's play button: the sample in the row's language.
    await run('speech.preview', { backend: 'openai', account: OPENAI.id, voice: 'nova', lang: 'fr' }, { agentId: 'owner', conversationId: undefined });
    expect(JSON.parse(fake.seen.at(-1)!.body.toString())).toMatchObject({ input: 'Bonjour, je suis buddi. Voici ma voix.', voice: 'nova' });
    expect(await run('speech.preview', { backend: 'openai', account: OPENAI.id, lang: 'French' }, { agentId: 'owner', conversationId: undefined })).toMatchObject({ reason: 'invalid-args' });
    // "Other…" sends the typed id.
    await run('speech.preview', { backend: 'openai', account: OPENAI.id, model: '__other__', modelOther: 'tts-1-hd', voice: 'nova' }, { agentId: 'owner', conversationId: undefined });
    expect(JSON.parse(fake.seen.at(-1)!.body.toString()).model).toBe('tts-1-hd');
  });

  it('preview: refuses in one sentence, and never for an agent', async () => {
    await choose(settingsWith({}));
    const asOwner = { agentId: 'owner', conversationId: undefined };
    expect(await run('speech.preview', {}, asOwner)).toMatchObject({ ok: false, message: expect.stringMatching(/choose a speaking service first/) });
    expect(await run('speech.preview', { backend: 'openai' }, asOwner)).toMatchObject({ ok: false, message: expect.stringMatching(/choose an OpenAI account first/) });
    expect(await run('speech.preview', { backend: 'openai', account: CODEX.id }, asOwner)).toMatchObject({ ok: false, message: expect.stringMatching(/is not an OpenAI account/) });
    expect(await run('speech.preview', { backend: 'kokoro-local' }, asOwner)).toMatchObject({ ok: false, message: expect.stringMatching(/Kokoro on this computer is not installed/) });
    expect(await run('speech.preview', { backend: 'openai', account: OPENAI.id, voice: 'robot' }, asOwner)).toMatchObject({ ok: false, message: expect.stringMatching(/"robot" is not an OpenAI voice/) });
    // ownerOnly: an agent cannot reach it.
    expect(await run('speech.preview', { backend: 'openai', account: OPENAI.id })).toMatchObject({ ok: false });
    expect(fake.seen.filter((r) => r.url.endsWith('/audio/speech'))).toHaveLength(0);
  });

  it('Off beats the model on this computer: the page says so and the tools answer the not-set sentence', async () => {
    const dir = path.join(dataDir, 'plugins-data', 'speech');
    await fakeInstalled(dir, 'whisper');
    await fakeInstalled(dir, 'kokoro');
    try {
      const saved = await run('speech.set_settings', { side: 'listening', backend: 'off', languages: [] }, owner());
      expect(saved).toMatchObject({ ok: true, output: { note: expect.stringMatching(/Listening is off, so speech\.transcribe refuses, even with a model/) } });
      await run('speech.set_settings', { side: 'speaking', backend: 'off' }, owner());
      expect(await getSettings(pool)).toMatchObject({ listening: { backend: 'off' }, speaking: { backend: 'off' } });
      expect(await query('settings')).toMatchObject({
        listenBackend: 'off', speakBackend: 'off', listenStatus: 'Listening: off.', speakStatus: 'Speaking: off.',
        leavesListening: 'Listening: nothing, because it is off.',
      });
      const note = await voiceNote();
      expect(await run('speech.transcribe', { artifactId: note.id })).toMatchObject({ ok: false, message: NOT_SET.listening });
      expect(await run('speech.say', { text: 'Hello.' })).toMatchObject({ ok: false, message: NOT_SET.speaking });
      // Back to nothing chosen: the model on this computer again.
      await run('speech.set_settings', { side: 'listening', backend: '', languages: [] }, owner());
      expect(await query('settings')).toMatchObject({ listenBackend: 'whisper-local' });
    } finally {
      await rm(dir, { recursive: true, force: true });
      await choose(settingsWith({}));
    }
  });

  it('with no language listed, hints the one from the owner profile, and the page says so', async () => {
    await pool.query(`insert into core.owner (id, language) values ('owner', 'Français') on conflict (id) do update set language = excluded.language`);
    try {
      await choose(settingsWith({ listen: { backend: 'openai', accountId: OPENAI.id } }));
      expect(await query('settings')).toMatchObject({ listenLanguagesNote: 'From your profile: French.' });
      const note = await voiceNote();
      const first = await run('speech.transcribe', { artifactId: note.id });
      if (!(first as { ok: boolean }).ok) {
        const actionId = (first as { actionId: string }).actionId;
        await decideApproval(pool, { actionId, decision: 'approved', by: 'owner', via: 'web' });
        await executeApproved(pool, { actionId, registry, ctx: ctx(), worker: 'test' });
      }
      expect(fake.seen.at(-1)!.body.toString('latin1')).toMatch(/name="language"\r\n\r\nfr/);
      // Listed languages win, and the note goes.
      await choose(settingsWith({ listen: { backend: 'openai', accountId: OPENAI.id, languages: ['en'] } }));
      expect(await query('settings')).toMatchObject({ listenLanguagesNote: '' });
      expect(await run('speech.transcribe', { artifactId: note.id })).toMatchObject({ ok: true });
      expect(fake.seen.at(-1)!.body.toString('latin1')).toMatch(/name="language"\r\n\r\nen/);
    } finally {
      await pool.query(`update core.owner set language = null where id = 'owner'`);
    }
  });

  it('with Whisper and Kokoro installed and nothing chosen, uses them, says nothing leaves, and Remove takes them back', async () => {
    const dir = path.join(dataDir, 'plugins-data', 'speech');
    await choose(settingsWith({}));
    await fakeInstalled(dir, 'whisper');
    await fakeInstalled(dir, 'kokoro');
    const page = await query('settings');
    expect(page).toMatchObject({
      listenBackend: 'whisper-local', speakBackend: 'kokoro-local',
      leavesListening: 'Listening: nothing. It runs on this computer.', leavesSpeaking: 'Speaking: nothing. It runs on this computer.',
      listenStatus: 'Listening: Whisper on this computer.', speakStatus: 'Speaking: Kokoro on this computer.',
    });
    expect((page.speakBackends as Array<{ id: string; available: boolean }>).at(-2)).toEqual({ id: 'kokoro-local', label: 'Kokoro on this computer', available: true });
    // The one Voice field lists Kokoro's English voices; a row, its language's.
    const english = ((await query('voices', { speakBackend: 'kokoro-local' })).voices as Array<{ id: string }>).map((v) => v.id);
    expect(english).toEqual(expect.arrayContaining(['af_heart', 'bf_emma']));
    expect(english).not.toContain('ff_siwis');
    expect(((await query('voices', { speakBackend: 'kokoro-local', lang: 'fr' })).voices as Array<{ id: string }>).map((v) => v.id)).toEqual(['ff_siwis']);
    expect(((await query('voices', { speakBackend: 'kokoro-local', lang: 'es' })).voices as Array<{ id: string }>).map((v) => v.id)).toEqual(['ef_dora', 'em_alex', 'em_santa']);
    expect(await query('voices', { speakBackend: 'kokoro-local', lang: 'de' })).toEqual({ voices: [] });
    expect(((await query('voices', { speakBackend: 'openai' })).voices as unknown[]).length).toBe(11);
    const status = await query('install_status');
    expect(status).toMatchObject({ busy: false, models: [{ kind: 'whisper', state: 'installed' }, { kind: 'kokoro', state: 'installed' }] });
    // A French reply is said with Kokoro's French voice, whichever voice is chosen: the approval card names it.
    const french = 'Bonjour, votre rendez-vous est déplacé à quinze heures.';
    expect((await tool('speech.say').describe!({ text: french } as never, ctx({}))).preview).toMatch(/, voice ff_siwis: "Bonjour/);
    // A voice per language: rows for English and French, in the page's data; the one field hidden.
    await choose(settingsWith({ listen: { languages: ['fr', 'en', 'de'] }, speak: { voices: { en: 'bm_george' } } }));
    const rows = await query('settings');
    expect(rows).toMatchObject({
      voiceByLanguage: true, voiceRows: { en: true, fr: true, es: false }, speakVoices: { en: 'bm_george', fr: 'ff_siwis' },
      speakNotice: 'No German voice on this computer; German replies use the cloud speaker when one is set, else text.',
    });
    // Saved from the rows: the map, and the one voice following the first language.
    const setVoices = tool('speech.set_settings');
    const savedRows = (await setVoices.execute({ side: 'speaking', backend: 'kokoro-local', voice_en: 'am_adam', voice_fr: 'ff_siwis' } as never, owner())) as Settings;
    expect(savedRows.speaking).toMatchObject({ voice: 'ff_siwis', voices: { en: 'am_adam', fr: 'ff_siwis' } });
    // A reply picks the voice of its language: the owner's English voice for English, whichever voice is the fallback.
    expect((await tool('speech.say').describe!({ text: 'Your meeting moved to three, and that is all.' } as never, ctx({}))).preview).toMatch(/, voice am_adam: "Your meeting/);
    expect((await tool('speech.say').describe!({ text: french } as never, ctx({}))).preview).toMatch(/, voice ff_siwis: "Bonjour/);
    // A row left out keeps its voice; one emptied drops it.
    expect(((await setVoices.execute({ side: 'speaking', backend: 'kokoro-local', voice_fr: 'ff_siwis' } as never, owner())) as Settings).speaking.voices).toEqual({ en: 'am_adam', fr: 'ff_siwis' });
    expect(((await setVoices.execute({ side: 'speaking', backend: 'kokoro-local', voice_en: '' } as never, owner())) as Settings).speaking.voices).toEqual({ fr: 'ff_siwis' });
    // OpenAI's voices carry no language: the one Voice field.
    await choose(settingsWith({ listen: { languages: ['fr', 'en'] }, speak: { backend: 'openai', accountId: OPENAI.id } }));
    expect(await query('settings')).toMatchObject({ voiceByLanguage: false, voiceRows: { en: false, fr: false } });
    await choose(settingsWith({ listen: { languages: ['fr', 'en', 'de'] } }));
    // A German reply has no Kokoro voice: refused by kind before anything runs, and counts nothing.
    await expect(execute('speech.say', { text: 'Die Besprechung ist um drei und das ist alles für heute.' })).rejects.toMatchObject({ code: 'not-english' });
    expect((await pool.query('select count(*)::int as n from speech.usage')).rows[0].n).toBe(0);
    // The owner's choice wins over the default.
    await choose(settingsWith({ listen: { backend: 'openai', accountId: OPENAI.id } }));
    expect((await query('settings')).listenBackend).toBe('openai');
    // Choosing it explicitly works once installed.
    const set = tool('speech.set_settings');
    expect(await set.execute({ side: 'speaking', backend: 'kokoro-local', voice: 'bf_emma' } as never, owner())).toMatchObject({ note: 'Saved. Speaking uses Kokoro on this computer.' });
    const removed = (await tool('speech.remove').execute({ kind: 'kokoro' } as never, owner())) as { note: string };
    expect(removed.note).toBe('Removed Kokoro on this computer. Speaking needs another service, or Install again.');
    await expect(execute('speech.say', { text: 'This is buddi.' })).rejects.toThrow(/Kokoro on this computer is not installed/);
    expect(await run('speech.install', { kind: 'kokoro' })).toMatchObject({ ok: false });
  });
});
