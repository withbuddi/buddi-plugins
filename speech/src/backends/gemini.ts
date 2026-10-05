/**
 * Gemini, for an OpenAI-compatible account on Google's address
 * (`generativelanguage.googleapis.com`, a Google AI Studio key).
 *
 * Google's OpenAI-compatible routes have no `/audio/transcriptions` and no
 * `/audio/speech`, so this backend speaks the Gemini API itself, on the same
 * host and with the same key (`x-goog-api-key`):
 *
 * - listening: `POST /v1beta/models/<model>:generateContent` with the
 *   recording inline and an instruction to write down what is said;
 * - speaking: the same route on a TTS model with `responseModalities:
 *   ['AUDIO']` and a prebuilt voice, which answers 16-bit PCM that this
 *   plugin encodes to OGG/Opus itself;
 * - models: `GET /v1beta/models`, kept by `supportedGenerationMethods`
 *   (`generateContent`): Flash models for listening, TTS models for speaking.
 *   A Live-only model (`bidiGenerateContent` alone, the native-audio dialog
 *   ones) cannot take a file, so it is not offered.
 */
import type { ResolvedProvider } from '@buddi/core/plugin';
import { encodeOggOpus, type OpusRate } from '../local/ogg-opus.js';
import { directForOwnEndpoint } from '../net.js';
import { languageName } from '../languages.js';
import { MAX_AUDIO_BYTES } from './openai.js';
import { SpeechRefusal, type BackendContext, type SpeechBackend, type Voice } from './types.js';

export const GEMINI_HOST = 'generativelanguage.googleapis.com';
export const GEMINI_LISTEN_MODEL = 'gemini-2.5-flash';
export const GEMINI_SPEAK_MODEL = 'gemini-2.5-flash-preview-tts';
export const GEMINI_DEFAULT_VOICE = 'Kore';

/** Gemini's prebuilt voices, as its speech generation guide names them. */
export const GEMINI_VOICES: readonly string[] = [
  'Zephyr', 'Puck', 'Charon', 'Kore', 'Fenrir', 'Leda', 'Orus', 'Aoede', 'Callirrhoe', 'Autonoe',
  'Enceladus', 'Iapetus', 'Umbriel', 'Algieba', 'Despina', 'Erinome', 'Algenib', 'Rasalgethi', 'Laomedeia', 'Achernar',
  'Alnilam', 'Schedar', 'Gacrux', 'Pulcherrima', 'Achird', 'Zubenelgenubi', 'Vindemiatrix', 'Sadachbia', 'Sadaltager', 'Sulafat',
];

/** Whether an address is Google's Gemini API. */
export function isGeminiUrl(baseUrl: string | undefined): boolean {
  try {
    return new URL(baseUrl ?? '').hostname.toLowerCase() === GEMINI_HOST;
  } catch {
    return false;
  }
}

/** `https://generativelanguage.googleapis.com/v1beta`, from the account's OpenAI-compatible address. */
export function geminiRoot(baseUrl: string): string {
  return `${new URL(baseUrl).origin}/v1beta`;
}

type Side = 'listening' | 'speaking';

async function provider(ctx: BackendContext): Promise<ResolvedProvider> {
  if (!ctx.accounts || !ctx.account) throw new SpeechRefusal('refused: no speech account is chosen. The owner picks one in Settings → Speech.');
  return ctx.accounts.resolve(ctx.account.id, ctx.model, ctx.signal);
}

async function call(
  resolved: ResolvedProvider,
  ctx: Pick<BackendContext, 'signal' | 'timeoutMs' | 'fetch'>,
  route: string,
  init: { method: 'GET' | 'POST'; body?: unknown },
  side: Side,
): Promise<unknown> {
  const root = geminiRoot(resolved.baseUrl);
  const doFetch = directForOwnEndpoint(ctx.fetch, root);
  const timeout = AbortSignal.timeout(ctx.timeoutMs);
  const signal = AbortSignal.any([ctx.signal, timeout]);
  const service = side === 'listening' ? 'listening service' : 'speaking service';
  const headers: Record<string, string> = { 'x-goog-api-key': resolved.secret };
  if (init.body !== undefined) headers['content-type'] = 'application/json';
  let response: Response;
  try {
    response = await doFetch(`${root}${route}`, {
      method: init.method, headers, ...(init.body !== undefined ? { body: JSON.stringify(init.body) } : {}), signal,
    });
  } catch {
    if (timeout.aborted) {
      const seconds = Math.max(1, Math.round(ctx.timeoutMs / 1000));
      throw new SpeechRefusal(`refused: Gemini did not answer within ${seconds} second${seconds === 1 ? '' : 's'}.`);
    }
    if (ctx.signal.aborted) throw new SpeechRefusal('refused: the call was cancelled.');
    throw new SpeechRefusal(`refused: could not reach the ${service} at ${GEMINI_HOST}.`);
  }
  const declared = Number(response.headers.get('content-length') ?? '0');
  if (declared > MAX_AUDIO_BYTES * 2) throw new SpeechRefusal(`refused: the ${service} answered with more than this plugin keeps.`);
  const text = Buffer.from(await response.arrayBuffer()).toString('utf8');
  let body: unknown;
  try { body = JSON.parse(text); } catch { body = undefined; }
  if (!response.ok) {
    const raw = (body as { error?: { message?: unknown } } | undefined)?.error?.message;
    let message = typeof raw === 'string' ? raw.replace(/\s+/g, ' ').trim().replace(/\.+$/, '').slice(0, 240) : '';
    if (resolved.secret) message = message.split(resolved.secret).join('[key]');
    throw new SpeechRefusal(`refused: Gemini answered ${response.status}${message ? `: ${message}` : ''}.`);
  }
  if (body === undefined) throw new SpeechRefusal(`refused: the ${service} answered something that is not JSON.`);
  return body;
}

interface Part { text?: unknown; inlineData?: { mimeType?: unknown; data?: unknown }; inline_data?: { mime_type?: unknown; data?: unknown } }

function partsOf(body: unknown): Part[] {
  const candidates = (body as { candidates?: Array<{ content?: { parts?: Part[] } }> }).candidates;
  return Array.isArray(candidates) ? (candidates[0]?.content?.parts ?? []) : [];
}

/** The instruction a recording goes with. */
export function transcribePrompt(language?: string, languages?: readonly string[]): string {
  const hint = language
    ? ` It is in ${languageName(language)}.`
    : languages && languages.length > 1 ? ` It is in one of ${languages.map(languageName).join(', ')}.` : '';
  return `Write down exactly what is said in this recording, word for word, in the language it is spoken in.${hint} ` +
    'Answer with the words alone: no quotes, no labels, no notes. If nothing is said, answer with nothing.';
}

/**
 * 16-bit little-endian PCM to floats. Gemini says `audio/L16;codec=pcm;rate=24000`.
 */
export function pcm16ToFloat(bytes: Buffer): Float32Array {
  const out = new Float32Array(Math.floor(bytes.length / 2));
  for (let i = 0; i < out.length; i++) out[i] = bytes.readInt16LE(i * 2) / 0x8000;
  return out;
}

const OPUS_RATES: readonly number[] = [8000, 12000, 16000, 24000, 48000];

/** Gemini's PCM as a voice note: OGG/Opus at its own rate, which every rate Gemini uses is. */
export function voiceNoteFromPcm(bytes: Buffer, mimeType: string): Buffer {
  const rate = Number(/rate=(\d+)/i.exec(mimeType)?.[1] ?? '24000');
  if (!OPUS_RATES.includes(rate)) throw new SpeechRefusal(`refused: Gemini answered audio at ${rate} Hz, which this plugin cannot encode.`);
  return encodeOggOpus(pcm16ToFloat(bytes), rate as OpusRate);
}

export const GEMINI_MODELS_TTL_MS = 10 * 60_000;
const modelCache = new Map<string, { at: number; models: GeminiModel[] }>();

/** For tests: forget what `GET /models` answered. */
export function clearGeminiModelCache(): void {
  modelCache.clear();
}

export interface GeminiModel {
  /** Without `models/`. */
  id: string;
  methods: string[];
}

/** `GET /v1beta/models`, every page, cached ten minutes per account. A failure is an empty list, not cached. */
export async function geminiModels(
  cacheKey: string,
  resolved: ResolvedProvider,
  ctx: Pick<BackendContext, 'signal' | 'timeoutMs' | 'fetch'>,
  now: number = Date.now(),
): Promise<GeminiModel[]> {
  const hit = modelCache.get(cacheKey);
  if (hit && now - hit.at < GEMINI_MODELS_TTL_MS) return hit.models;
  const models: GeminiModel[] = [];
  try {
    let token = '';
    for (let page = 0; page < 5; page++) {
      const body = (await call(resolved, ctx, `/models?pageSize=1000${token ? `&pageToken=${encodeURIComponent(token)}` : ''}`, { method: 'GET' }, 'listening')) as {
        models?: Array<{ name?: unknown; supportedGenerationMethods?: unknown }>;
        nextPageToken?: unknown;
      };
      for (const m of Array.isArray(body.models) ? body.models : []) {
        const id = typeof m.name === 'string' ? m.name.replace(/^models\//, '') : '';
        if (!id || id.length > 150 || /[\r\n\x00-\x1f]/.test(id)) continue;
        const methods = Array.isArray(m.supportedGenerationMethods) ? m.supportedGenerationMethods.filter((x): x is string => typeof x === 'string') : [];
        models.push({ id, methods });
      }
      token = typeof body.nextPageToken === 'string' ? body.nextPageToken : '';
      if (!token) break;
    }
  } catch {
    return [];
  }
  modelCache.set(cacheKey, { at: now, models });
  return models;
}

/**
 * The ids for one side, the default first when Google lists it: listening
 * takes a Flash model that answers `generateContent` (each hears audio), and
 * speaking a TTS model.
 */
export function geminiModelsFor(side: Side, models: readonly GeminiModel[]): string[] {
  const usable = models.filter((m) => m.methods.includes('generateContent'));
  const ids = side === 'listening'
    ? usable.filter((m) => /flash/i.test(m.id) && !/tts|image|embedding/i.test(m.id)).map((m) => m.id)
    : usable.filter((m) => /tts/i.test(m.id)).map((m) => m.id);
  const fallback = side === 'listening' ? GEMINI_LISTEN_MODEL : GEMINI_SPEAK_MODEL;
  const rest = [...new Set(ids.filter((id) => id !== fallback))].sort();
  return ids.includes(fallback) || ids.length === 0 ? [fallback, ...rest] : rest;
}

/** Gemini's audio models, for an account the page cannot ask yet (see `OPENAI_KNOWN_MODELS`). */
export const GEMINI_KNOWN_MODELS: Record<Side, readonly string[]> = {
  listening: [GEMINI_LISTEN_MODEL, 'gemini-2.5-flash-lite', 'gemini-2.0-flash'],
  speaking: [GEMINI_SPEAK_MODEL, 'gemini-2.5-pro-preview-tts'],
};

export const geminiBackend: SpeechBackend = {
  kind: 'gemini',
  label: 'Gemini',
  accountKind: 'openai-compatible',
  closedVoices: true,
  leaves: {
    listening: `The recording goes to Google's Gemini API (${GEMINI_HOST}), which sends back the text.`,
    speaking: `The text to say goes to Google's Gemini API (${GEMINI_HOST}), which sends back the audio.`,
  },
  listener: {
    defaultModel: GEMINI_LISTEN_MODEL,
    async transcribe(audio, ctx) {
      const resolved = await provider(ctx);
      const body = await call(resolved, ctx, `/models/${encodeURIComponent(ctx.model)}:generateContent`, {
        method: 'POST',
        body: {
          contents: [{
            role: 'user',
            parts: [
              { text: transcribePrompt(audio.language, audio.languages) },
              { inline_data: { mime_type: audio.mime, data: audio.bytes.toString('base64') } },
            ],
          }],
          generationConfig: { temperature: 0 },
        },
      }, 'listening');
      const text = partsOf(body).map((p) => (typeof p.text === 'string' ? p.text : '')).join('').trim();
      return { text };
    },
  },
  speaker: {
    defaultModel: GEMINI_SPEAK_MODEL,
    defaultVoice: GEMINI_DEFAULT_VOICE,
    async synthesize(request, ctx) {
      const resolved = await provider(ctx);
      const voice = request.voice ?? GEMINI_DEFAULT_VOICE;
      const body = await call(resolved, ctx, `/models/${encodeURIComponent(ctx.model)}:generateContent`, {
        method: 'POST',
        body: {
          contents: [{ role: 'user', parts: [{ text: request.text }] }],
          generationConfig: {
            responseModalities: ['AUDIO'],
            speechConfig: { voiceConfig: { prebuiltVoiceConfig: { voiceName: voice } } },
          },
        },
      }, 'speaking');
      const audio = partsOf(body).map((p) => p.inlineData ?? (p.inline_data ? { mimeType: p.inline_data.mime_type, data: p.inline_data.data } : undefined)).find((d) => typeof d?.data === 'string');
      if (!audio) throw new SpeechRefusal('refused: Gemini answered without audio.');
      const pcm = Buffer.from(audio.data as string, 'base64');
      if (pcm.length > MAX_AUDIO_BYTES * 2) throw new SpeechRefusal('refused: the speaking service answered with more than this plugin keeps.');
      const mime = typeof audio.mimeType === 'string' ? audio.mimeType : 'audio/L16;rate=24000';
      // Already a container (a future Gemini that answers one): passed on, and sniffed by the caller.
      if (!/^audio\/(l16|pcm)/i.test(mime)) return { bytes: pcm, mime };
      return { bytes: voiceNoteFromPcm(pcm, mime), mime: 'audio/ogg' };
    },
  },
  async voices(): Promise<Voice[]> {
    return GEMINI_VOICES.map((id) => ({ id, label: id }));
  },
  async models(side, ctx) {
    const fallback = side === 'listening' ? GEMINI_LISTEN_MODEL : GEMINI_SPEAK_MODEL;
    const known = [...GEMINI_KNOWN_MODELS[side]];
    if (!ctx.accounts || !ctx.account) return known;
    let resolved: ResolvedProvider;
    try {
      resolved = await ctx.accounts.resolve(ctx.account.id, fallback, ctx.signal);
    } catch {
      // Not bound yet, a locked vault: Gemini's audio models, and the field still takes a typed id.
      return known;
    }
    const listed = await geminiModels(`gemini:${ctx.account.id}`, resolved, ctx);
    return listed.length > 0 ? geminiModelsFor(side, listed) : known;
  },
};
