/**
 * The OpenAI audio backend against a local fake server that speaks its two
 * routes: the request shapes, the key, the refusals, and that nothing a
 * service says is trusted about what the bytes are.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { ResolvedProvider } from '@buddi/core/testing';
import { accountModelIds, clearModelCache, compatibleModelsFor, modelsFor, openaiBackend, openaiCompatibleBackend, openaiSynthesize, openaiTranscribe, OPENAI_VOICES } from './backends/openai.js';
import { fakeAudioServer, OGG_CLIP, OPENAI_MODELS, type FakeAudioServer } from './testing/fixtures.js';

let fake: FakeAudioServer;
beforeAll(async () => { fake = await fakeAudioServer(); });
afterAll(() => fake.close());

const provider = (over: Partial<ResolvedProvider> = {}): ResolvedProvider => ({
  kind: 'openai', baseUrl: fake.base, credentialKind: 'api-key', secret: 'sk-local-secret', model: 'gpt-4o-mini-transcribe', compatible: true, ...over,
});

describe('OpenAI audio backend', () => {
  it('posts a transcription as multipart: the file, the model, the language, json', async () => {
    fake.seen.length = 0;
    fake.answer = () => ({ status: 200, body: JSON.stringify({ text: '  Hello from buddi.  ' }) });
    const out = await openaiTranscribe({ bytes: OGG_CLIP, mime: 'audio/ogg', language: 'en' }, { provider: provider(), timeoutMs: 5_000 });
    expect(out).toEqual({ text: 'Hello from buddi.' });
    const req = fake.seen[0]!;
    expect(req.url).toBe('/v1/audio/transcriptions');
    expect(req.method).toBe('POST');
    expect(req.headers.authorization).toBe('Bearer sk-local-secret');
    expect(req.headers['content-type']).toMatch(/^multipart\/form-data; boundary=/);
    const body = req.body.toString('latin1');
    expect(body).toContain('name="file"; filename="audio.ogg"');
    expect(body).toMatch(/name="model"\r\n\r\ngpt-4o-mini-transcribe/);
    expect(body).toMatch(/name="language"\r\n\r\nen/);
    expect(body).toMatch(/name="response_format"\r\n\r\njson/);
    expect(req.body.includes(OGG_CLIP)).toBe(true);
  });

  it('leaves the language out when there is no hint, sends no key to a keyless server, and keeps a language it is told', async () => {
    fake.seen.length = 0;
    fake.answer = () => ({ status: 200, body: JSON.stringify({ text: 'Bonjour', language: 'french' }) });
    const out = await openaiTranscribe({ bytes: OGG_CLIP, mime: 'audio/ogg' }, { provider: provider({ secret: '', model: 'whisper-1' }), timeoutMs: 5_000 });
    expect(out).toEqual({ text: 'Bonjour', language: 'french' });
    expect(fake.seen[0]!.body.toString('latin1')).not.toContain('name="language"');
    expect(fake.seen[0]!.headers.authorization).toBeUndefined();
  });

  it('posts speech as JSON with the model, input, voice and opus, and returns the bytes', async () => {
    fake.seen.length = 0;
    fake.answer = () => ({ status: 200, type: 'audio/ogg', body: OGG_CLIP });
    const out = await openaiSynthesize({ text: 'This is buddi.', format: 'ogg-opus' }, 'coral', { provider: provider({ model: 'gpt-4o-mini-tts' }), timeoutMs: 5_000 });
    expect(out.bytes.equals(OGG_CLIP)).toBe(true);
    expect(out.mime).toBe('audio/ogg');
    expect(fake.seen[0]!.url).toBe('/v1/audio/speech');
    expect(JSON.parse(fake.seen[0]!.body.toString())).toEqual({ model: 'gpt-4o-mini-tts', input: 'This is buddi.', voice: 'coral', response_format: 'opus' });
    await openaiSynthesize({ text: 'x', format: 'mp3' }, 'alloy', { provider: provider(), timeoutMs: 5_000 });
    await openaiSynthesize({ text: 'x', format: 'm4a' }, 'alloy', { provider: provider(), timeoutMs: 5_000 });
    expect(fake.seen.slice(1).map((s) => JSON.parse(s.body.toString()).response_format)).toEqual(['mp3', 'aac']);
  });

  it("says the service's reason for a refusal, with the key blanked", async () => {
    fake.answer = () => ({ status: 401, body: JSON.stringify({ error: { message: 'Incorrect API key provided: sk-local-secret.' } }) });
    await expect(openaiTranscribe({ bytes: OGG_CLIP, mime: 'audio/ogg' }, { provider: provider(), timeoutMs: 5_000 }))
      .rejects.toThrow('refused: the listening service answered 401: Incorrect API key provided: [key].');
    fake.answer = () => ({ status: 200, body: '<html>oops</html>' });
    await expect(openaiTranscribe({ bytes: OGG_CLIP, mime: 'audio/ogg' }, { provider: provider(), timeoutMs: 5_000 })).rejects.toThrow(/not JSON/);
    fake.answer = () => ({ status: 200, body: JSON.stringify({ nope: 1 }) });
    await expect(openaiTranscribe({ bytes: OGG_CLIP, mime: 'audio/ogg' }, { provider: provider(), timeoutMs: 5_000 })).rejects.toThrow(/without a transcript/);
  });

  it('gives up after its timeout, and says so', async () => {
    fake.answer = () => ({ status: 200, body: '{}', delayMs: 2_000 });
    await expect(openaiSynthesize({ text: 'x', format: 'ogg-opus' }, 'alloy', { provider: provider(), timeoutMs: 200 }))
      .rejects.toThrow('refused: the speaking service did not answer within 1 second.');
  });

  it('refuses an Ollama account connected with a device key before sending anything; one with a key is tried like any server', async () => {
    fake.seen.length = 0;
    await expect(openaiTranscribe({ bytes: OGG_CLIP, mime: 'audio/ogg' }, { provider: provider({ deviceKey: 'pem', secret: '' }), timeoutMs: 5_000 }))
      .rejects.toThrow(/device key .* cannot be used for audio/);
    expect(fake.seen).toHaveLength(0);
    fake.answer = () => ({ status: 404, body: JSON.stringify({ error: { message: 'page not found' } }) });
    await expect(openaiSynthesize({ text: 'x', format: 'mp3' }, 'alloy', { provider: provider(), timeoutMs: 5_000 }))
      .rejects.toThrow('refused: the speaking service answered 404: page not found.');
    expect(fake.seen).toHaveLength(1);
  });

  it('reads an OpenAI key\'s recorded model list into the transcribe and TTS families, and a compatible server\'s into likely-first', () => {
    const ids = (JSON.parse(OPENAI_MODELS) as { data: Array<{ id: string }> }).data.map((m) => m.id);
    expect(modelsFor('listening', ids, 'gpt-4o-mini-transcribe')).toEqual(['gpt-4o-mini-transcribe', 'gpt-4o-transcribe', 'gpt-4o-transcribe-diarize', 'whisper-1']);
    expect(modelsFor('speaking', ids, 'gpt-4o-mini-tts')).toEqual(['gpt-4o-mini-tts', 'tts-1', 'tts-1-hd']);
    // A compatible server: the ones named for the side first, then whatever else it lists, never the other side's.
    expect(compatibleModelsFor('speaking', ['kokoro', 'whisper-large-v3', 'tts-kokoro', 'llama3'])).toEqual(['tts-kokoro', 'kokoro', 'llama3']);
    expect(compatibleModelsFor('listening', ['kokoro', 'whisper-large-v3', 'tts-kokoro'])).toEqual(['whisper-large-v3', 'kokoro']);
    expect(compatibleModelsFor('listening', [])).toEqual([]);
  });

  it('goes through the bound account the backend context names, and lists the OpenAI voices', async () => {
    fake.answer = () => ({ status: 200, body: JSON.stringify({ text: 'ok' }) });
    const resolved: Array<[string, string]> = [];
    const ctx = {
      accounts: { resolve: async (id: string, model: string) => { resolved.push([id, model]); return provider({ model }); } },
      account: { id: 'oa', label: 'OpenAI', kind: 'openai' as const, enabled: true, configured: true, defaultModel: 'gpt-5' },
      model: 'gpt-4o-transcribe', signal: new AbortController().signal, timeoutMs: 5_000,
    };
    expect(await openaiBackend.listener!.transcribe({ bytes: OGG_CLIP, mime: 'audio/ogg' }, ctx)).toEqual({ text: 'ok' });
    expect(resolved).toEqual([['oa', 'gpt-4o-transcribe']]);
    expect((await openaiCompatibleBackend.voices!(ctx)).map((v) => v.id)).toEqual([...OPENAI_VOICES]);
    expect(OPENAI_VOICES).toEqual(['alloy', 'ash', 'ballad', 'coral', 'echo', 'fable', 'nova', 'onyx', 'sage', 'shimmer', 'verse']);
    await expect(openaiBackend.speaker!.synthesize({ text: 'x', format: 'mp3' }, { ...ctx, account: undefined } as never)).rejects.toThrow(/Settings → Speech/);
  });

  it('lists the account\'s models with GET /models, per side, cached ten minutes, and nothing on a failure', async () => {
    clearModelCache();
    fake.seen.length = 0;
    fake.answer = () => ({ status: 200, body: JSON.stringify({ data: [{ id: 'tts-1' }, { id: 'whisper-1' }, { id: 'gpt-4o-mini-tts' }, { id: 'x\ny' }, {}] }) });
    const ids = await accountModelIds('acct', { provider: provider(), timeoutMs: 5_000, now: 0 });
    expect(ids).toEqual(['tts-1', 'whisper-1', 'gpt-4o-mini-tts']);
    expect(fake.seen[0]).toMatchObject({ url: '/v1/models', method: 'GET' });
    expect(modelsFor('speaking', ids, 'gpt-4o-mini-tts')).toEqual(['gpt-4o-mini-tts', 'tts-1']);
    expect(modelsFor('listening', ids, 'gpt-4o-mini-transcribe')).toEqual(['gpt-4o-mini-transcribe', 'whisper-1']);
    await accountModelIds('acct', { provider: provider(), timeoutMs: 5_000, now: 9 * 60_000 });
    expect(fake.seen).toHaveLength(1);
    await accountModelIds('acct', { provider: provider(), timeoutMs: 5_000, now: 11 * 60_000 });
    expect(fake.seen).toHaveLength(2);
    fake.answer = () => ({ status: 404, body: 'nope' });
    expect(await accountModelIds('other', { provider: provider(), timeoutMs: 5_000 })).toEqual([]);
    fake.answer = () => ({ status: 200, body: 'not json' });
    expect(await accountModelIds('third', { provider: provider(), timeoutMs: 5_000 })).toEqual([]);
  });
});
