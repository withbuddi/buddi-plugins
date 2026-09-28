/** `hostFetch`: fetch's shape over `ctx.buddi.http`, redirects followed hop by hop through the host. */
import { describe, expect, it } from 'vitest';
import type { HttpArea, HttpRequest, HttpResponse } from '@buddi/core/plugin';
import { directForOwnEndpoint, hostFetch } from './net.js';

function answer(status: number, body: string, headers: Record<string, string> = {}): HttpResponse {
  const lower = Object.fromEntries(Object.entries(headers).map(([k, v]) => [k.toLowerCase(), v]));
  return {
    ok: status >= 200 && status < 300,
    status,
    statusText: '',
    headers: { get: (name) => lower[name.toLowerCase()] ?? null },
    text: async () => body,
    json: async () => JSON.parse(body),
    arrayBuffer: async () => new TextEncoder().encode(body).buffer as ArrayBuffer,
  };
}

function fakeHttp(route: (req: HttpRequest) => HttpResponse): HttpArea & { seen: HttpRequest[] } {
  const seen: HttpRequest[] = [];
  return { seen, request: async (req) => { seen.push(req); return route(req); } };
}

describe('hostFetch', () => {
  it('follows a redirect to another host through the host again, relative ones too, and drops the credential', async () => {
    const http = fakeHttp((req) => {
      if (req.url === 'https://huggingface.co/m/resolve/c/a.onnx') return answer(302, '', { location: 'https://us.aws.cdn.hf.co/x/a' });
      if (req.url === 'https://huggingface.co/m/resolve/c/config.json') return answer(307, '', { location: '/api/resolve-cache/config.json' });
      return answer(200, `served ${req.url}`, { 'content-type': 'text/plain' });
    });
    const f = hostFetch(http, { maxBytes: 1000 });
    const a = await f('https://huggingface.co/m/resolve/c/a.onnx', { headers: { authorization: 'Bearer k' } });
    expect(await a.text()).toBe('served https://us.aws.cdn.hf.co/x/a');
    expect(http.seen[1]!.headers).toEqual({});
    expect(http.seen[1]!.maxBytes).toBe(1000);
    const c = await f('https://huggingface.co/m/resolve/c/config.json');
    expect(await c.text()).toBe('served https://huggingface.co/api/resolve-cache/config.json');
  });

  it('sends a FormData body as bytes with its multipart type, and passes an error status on', async () => {
    const http = fakeHttp(() => answer(401, '{"error":{"message":"bad key"}}'));
    const form = new FormData();
    form.set('model', 'whisper-1');
    const response = await hostFetch(http)('https://api.openai.com/v1/audio/transcriptions', { method: 'POST', body: form });
    expect(response.status).toBe(401);
    expect(http.seen[0]!.headers!['content-type']).toMatch(/^multipart\/form-data; boundary=/);
    expect(Buffer.isBuffer(http.seen[0]!.body)).toBe(true);
    expect(String(http.seen[0]!.body)).toContain('whisper-1');
  });

  it('stops after five redirects', async () => {
    const http = fakeHttp((req) => answer(302, '', { location: `${req.url}x` }));
    await expect(hostFetch(http)('https://a.example/')).rejects.toThrow(/too many redirects/);
  });
});

describe('directForOwnEndpoint', () => {
  const host = hostFetch(fakeHttp(() => answer(200, '')));
  it('keeps the host for a public endpoint, and a test fetch always', () => {
    expect(directForOwnEndpoint(host, 'https://api.openai.com/v1')).toBe(host);
    const own = (async () => new Response('')) as unknown as typeof fetch;
    expect(directForOwnEndpoint(own, 'http://127.0.0.1:1234/v1')).toBe(own);
  });
  it("reaches the owner's own local server directly", () => {
    expect(directForOwnEndpoint(host, 'http://127.0.0.1:1234/v1')).toBe(fetch);
    expect(directForOwnEndpoint(host, 'http://localhost:8000/v1')).toBe(fetch);
  });
});
