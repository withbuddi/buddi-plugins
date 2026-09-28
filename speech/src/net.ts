/**
 * Every request this plugin makes goes through `ctx.buddi.http`: the model
 * and eSpeak downloads, and the calls to an OpenAI account. The host checks
 * each address (no loopback, no private network, ports 80 and 443) and logs a
 * host the manifest does not declare under `network`.
 *
 * The code below speaks `fetch`, so a test hands in its own and production
 * hands in `hostFetch(ctx.buddi.http)`: the same shape, over the host's
 * transport. The host never follows a redirect, so this does, one hop at a
 * time, each hop through the host again (Hugging Face answers every model
 * file with a redirect to its download servers).
 *
 * One exception, `directForOwnEndpoint`: an OpenAI-compatible account whose
 * address the host would refuse — a server on this computer or the LAN, or on
 * another port (LM Studio, a local Whisper server) — is the owner's own
 * endpoint, typed by them into Settings → Model accounts, and is reached
 * directly, as buddi reaches it for an agent's run.
 */
import { checkUrl, type HttpArea } from '@buddi/core/plugin';

/** The most an account's answer may be: twice the largest recording this plugin keeps. */
export const RESPONSE_CAP = 50 * 1024 * 1024;
/** The most one model file may be; the largest pinned one is 157 MB. */
export const DOWNLOAD_CAP = 300 * 1024 * 1024;

/** `{ fetch }` when there is one, `{}` otherwise (`exactOptionalPropertyTypes`). */
export function withFetch(f: typeof fetch | undefined): { fetch?: typeof fetch } {
  return f ? { fetch: f } : {};
}

const REDIRECTS = new Set([301, 302, 303, 307, 308]);
const MAX_REDIRECTS = 5;
/** Statuses a `Response` may not carry a body with. */
const NO_BODY = new Set([101, 204, 205, 304]);
const HOST_FETCH = Symbol.for('buddi.speech.hostFetch');

export interface HostFetchOptions {
  /** The most bytes one response may be; refused while it arrives. */
  maxBytes?: number;
}

/** A `fetch` over `ctx.buddi.http`, following redirects by hand. */
export function hostFetch(http: HttpArea, options: HostFetchOptions = {}): typeof fetch {
  const doFetch = async (input: string | URL | Request, init: RequestInit = {}): Promise<Response> => {
    let url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
    let method = (init.method ?? 'GET').toUpperCase();
    let headers = headerRecord(init.headers);
    let body: Buffer | undefined;
    if (init.body !== undefined && init.body !== null) {
      // FormData, a string, bytes: serialised the way fetch would, with its content type.
      const request = new Request('http://body.invalid/', { method: 'POST', body: init.body });
      body = Buffer.from(await request.arrayBuffer());
      const type = request.headers.get('content-type');
      if (type && !Object.keys(headers).some((k) => k.toLowerCase() === 'content-type')) headers['content-type'] = type;
    }
    const signal = init.signal ?? undefined;
    for (let hop = 0; ; hop++) {
      const response = await http.request({
        url,
        method,
        headers,
        ...(body === undefined ? {} : { body }),
        ...(signal ? { signal } : {}),
        ...(options.maxBytes === undefined ? {} : { maxBytes: options.maxBytes }),
      });
      const location = response.headers.get('location');
      if (!REDIRECTS.has(response.status) || !location || init.redirect === 'manual') {
        const bytes = NO_BODY.has(response.status) ? null : Buffer.from(await response.arrayBuffer());
        const contentType = response.headers.get('content-type');
        const length = response.headers.get('content-length');
        return new Response(bytes, {
          status: response.status < 200 || response.status > 599 ? 502 : response.status,
          statusText: response.statusText,
          headers: {
            ...(contentType ? { 'content-type': contentType } : {}),
            ...(length && bytes ? { 'content-length': String(bytes.length) } : {}),
          },
        });
      }
      if (init.redirect === 'error' || hop >= MAX_REDIRECTS) throw new Error(`too many redirects from ${new URL(url).host}`);
      const next = new URL(location, url);
      // A credential stays with the host it was meant for.
      if (next.origin !== new URL(url).origin) {
        headers = Object.fromEntries(Object.entries(headers).filter(([k]) => !['authorization', 'cookie'].includes(k.toLowerCase())));
      }
      if (response.status === 303 || ((response.status === 301 || response.status === 302) && method === 'POST')) {
        method = 'GET';
        body = undefined;
        headers = Object.fromEntries(Object.entries(headers).filter(([k]) => !['content-type', 'content-length'].includes(k.toLowerCase())));
      }
      url = next.href;
    }
  };
  return Object.assign(doFetch, { [HOST_FETCH]: true }) as unknown as typeof fetch;
}

/**
 * The fetch for a call to an account's `baseUrl`: the host's, unless the
 * account is the owner's own endpoint on an address the host refuses (see the
 * file comment). A test's fetch is always used as it is.
 */
export function directForOwnEndpoint(chosen: typeof fetch | undefined, baseUrl: string): typeof fetch {
  if (!chosen) return fetch;
  if (!(chosen as unknown as Record<symbol, unknown>)[HOST_FETCH]) return chosen;
  try {
    checkUrl(baseUrl);
    return chosen;
  } catch {
    return fetch;
  }
}

/** `fetch` over the host's `http` area, or undefined where the host has none (a test's own host). */
export function transportOf(buddi: { http?: HttpArea } | undefined, options: HostFetchOptions = {}): typeof fetch | undefined {
  return buddi?.http ? hostFetch(buddi.http, options) : undefined;
}

function headerRecord(headers: RequestInit['headers']): Record<string, string> {
  if (!headers) return {};
  if (headers instanceof Headers) return Object.fromEntries(headers.entries());
  if (Array.isArray(headers)) return Object.fromEntries(headers.map(([k, v]) => [k, v] as [string, string]));
  return { ...(headers as Record<string, string>) };
}
