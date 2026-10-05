/**
 * The Gemini backend against a local fake server: the recorded model list
 * filtered per side, the request shapes and the key header, the PCM it
 * answers turned into a voice note, and its refusals.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { ProviderAccountListing, ResolvedProvider } from '@buddi/core/testing';
import {
  clearGeminiModelCache, geminiBackend, geminiModels, geminiModelsFor, geminiRoot, isGeminiUrl, pcm16ToFloat, transcribePrompt, voiceNoteFromPcm,
} from './backends/gemini.js';
import { isOggOpus, sniffAudio } from './magic.js';
import { fakeAudioServer, GEMINI_MODELS, geminiAnswer, geminiPcm, OGG_CLIP, type FakeAudioServer } from './testing/fixtures.js';

let fake: FakeAudioServer;
beforeAll(async () => { fake = await fakeAudioServer(); });
afterAll(() => fake.close());
beforeEach(() => { fake.seen.length = 0; clearGeminiModelCache(); });

const GEMINI: ProviderAccountListing = {
  id: 'gem', label: 'Gemini', kind: 'openai-compatible', enabled: true, configured: true, defaultModel: 'gemini-2.5-flash',
  baseUrl: 'https://generativelanguage.googleapis.com/v1beta/openai/',
};
const resolved = (model: string): ResolvedProvider => ({ kind: 'openai', baseUrl: fake.base, credentialKind: 'api-key', secret: 'AIza-test-key', model, compatible: true });
const ctx = (model: string) => ({
  accounts: { resolve: async (_id: string, m: string) => resolved(m) },
  account: GEMINI,
  model,
  signal: new AbortController().signal,
  timeoutMs: 5_000,
});

describe('Gemini backend', () => {
  it('knows Google\'s address, and roots its own API beside the OpenAI-compatible one', () => {
    expect(isGeminiUrl(GEMINI.baseUrl)).toBe(true);
    expect(isGeminiUrl('https://generativelanguage.googleapis.com.example/v1')).toBe(false);
    expect(isGeminiUrl(undefined)).toBe(false);
    expect(geminiRoot(GEMINI.baseUrl!)).toBe('https://generativelanguage.googleapis.com/v1beta');
  });

  it('reads the recorded model list: Flash models that take a file for listening, TTS models for speaking, never a Live-only one', async () => {
    fake.answer = () => ({ status: 200, body: GEMINI_MODELS });
    const models = await geminiModels('gem', resolved('x'), ctx('x'));
    expect(fake.seen[0]).toMatchObject({ method: 'GET', url: '/v1beta/models?pageSize=1000' });
    expect(fake.seen[0]!.headers['x-goog-api-key']).toBe('AIza-test-key');
    expect(fake.seen[0]!.headers.authorization).toBeUndefined();
    expect(geminiModelsFor('listening', models)).toEqual(['gemini-2.5-flash', 'gemini-2.0-flash', 'gemini-2.5-flash-lite']);
    expect(geminiModelsFor('speaking', models)).toEqual(['gemini-2.5-flash-preview-tts', 'gemini-2.5-pro-preview-tts']);
    // Cached per account: the other side asks nothing.
    await geminiModels('gem', resolved('x'), ctx('x'));
    expect(fake.seen).toHaveLength(1);
    // Through the backend, with the account's credential.
    expect(await geminiBackend.models!('speaking', ctx('x'))).toEqual(['gemini-2.5-flash-preview-tts', 'gemini-2.5-pro-preview-tts']);
  });

  it('follows the next page, and a failure is the known models, not cached', async () => {
    let page = 0;
    fake.answer = () => (++page === 1
      ? { status: 200, body: JSON.stringify({ models: [{ name: 'models/gemini-2.5-flash', supportedGenerationMethods: ['generateContent'] }], nextPageToken: 'p2' }) }
      : { status: 200, body: JSON.stringify({ models: [{ name: 'models/gemini-3-flash', supportedGenerationMethods: ['generateContent'] }] }) });
    expect(geminiModelsFor('listening', await geminiModels('two', resolved('x'), ctx('x')))).toEqual(['gemini-2.5-flash', 'gemini-3-flash']);
    expect(fake.seen[1]!.url).toBe('/v1beta/models?pageSize=1000&pageToken=p2');
    fake.answer = () => ({ status: 403, body: JSON.stringify({ error: { message: 'API key not valid' } }) });
    expect(await geminiBackend.models!('listening', { ...ctx('x'), account: { ...GEMINI, id: 'other' } })).toEqual(['gemini-2.5-flash', 'gemini-2.5-flash-lite', 'gemini-2.0-flash']);
    // An account the page cannot resolve yet (not bound): the same known models.
    const unbound = { ...ctx('x'), accounts: { resolve: async (): Promise<ResolvedProvider> => { throw new Error('not bound'); } } };
    expect(await geminiBackend.models!('speaking', unbound)).toEqual(['gemini-2.5-flash-preview-tts', 'gemini-2.5-pro-preview-tts']);
  });

  it('listens: the recording inline with the instruction, the transcript from the answer', async () => {
    fake.answer = () => ({ status: 200, body: geminiAnswer({ text: ' Hello from buddi. This is a test.\n' }) });
    const out = await geminiBackend.listener!.transcribe({ bytes: OGG_CLIP, mime: 'audio/ogg', language: 'fr' }, ctx('gemini-2.5-flash'));
    expect(out).toEqual({ text: 'Hello from buddi. This is a test.' });
    const req = fake.seen[0]!;
    expect(req).toMatchObject({ method: 'POST', url: '/v1beta/models/gemini-2.5-flash:generateContent' });
    expect(req.headers['x-goog-api-key']).toBe('AIza-test-key');
    const body = JSON.parse(req.body.toString()) as { contents: Array<{ parts: Array<{ text?: string; inline_data?: { mime_type: string; data: string } }> }> };
    const parts = body.contents[0]!.parts;
    expect(parts[0]!.text).toBe(transcribePrompt('fr'));
    expect(parts[0]!.text).toContain('It is in French.');
    expect(parts[1]!.inline_data!.mime_type).toBe('audio/ogg');
    expect(Buffer.from(parts[1]!.inline_data!.data, 'base64').equals(OGG_CLIP)).toBe(true);
  });

  it('speaks: a TTS request with the voice, its PCM answered as an OGG/Opus voice note', async () => {
    fake.answer = () => ({ status: 200, body: geminiAnswer({ audio: geminiPcm(1) }) });
    const out = await geminiBackend.speaker!.synthesize({ text: 'Hello.', voice: 'Puck', format: 'ogg-opus' }, ctx('gemini-2.5-flash-preview-tts'));
    expect(out.mime).toBe('audio/ogg');
    expect(sniffAudio(out.bytes)).toBe('audio/ogg');
    expect(isOggOpus(out.bytes)).toBe(true);
    const body = JSON.parse(fake.seen[0]!.body.toString());
    expect(body.generationConfig).toEqual({ responseModalities: ['AUDIO'], speechConfig: { voiceConfig: { prebuiltVoiceConfig: { voiceName: 'Puck' } } } });
    expect(body.contents[0].parts[0].text).toBe('Hello.');
    expect((await geminiBackend.voices!(ctx('x'))).map((v) => v.id)).toContain('Kore');
  });

  it('refuses in one sentence: an answer without audio, an error with Google\'s reason and never the key', async () => {
    fake.answer = () => ({ status: 200, body: geminiAnswer({ text: 'I cannot speak.' }) });
    await expect(geminiBackend.speaker!.synthesize({ text: 'Hi', format: 'ogg-opus' }, ctx('gemini-2.5-flash-preview-tts'))).rejects.toThrow('refused: Gemini answered without audio.');
    fake.answer = () => ({ status: 400, body: JSON.stringify({ error: { message: 'Bad key AIza-test-key here.' } }) });
    await expect(geminiBackend.listener!.transcribe({ bytes: OGG_CLIP, mime: 'audio/ogg' }, ctx('gemini-2.5-flash'))).rejects.toThrow('refused: Gemini answered 400: Bad key [key] here.');
  });

  it('turns 16-bit PCM into floats and a voice note, and refuses a rate Opus does not take', () => {
    expect(Array.from(pcm16ToFloat(Buffer.from([0x00, 0x80, 0xff, 0x7f])))).toEqual([-1, 32767 / 32768]);
    expect(isOggOpus(voiceNoteFromPcm(Buffer.from(geminiPcm(1), 'base64'), 'audio/L16;codec=pcm;rate=24000'))).toBe(true);
    expect(() => voiceNoteFromPcm(Buffer.alloc(10), 'audio/L16;rate=44100')).toThrow(/44100 Hz/);
  });
});
