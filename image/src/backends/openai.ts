/**
 * The OpenAI Images API, for an `openai` or an `openai-compatible` account.
 *
 * `POST <baseUrl>/images/generations` with no references, and
 * `POST <baseUrl>/images/edits` (multipart) with them. `baseUrl` is the
 * account's own, already ending in `/v1` (core's `accountBaseUrl`), and the
 * key comes from the account resolver — the same one an agent's run uses —
 * never from the environment. That covers OpenAI's image models and any
 * local or hosted server that speaks the same API, which many FLUX servers do.
 *
 * Gemini is served here too: a Gemini account is an `openai-compatible`
 * account at Google's OpenAI-compatible address, which answers
 * `images/generations` with Imagen models. It takes no reference pictures and
 * no `size`, so a request with references is refused and the shape is left to
 * the model. (Gemini's own "flash image" models answer pictures through chat
 * completions instead; they are not used here.)
 *
 * The picture comes back as `b64_json`. A server that answers with a `url`
 * instead is followed only when that URL is on the account's own origin: this
 * plugin does not fetch from wherever a response points.
 */
import type { ResolvedProvider } from '@buddi/core/plugin';
import { ImageRefusal, MAX_IMAGE_BYTES, SIZES, refusalFrom, type GenerateRequest, type GenerateResult, type ImageBackend } from './types.js';

export { SIZES } from './types.js';

export const DEFAULT_OPENAI_IMAGE_MODEL = 'gpt-image-1';
/** Google's newest Imagen, served on its OpenAI-compatible images endpoint. */
export const DEFAULT_GEMINI_IMAGE_MODEL = 'imagen-4.0-generate-001';
/** Where a Gemini account points (core's `GEMINI_BASE_URL`), by host. */
export const GEMINI_HOST = 'generativelanguage.googleapis.com';

export const GEMINI_NO_REFERENCES =
  "refused: Gemini's Imagen does not take reference pictures here, so ask without references or have the owner choose another account in Settings → Image.";

/** A Gemini account: an OpenAI-compatible account at Google's address. */
export function isGeminiAccount(account: { kind: string; baseUrl?: string | undefined }): boolean {
  if (account.kind !== 'openai-compatible' || !account.baseUrl) return false;
  try { return new URL(account.baseUrl).hostname === GEMINI_HOST; } catch { return false; }
}

export interface OpenAIImageOptions {
  provider: ResolvedProvider;
  /** Leave `size` out: the service shapes the picture itself (Imagen). */
  noSize?: boolean;
  timeoutMs: number;
  signal?: AbortSignal;
  fetch?: typeof fetch;
}

/** gpt-image models always answer base64 and refuse `response_format`. */
function wantsResponseFormat(model: string): boolean {
  return !/^gpt-image/i.test(model);
}

export async function openaiImage(request: GenerateRequest, options: OpenAIImageOptions): Promise<GenerateResult> {
  const { provider } = options;
  const doFetch = options.fetch ?? fetch;
  const base = provider.baseUrl.replace(/\/+$/, '');
  const timeout = AbortSignal.timeout(options.timeoutMs);
  const signal = options.signal ? AbortSignal.any([options.signal, timeout]) : timeout;
  const headers: Record<string, string> = {};
  if (provider.secret) headers.authorization = `Bearer ${provider.secret}`;

  let response: Response;
  try {
    if (request.references.length === 0) {
      response = await doFetch(`${base}/images/generations`, {
        method: 'POST',
        headers: { ...headers, 'content-type': 'application/json' },
        body: JSON.stringify({
          model: provider.model,
          prompt: request.prompt,
          n: 1,
          ...(options.noSize ? {} : { size: SIZES[request.aspect] }),
          ...(wantsResponseFormat(provider.model) ? { response_format: 'b64_json' } : {}),
        }),
        signal,
      });
    } else {
      const form = new FormData();
      form.set('model', provider.model);
      form.set('prompt', request.prompt);
      form.set('n', '1');
      form.set('size', SIZES[request.aspect]);
      if (wantsResponseFormat(provider.model)) form.set('response_format', 'b64_json');
      const field = request.references.length > 1 ? 'image[]' : 'image';
      for (const reference of request.references) {
        form.append(field, new Blob([new Uint8Array(reference.bytes)], { type: reference.mime }), reference.filename);
      }
      response = await doFetch(`${base}/images/edits`, { method: 'POST', headers, body: form, signal });
    }
  } catch {
    if (timeout.aborted) {
      throw new ImageRefusal(`refused: the image service did not answer within ${Math.round(options.timeoutMs / 1000)} seconds. Nothing was stored.`);
    }
    if (options.signal?.aborted) throw new ImageRefusal('refused: the image was cancelled. Nothing was stored.');
    throw new ImageRefusal(`refused: could not reach the image service at ${new URL(base).host}. Nothing was stored.`);
  }

  const text = await boundedText(response);
  if (!response.ok) {
    throw new ImageRefusal(`refused: the image service answered ${response.status}${serviceMessage(text, provider.secret)}. Nothing was stored.`);
  }
  let body: { data?: Array<{ b64_json?: unknown; url?: unknown }> };
  try { body = JSON.parse(text) as typeof body; } catch {
    throw new ImageRefusal('refused: the image service answered something that is not JSON. Nothing was stored.');
  }
  const first = Array.isArray(body.data) ? body.data[0] : undefined;
  if (first && typeof first.b64_json === 'string' && first.b64_json !== '') {
    return { bytes: Buffer.from(first.b64_json, 'base64') };
  }
  if (first && typeof first.url === 'string') {
    let url: URL;
    try { url = new URL(first.url, base); } catch { url = new URL('invalid:'); }
    if (url.origin !== new URL(base).origin) {
      throw new ImageRefusal(`refused: the image service pointed at another host (${url.host || 'unknown'}), which this plugin does not fetch from. Nothing was stored.`);
    }
    const picture = await doFetch(url, { headers, signal }).catch(() => null);
    if (!picture?.ok) throw new ImageRefusal('refused: the image service named a picture it then did not serve. Nothing was stored.');
    return { bytes: await boundedBytes(picture) };
  }
  throw new ImageRefusal('refused: the image service answered without an image. Nothing was stored.');
}

async function boundedBytes(response: Response): Promise<Buffer> {
  const declared = Number(response.headers.get('content-length') ?? '0');
  if (declared > MAX_IMAGE_BYTES * 2) throw new ImageRefusal('refused: the image service answered with more than this plugin keeps. Nothing was stored.');
  const bytes = Buffer.from(await response.arrayBuffer());
  if (bytes.length > MAX_IMAGE_BYTES * 2) throw new ImageRefusal('refused: the image service answered with more than this plugin keeps. Nothing was stored.');
  return bytes;
}

async function boundedText(response: Response): Promise<string> {
  return (await boundedBytes(response)).toString('utf8');
}

/** The service's own one-line reason (a safety refusal, an unknown model), never the key. */
function serviceMessage(text: string, secret: string): string {
  try {
    const parsed = JSON.parse(text) as { error?: { message?: unknown } | string };
    const raw = typeof parsed.error === 'string' ? parsed.error : parsed.error?.message;
    if (typeof raw !== 'string' || raw.trim() === '') return '';
    let message = raw.replace(/\s+/g, ' ').trim().slice(0, 240);
    if (secret) message = message.split(secret).join('[key]');
    return `: ${message}`;
  } catch {
    return '';
  }
}

function openaiFamily(kind: 'openai' | 'openai-compatible', label: string, defaultModel: (account: { defaultModel: string }) => string): ImageBackend {
  return {
    kind,
    label,
    serves: (account) => account.kind === kind && !isGeminiAccount(account),
    defaultModel,
    async generate(request, context) {
      let provider: ResolvedProvider;
      try { provider = await context.accounts.resolve(context.account.id, context.model, context.signal); }
      catch (error) { throw refusalFrom(error); }
      return openaiImage(request, { provider, timeoutMs: context.timeoutMs, signal: context.signal });
    },
  };
}

export const openaiBackend = openaiFamily('openai', 'OpenAI Images API', () => DEFAULT_OPENAI_IMAGE_MODEL);
/**
 * Any service with an OpenAI-compatible Images API (a local or hosted FLUX
 * server, for instance). The model is whatever that service calls it: the
 * owner types it on the settings page, and until then the account's own
 * default model is asked for.
 */
export const openaiCompatibleBackend = openaiFamily('openai-compatible', 'OpenAI-compatible Images API', (account) => account.defaultModel);

export const geminiBackend: ImageBackend = {
  kind: 'gemini',
  label: 'Gemini (Imagen)',
  serves: isGeminiAccount,
  defaultModel: () => DEFAULT_GEMINI_IMAGE_MODEL,
  async generate(request, context) {
    if (request.references.length > 0) throw new ImageRefusal(GEMINI_NO_REFERENCES);
    let provider: ResolvedProvider;
    try { provider = await context.accounts.resolve(context.account.id, context.model, context.signal); }
    catch (error) { throw refusalFrom(error); }
    return openaiImage(request, { provider, noSize: true, timeoutMs: context.timeoutMs, signal: context.signal });
  },
};
