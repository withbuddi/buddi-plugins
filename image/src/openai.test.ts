/**
 * The Images API backend against a local fake server that speaks it:
 * generations, edits with references, a `url` answer, and the refusals.
 */
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { ResolvedProvider } from '@buddi/core/testing';
import { GEMINI_NO_REFERENCES, geminiBackend, openaiCompatibleBackend, openaiImage } from './backends/openai.js';
import type { BackendContext } from './backends/types.js';
import { sniffImage } from './magic.js';
import { PNG_1x1, pngOf } from './testing/fixtures.js';

interface Seen { method: string; url: string; headers: http.IncomingHttpHeaders; body: Buffer }
let server: http.Server;
let base = '';
const seen: Seen[] = [];
let answer: (req: Seen) => { status: number; type?: string; body: string | Buffer } = () => ({ status: 500, body: '' });

beforeAll(async () => {
  server = http.createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on('data', (c: Buffer) => chunks.push(c));
    req.on('end', () => {
      const entry = { method: req.method ?? '', url: req.url ?? '', headers: req.headers, body: Buffer.concat(chunks) };
      seen.push(entry);
      const out = answer(entry);
      res.statusCode = out.status;
      res.setHeader('content-type', out.type ?? 'application/json');
      res.end(out.body);
    });
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}/v1`;
});
afterAll(() => new Promise<void>((resolve) => server.close(() => resolve())));

const provider = (model = 'flux-dev', secret = 'sk-local-secret'): ResolvedProvider => ({
  kind: 'openai', baseUrl: base, credentialKind: 'api-key', secret, model, compatible: true,
});
const b64 = pngOf(1024, 1536).toString('base64');

describe('OpenAI Images API backend', () => {
  it('posts a generation with the account key and model, and decodes b64_json', async () => {
    seen.length = 0;
    answer = () => ({ status: 200, body: JSON.stringify({ data: [{ b64_json: b64 }] }) });
    const result = await openaiImage({ prompt: 'a fox', references: [], aspect: 'portrait' }, { provider: provider(), timeoutMs: 5_000 });
    expect(sniffImage(result.bytes)).toMatchObject({ width: 1024, height: 1536 });
    expect(seen[0]!.url).toBe('/v1/images/generations');
    expect(seen[0]!.headers.authorization).toBe('Bearer sk-local-secret');
    expect(JSON.parse(seen[0]!.body.toString())).toEqual({ model: 'flux-dev', prompt: 'a fox', n: 1, size: '1024x1536', response_format: 'b64_json' });
  });

  it('does not send response_format to a gpt-image model, nor a key to a keyless account', async () => {
    seen.length = 0;
    answer = () => ({ status: 200, body: JSON.stringify({ data: [{ b64_json: b64 }] }) });
    await openaiImage({ prompt: 'a fox', references: [], aspect: 'square' }, { provider: provider('gpt-image-1', ''), timeoutMs: 5_000 });
    expect(JSON.parse(seen[0]!.body.toString())).toEqual({ model: 'gpt-image-1', prompt: 'a fox', n: 1, size: '1024x1024' });
    expect(seen[0]!.headers.authorization).toBeUndefined();
  });

  it('sends references as a multipart edit', async () => {
    seen.length = 0;
    answer = () => ({ status: 200, body: JSON.stringify({ data: [{ b64_json: b64 }] }) });
    await openaiImage(
      { prompt: 'same fox, new pose', aspect: 'landscape', references: [
        { bytes: PNG_1x1, mime: 'image/png', filename: 'fox.png' },
        { bytes: PNG_1x1, mime: 'image/png', filename: 'fox2.png' },
      ] },
      { provider: provider(), timeoutMs: 5_000 },
    );
    const req = seen[0]!;
    expect(req.url).toBe('/v1/images/edits');
    expect(req.headers['content-type']).toMatch(/^multipart\/form-data; boundary=/);
    const body = req.body.toString('latin1');
    expect(body).toContain('name="image[]"; filename="fox.png"');
    expect(body).toContain('name="image[]"; filename="fox2.png"');
    expect(body).toContain('same fox, new pose');
    expect(body).toContain('1536x1024');
    expect(req.body.includes(PNG_1x1)).toBe(true);
  });

  it('follows a url answer on the account origin only', async () => {
    answer = (req) => req.url === '/files/out.png'
      ? { status: 200, type: 'image/png', body: pngOf(8, 8) }
      : { status: 200, body: JSON.stringify({ data: [{ url: `${base.replace('/v1', '')}/files/out.png` }] }) };
    const result = await openaiImage({ prompt: 'x', references: [], aspect: 'square' }, { provider: provider(), timeoutMs: 5_000 });
    expect(sniffImage(result.bytes)).toMatchObject({ width: 8, height: 8 });

    answer = () => ({ status: 200, body: JSON.stringify({ data: [{ url: 'https://elsewhere.example/out.png' }] }) });
    await expect(openaiImage({ prompt: 'x', references: [], aspect: 'square' }, { provider: provider(), timeoutMs: 5_000 }))
      .rejects.toThrow(/another host \(elsewhere.example\)/);
  });

  it("refuses an error answer with the service's own reason, never the key", async () => {
    answer = () => ({ status: 400, body: JSON.stringify({ error: { message: 'Rejected by the safety system for key sk-local-secret.' } }) });
    const failure = openaiImage({ prompt: 'x', references: [], aspect: 'square' }, { provider: provider(), timeoutMs: 5_000 });
    await expect(failure).rejects.toThrow(/answered 400: Rejected by the safety system for key \[key\]/);
  });

  it('refuses an answer with no image, and a timeout', async () => {
    answer = () => ({ status: 200, body: JSON.stringify({ data: [] }) });
    await expect(openaiImage({ prompt: 'x', references: [], aspect: 'square' }, { provider: provider(), timeoutMs: 5_000 }))
      .rejects.toThrow(/without an image/);
    const slow = http.createServer(() => { /* never answers */ });
    await new Promise<void>((resolve) => slow.listen(0, '127.0.0.1', resolve));
    const slowBase = `http://127.0.0.1:${(slow.address() as AddressInfo).port}/v1`;
    await expect(openaiImage({ prompt: 'x', references: [], aspect: 'square' }, { provider: { ...provider(), baseUrl: slowBase }, timeoutMs: 300 }))
      .rejects.toThrow(/did not answer within/);
    slow.closeAllConnections(); slow.close();
  });

  it('shapes Gemini as Imagen on the generations endpoint, without size, and refuses references', async () => {
    seen.length = 0;
    answer = () => ({ status: 200, body: JSON.stringify({ data: [{ b64_json: b64 }] }) });
    const resolved: string[] = [];
    const gemini = { id: 'gem-1', label: 'Gemini', kind: 'openai-compatible' as const, enabled: true, configured: true, defaultModel: 'gemini-2.5-flash', baseUrl: 'https://generativelanguage.googleapis.com/v1beta/openai' };
    const context: BackendContext = {
      accounts: { resolve: async (id, model) => { resolved.push(`${id}:${model}`); return { ...provider(model, 'AIza-test'), baseUrl: `${base.replace('/v1', '')}/v1beta/openai` }; } },
      account: gemini, model: geminiBackend.defaultModel(gemini), signal: new AbortController().signal, timeoutMs: 5_000,
    };
    expect(geminiBackend.label).toBe('Gemini (Imagen)');
    expect(context.model).toBe('imagen-4.0-generate-001');
    await geminiBackend.generate({ prompt: 'a fox', references: [], aspect: 'portrait' }, context);
    expect(resolved).toEqual(['gem-1:imagen-4.0-generate-001']);
    expect(seen[0]!.url).toBe('/v1beta/openai/images/generations');
    expect(seen[0]!.headers.authorization).toBe('Bearer AIza-test');
    expect(JSON.parse(seen[0]!.body.toString())).toEqual({ model: 'imagen-4.0-generate-001', prompt: 'a fox', n: 1, response_format: 'b64_json' });

    seen.length = 0;
    await expect(geminiBackend.generate({ prompt: 'a fox', references: [{ bytes: PNG_1x1, mime: 'image/png', filename: 'a.png' }], aspect: 'square' }, context))
      .rejects.toThrow(GEMINI_NO_REFERENCES);
    expect(seen).toHaveLength(0);
    expect(GEMINI_NO_REFERENCES.split('. ')).toHaveLength(1);
  });

  it('lets a compatible account use any model, defaulting to its own', async () => {
    seen.length = 0;
    answer = () => ({ status: 200, body: JSON.stringify({ data: [{ b64_json: b64 }] }) });
    const local = { id: 'flux-1', label: 'Local FLUX', kind: 'openai-compatible' as const, enabled: true, configured: true, defaultModel: 'flux-schnell', baseUrl: base };
    expect(openaiCompatibleBackend.defaultModel(local)).toBe('flux-schnell');
    const context: BackendContext = {
      accounts: { resolve: async (_id, model) => provider(model) },
      account: local, model: 'my/any-model:v2', signal: new AbortController().signal, timeoutMs: 5_000,
    };
    await openaiCompatibleBackend.generate({ prompt: 'a fox', references: [], aspect: 'square' }, context);
    expect(JSON.parse(seen[0]!.body.toString())).toMatchObject({ model: 'my/any-model:v2', size: '1024x1024' });
  });
});
