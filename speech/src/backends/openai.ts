/**
 * OpenAI's audio routes, for an `openai` or an `openai-compatible` account.
 *
 * `POST <baseUrl>/audio/transcriptions` (multipart: the file, `model`,
 * optional `language`, `response_format: json`) and
 * `POST <baseUrl>/audio/speech` (JSON: `model`, `input`, `voice`,
 * `response_format`). `baseUrl` is the account's own, already ending in `/v1`
 * (core's `accountBaseUrl`), and the key comes from the account resolver,
 * the same one an agent's run uses, never from the environment. That covers
 * OpenAI and any server that answers the same two routes: local Whisper
 * servers, LM Studio, speaches, a Kokoro or Breeze server behind an
 * OpenAI-shaped route.
 *
 * The models are the owner's field on the page; the defaults below are only
 * what a blank field means (OpenAI renames these often, so nothing else in
 * the code depends on them). Opus is asked for directly, so a Telegram voice
 * note needs no encoder.
 */
import type { ResolvedProvider } from '@buddi/core/plugin';
import { directForOwnEndpoint } from '../net.js';
import { AUDIO_EXTENSIONS, type AudioMime, type SpeakFormat } from '../magic.js';
import {
  SpeechRefusal,
  type BackendContext,
  type ListenRequest,
  type ListenResult,
  type SpeakRequest,
  type SpeakResult,
  type SpeechBackend,
  type Voice,
} from './types.js';

export const DEFAULT_TRANSCRIBE_MODEL = 'gpt-4o-mini-transcribe';
export const DEFAULT_SPEECH_MODEL = 'gpt-4o-mini-tts';
export const DEFAULT_VOICE = 'alloy';

/** The largest recording OpenAI's transcription route takes, and the largest answer kept. */
export const MAX_AUDIO_BYTES = 25 * 1024 * 1024;

/** OpenAI's fixed voice names. Most compatible servers map them too. */
export const OPENAI_VOICES: readonly string[] = [
  'alloy', 'ash', 'ballad', 'coral', 'echo', 'fable', 'nova', 'onyx', 'sage', 'shimmer', 'verse',
];

/** The `response_format` each asked-for format is requested as. */
export const RESPONSE_FORMATS: Record<SpeakFormat, 'opus' | 'mp3' | 'aac'> = {
  'ogg-opus': 'opus',
  mp3: 'mp3',
  m4a: 'aac',
};

const RESPONSE_MIMES: Record<SpeakFormat, string> = {
  'ogg-opus': 'audio/ogg',
  mp3: 'audio/mpeg',
  m4a: 'audio/aac',
};

export interface OpenAIAudioOptions {
  provider: ResolvedProvider;
  timeoutMs: number;
  signal?: AbortSignal;
  fetch?: typeof fetch;
}

/** Speech to text on `/audio/transcriptions`. */
export async function openaiTranscribe(audio: ListenRequest, options: OpenAIAudioOptions): Promise<ListenResult> {
  const form = new FormData();
  const ext = AUDIO_EXTENSIONS[audio.mime as AudioMime] ?? 'ogg';
  form.set('file', new Blob([new Uint8Array(audio.bytes)], { type: audio.mime }), `audio.${ext}`);
  form.set('model', options.provider.model);
  if (audio.language) form.set('language', audio.language);
  form.set('response_format', 'json');
  const response = await send(options, '/audio/transcriptions', { body: form }, 'listening');
  const text = (await bounded(response, options.provider.secret, 'listening')).toString('utf8');
  let body: { text?: unknown; language?: unknown };
  try { body = JSON.parse(text) as typeof body; } catch {
    throw new SpeechRefusal('refused: the listening service answered something that is not JSON.');
  }
  if (typeof body.text !== 'string') throw new SpeechRefusal('refused: the listening service answered without a transcript.');
  return {
    text: body.text.trim(),
    ...(typeof body.language === 'string' && body.language !== '' ? { language: body.language } : {}),
  };
}

/** Text to speech on `/audio/speech`. */
export async function openaiSynthesize(request: SpeakRequest, voice: string, options: OpenAIAudioOptions): Promise<SpeakResult> {
  const response = await send(
    options,
    '/audio/speech',
    {
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        model: options.provider.model,
        input: request.text,
        voice,
        response_format: RESPONSE_FORMATS[request.format],
      }),
    },
    'speaking',
  );
  const bytes = await bounded(response, options.provider.secret, 'speaking');
  return { bytes, mime: response.headers.get('content-type')?.split(';')[0]?.trim() || RESPONSE_MIMES[request.format] };
}

type Side = 'listening' | 'speaking';

async function send(options: OpenAIAudioOptions, route: string, init: { headers?: Record<string, string>; body: FormData | string }, side: Side): Promise<Response> {
  const { provider } = options;
  if (isOllamaCloud(provider)) {
    throw new SpeechRefusal(`refused: an Ollama Cloud account serves no audio routes. Choose an OpenAI or OpenAI-compatible account in Settings → Speech.`);
  }
  const base = provider.baseUrl.replace(/\/+$/, '');
  const doFetch = directForOwnEndpoint(options.fetch, base);
  const timeout = AbortSignal.timeout(options.timeoutMs);
  const signal = options.signal ? AbortSignal.any([options.signal, timeout]) : timeout;
  const headers: Record<string, string> = { ...(init.headers ?? {}) };
  if (provider.secret) headers.authorization = `Bearer ${provider.secret}`;
  const service = side === 'listening' ? 'listening service' : 'speaking service';
  let response: Response;
  try {
    response = await doFetch(`${base}${route}`, { method: 'POST', headers, body: init.body, signal });
  } catch {
    if (timeout.aborted) {
      const seconds = Math.max(1, Math.round(options.timeoutMs / 1000));
      throw new SpeechRefusal(`refused: the ${service} did not answer within ${seconds} second${seconds === 1 ? '' : 's'}.`);
    }
    if (options.signal?.aborted) throw new SpeechRefusal('refused: the call was cancelled.');
    throw new SpeechRefusal(`refused: could not reach the ${service} at ${hostOf(base)}.`);
  }
  if (!response.ok) {
    const text = (await bounded(response, provider.secret, side).catch(() => Buffer.alloc(0))).toString('utf8');
    throw new SpeechRefusal(`refused: the ${service} answered ${response.status}${serviceMessage(text, provider.secret)}.`);
  }
  return response;
}

/** Ollama Cloud, by a device key or by its address: it serves no audio routes. */
export function isOllamaCloud(provider: Pick<ResolvedProvider, 'baseUrl' | 'deviceKey'>): boolean {
  return Boolean(provider.deviceKey) || hostOf(provider.baseUrl) === 'ollama.com';
}

function hostOf(base: string): string {
  try { return new URL(base).host; } catch { return 'its address'; }
}

async function bounded(response: Response, _secret: string, side: Side): Promise<Buffer> {
  const service = side === 'listening' ? 'listening service' : 'speaking service';
  const declared = Number(response.headers.get('content-length') ?? '0');
  if (declared > MAX_AUDIO_BYTES) throw new SpeechRefusal(`refused: the ${service} answered with more than this plugin keeps.`);
  const bytes = Buffer.from(await response.arrayBuffer());
  if (bytes.length > MAX_AUDIO_BYTES) throw new SpeechRefusal(`refused: the ${service} answered with more than this plugin keeps.`);
  return bytes;
}

/** The service's own one-line reason (an unknown model, a quota), never the key. */
function serviceMessage(text: string, secret: string): string {
  try {
    const parsed = JSON.parse(text) as { error?: { message?: unknown } | string };
    const raw = typeof parsed.error === 'string' ? parsed.error : parsed.error?.message;
    if (typeof raw !== 'string' || raw.trim() === '') return '';
    let message = raw.replace(/\s+/g, ' ').trim().replace(/\.+$/, '').slice(0, 240);
    if (secret) message = message.split(secret).join('[key]');
    return `: ${message}`;
  } catch {
    return '';
  }
}

/** Which ids are for which side, by name: OpenAI's and most servers' naming. */
export const MODEL_PATTERNS: Record<Side, RegExp> = { listening: /transcribe|whisper/i, speaking: /tts|speech/i };
export const MODELS_TTL_MS = 10 * 60_000;
const modelCache = new Map<string, { at: number; ids: string[] }>();

/** For tests: forget what `GET /models` answered. */
export function clearModelCache(): void {
  modelCache.clear();
}

/**
 * `GET <baseUrl>/models`: every id the account's server lists, cached ten
 * minutes per account. A failure is an empty list, not cached.
 */
export async function accountModelIds(
  cacheKey: string,
  options: { provider: ResolvedProvider; timeoutMs: number; signal?: AbortSignal; fetch?: typeof fetch; now?: number },
): Promise<string[]> {
  const now = options.now ?? Date.now();
  const hit = modelCache.get(cacheKey);
  if (hit && now - hit.at < MODELS_TTL_MS) return hit.ids;
  const { provider } = options;
  if (isOllamaCloud(provider)) return [];
  const timeout = AbortSignal.timeout(options.timeoutMs);
  const signal = options.signal ? AbortSignal.any([options.signal, timeout]) : timeout;
  try {
    const response = await directForOwnEndpoint(options.fetch, provider.baseUrl)(`${provider.baseUrl.replace(/\/+$/, '')}/models`, {
      method: 'GET',
      headers: provider.secret ? { authorization: `Bearer ${provider.secret}` } : {},
      signal,
    });
    if (!response.ok) return [];
    const body = JSON.parse((await bounded(response, provider.secret, 'listening')).toString('utf8')) as { data?: unknown };
    const ids = (Array.isArray(body.data) ? body.data : [])
      .map((m) => (m && typeof m === 'object' ? (m as { id?: unknown }).id : undefined))
      .filter((id): id is string => typeof id === 'string' && id.length > 0 && id.length <= 150 && !/[\r\n\x00-\x1f]/.test(id));
    modelCache.set(cacheKey, { at: now, ids });
    return ids;
  } catch {
    return [];
  }
}

/** The ids for one side: the default first, then the matching ones sorted. */
export function modelsFor(side: Side, ids: readonly string[], defaultModel: string): string[] {
  const found = [...new Set(ids.filter((id) => MODEL_PATTERNS[side].test(id) && id !== defaultModel))].sort();
  return [defaultModel, ...found];
}

async function provider(ctx: BackendContext): Promise<ResolvedProvider> {
  if (!ctx.accounts || !ctx.account) throw new SpeechRefusal('refused: no speech account is chosen. The owner picks one in Settings → Speech.');
  return ctx.accounts.resolve(ctx.account.id, ctx.model, ctx.signal);
}

function openaiFamily(kind: 'openai' | 'openai-compatible', label: string, where: string): SpeechBackend {
  const voices = async (): Promise<Voice[]> => OPENAI_VOICES.map((id) => ({ id, label: id[0]!.toUpperCase() + id.slice(1) }));
  return {
    kind,
    label,
    accountKind: kind,
    // OpenAI's own list is fixed; a compatible server names its own voices.
    ...(kind === 'openai' ? { closedVoices: true } : {}),
    leaves: {
      listening: `The recording goes to ${where}, which sends back the text.`,
      speaking: `The text to say goes to ${where}, which sends back the audio.`,
    },
    listener: {
      defaultModel: DEFAULT_TRANSCRIBE_MODEL,
      async transcribe(audio, ctx) {
        return openaiTranscribe(audio, { provider: await provider(ctx), timeoutMs: ctx.timeoutMs, signal: ctx.signal, ...(ctx.fetch ? { fetch: ctx.fetch } : {}) });
      },
    },
    speaker: {
      defaultModel: DEFAULT_SPEECH_MODEL,
      defaultVoice: DEFAULT_VOICE,
      async synthesize(request, ctx) {
        return openaiSynthesize(request, request.voice ?? DEFAULT_VOICE, {
          provider: await provider(ctx), timeoutMs: ctx.timeoutMs, signal: ctx.signal, ...(ctx.fetch ? { fetch: ctx.fetch } : {}),
        });
      },
    },
    voices,
    async models(side, ctx) {
      const fallback = side === 'listening' ? DEFAULT_TRANSCRIBE_MODEL : DEFAULT_SPEECH_MODEL;
      if (!ctx.accounts || !ctx.account) return [fallback];
      let resolved: ResolvedProvider;
      try {
        resolved = await ctx.accounts.resolve(ctx.account.id, fallback, ctx.signal);
      } catch {
        // Not bound yet, a locked vault: the default, and the field still takes a typed id.
        return [fallback];
      }
      const ids = await accountModelIds(ctx.account.id, {
        provider: resolved, timeoutMs: ctx.timeoutMs, signal: ctx.signal, ...(ctx.fetch ? { fetch: ctx.fetch } : {}),
      });
      return modelsFor(side, ids, fallback);
    },
  };
}

export const openaiBackend = openaiFamily('openai', 'OpenAI', 'OpenAI (api.openai.com)');
export const openaiCompatibleBackend = openaiFamily('openai-compatible', 'OpenAI-compatible', "your OpenAI-compatible account's server");
