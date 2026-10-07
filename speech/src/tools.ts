/**
 * `speech.transcribe` and `speech.say`: the two model-facing tools.
 *
 * **The tier.** As image's: core has no "approve once per conversation"
 * tier, so each tool declares `auto` and narrows every call with `tierFor`:
 * gated until the owner has approved one call of that tool in this
 * conversation (a delegated colleague's conversation counts as the one that
 * delegated to it), then auto. The daily caps bound what "auto" can spend.
 *
 * **The configuration first.** `tierFor` checks the owner's choice before
 * anything else, so a call with nothing to listen or speak with is one
 * sentence naming Settings → Speech, never a card approved for nothing.
 *
 * **What leaves.** With a cloud listener, the recording; with a cloud
 * speaker, the text. The card says so, as the page does.
 */
import { z } from 'zod';
import type { EffectDescription, ToolContext, ToolDefinition } from '@buddi/core/plugin';
import { MAX_AUDIO_BYTES, SpeechRefusal, type BackendContext } from './backends/index.js';
import { chooseSide, languageHint, localDirOf, spokenLanguages, type Chosen } from './choose.js';
import { AUDIO_EXTENSIONS, sniffAudio, type AudioMime } from './magic.js';
import { RESPONSE_CAP, transportOf, withFetch } from './net.js';
import { countToday, recordUsage } from './store.js';
import { spokenText } from './spoken.js';

export const SPEECH_TIMEOUT_MS = 2 * 60_000;
export const MAX_SAY_CHARS = 4000;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/* ------------------------------------------------------------------ *
 * The shared steps, used by the tools and by the page's Test buttons
 * ------------------------------------------------------------------ */

function backendContext(ctx: ToolContext, chosen: Chosen, timeoutMs: number, fetchImpl?: typeof fetch): BackendContext {
  return {
    ...(ctx.buddi!.accounts ? { accounts: ctx.buddi!.accounts } : {}),
    ...(chosen.account ? { account: chosen.account } : {}),
    model: chosen.model,
    signal: ctx.signal ?? new AbortController().signal,
    timeoutMs,
    ...withFetch(fetchImpl ?? transportOf(ctx.buddi, { maxBytes: RESPONSE_CAP })),
    ...(chosen.backend.local && localDirOf(ctx) ? { localDir: localDirOf(ctx)! } : {}),
  };
}

async function underCap(ctx: ToolContext, side: 'listen' | 'speak', cap: number): Promise<Date> {
  const now = ctx.buddi!.clock.now();
  const used = await countToday(ctx.buddi!.db, side, now, ctx.buddi!.owner.timezone);
  if (used >= cap) {
    throw new SpeechRefusal(
      side === 'listen'
        ? `refused: ${used} recordings have been transcribed today, and the daily limit is ${cap}. The owner can raise it in Settings → Speech.`
        : `refused: ${used} replies have been spoken today, and the daily limit is ${cap}. The owner can raise it in Settings → Speech.`,
    );
  }
  return now;
}

export interface TranscribeResult {
  text: string;
  language?: string;
}

/** Transcribe bytes already read and sniffed, count it, record it. */
export async function transcribeBytes(
  ctx: ToolContext,
  audio: { bytes: Buffer; mime: AudioMime; artifactId: string | null; language?: string | undefined },
  options: { agentId: string; timeoutMs?: number; fetch?: typeof fetch },
): Promise<TranscribeResult> {
  const chosen = await chooseSide(ctx, 'listening');
  const now = await underCap(ctx, 'listen', chosen.settings.transcribeCap);
  // The call's own hint wins; then the owner's languages (or, with none
  // listed, their profile's): one is the language, several are the set a
  // detecting backend chooses from.
  const spoken = await spokenLanguages(ctx, chosen.settings);
  const language = languageHint(audio.language) ?? (spoken.length === 1 ? spoken[0] : undefined);
  const result = await chosen.backend.listener!.transcribe(
    {
      bytes: audio.bytes,
      mime: audio.mime,
      ...(language ? { language } : spoken.length > 1 ? { languages: [...spoken] } : {}),
    },
    backendContext(ctx, chosen, options.timeoutMs ?? SPEECH_TIMEOUT_MS, options.fetch),
  );
  await recordUsage(ctx.buddi!.db, {
    side: 'listen', agentId: options.agentId, conversationId: UUID.test(ctx.conversationId ?? '') ? ctx.conversationId! : null,
    artifactId: audio.artifactId, backend: chosen.backend.kind, accountId: chosen.account?.id ?? null, model: chosen.model,
    chars: result.text.length, bytes: audio.bytes.length, now,
  });
  return { text: result.text, ...(result.language ? { language: result.language } : {}) };
}

export interface SayResult {
  artifacts: Array<{ id: string }>;
  id: string;
  name: string;
  mime: AudioMime;
  bytes: number;
  voice: string;
  backend: string;
  account: string | null;
  model: string;
  /** What was said: the owner reads it under the file. */
  text: string;
  /** For the model only. */
  forAgent: string;
}

export function slug(text: string): string {
  const cleaned = text
    .toLowerCase()
    .normalize('NFKD')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 40)
    .replace(/-+$/, '');
  return cleaned === '' ? 'speech' : cleaned;
}

/** The voice for this call: the call's, then the owner's, then the backend's default. */
export async function pickVoice(ctx: ToolContext, chosen: Chosen, asked: string | undefined): Promise<string> {
  const fallback = chosen.backend.speaker!.defaultVoice;
  const voice = asked?.trim() || chosen.settings.speaking.voice?.trim() || fallback;
  if (voice.length > 80 || /[\r\n\x00-\x1f]/.test(voice)) throw new SpeechRefusal('refused: that is not a voice name.');
  // OpenAI's and Kokoro's lists are fixed; a compatible server names its own voices.
  if (chosen.backend.closedVoices && chosen.backend.voices) {
    const known = await chosen.backend.voices(backendContext(ctx, chosen, SPEECH_TIMEOUT_MS));
    if (!known.some((v) => v.id === voice)) {
      // A voice the owner saved for another service is not this call's fault.
      if (!asked?.trim()) return fallback;
      throw new SpeechRefusal(`refused: "${voice}" is not ${/^[AEIOU]/.test(chosen.backend.label) ? 'an' : 'a'} ${chosen.backend.label.replace(/ on this computer$/, '')} voice. The voices are ${known.map((v) => v.id).join(', ')}.`);
    }
  }
  return voice;
}

/**
 * The voice a reply is said with: for a speaker whose voices each speak one
 * language (Kokoro), the reply's language decides — a voice the call named
 * when it speaks it, else the owner's voice for that language on Settings →
 * Speech, else that language's first voice; a language with no voice keeps
 * `picked`, and the speaker's not-in-this-language route follows. Any other
 * speaker says it with `picked`.
 */
export function voiceForReply(chosen: Chosen, text: string, picked: string, asked: string | undefined): string {
  const speaking = chosen.settings.speaking;
  return chosen.backend.speaker!.voiceForText?.(text, picked, chosen.settings.listening.languages, {
    voices: speaking.voices ?? {},
    asked: Boolean(asked?.trim()),
  }) ?? picked;
}

/** Say `text`, keep the voice in the Files library, count it, record it. */
export async function sayText(
  ctx: ToolContext,
  request: { text: string; voice?: string | undefined; name?: string; handles?: Record<string, string> | undefined },
  options: { agentId: string; timeoutMs?: number; fetch?: typeof fetch },
): Promise<SayResult> {
  const chosen = await chooseSide(ctx, 'speaking');
  const now = await underCap(ctx, 'speak', chosen.settings.sayCap);
  const picked = await pickVoice(ctx, chosen, request.voice);
  // One language the owner speaks (or, with none listed, their profile's)
  // is the hint a one-language speaker weighs.
  const spoken = await spokenLanguages(ctx, chosen.settings);
  const language = spoken.length === 1 ? spoken[0] : undefined;
  // Written for the eye, said for the ear: no markdown, handles as names,
  // dates and amounts as words, whatever the backend.
  const said = spokenText(request.text, { ...(request.handles ? { handles: request.handles } : {}), now });
  // A voice that speaks one language (Kokoro's) gives way to one of the
  // reply's language: the owner's voice for it, else its first. The Telegram
  // and dashboard voices come through here.
  const voice = voiceForReply(chosen, said, picked, request.voice);
  const result = await chosen.backend.speaker!.synthesize(
    { text: said, voice, format: 'ogg-opus', ...(language ? { language } : {}) },
    backendContext(ctx, chosen, options.timeoutMs ?? SPEECH_TIMEOUT_MS, options.fetch),
  );
  // The bytes decide what this is; the backend's word is not trusted.
  const mime = sniffAudio(result.bytes);
  if (!mime) throw new SpeechRefusal('refused: what came back is not audio, so nothing was stored.');
  const filename = `${slug(request.name ?? request.text)}.${AUDIO_EXTENSIONS[mime]}`;
  const saved = await ctx.buddi!.files!.save({
    bytes: result.bytes,
    mime,
    filename,
    caption: `Spoken by ${options.agentId} with ${chosen.where} (voice ${voice}): ${request.text.slice(0, 2000)}`,
  });
  await recordUsage(ctx.buddi!.db, {
    side: 'speak', agentId: options.agentId, conversationId: saved.conversationId, artifactId: saved.id,
    backend: chosen.backend.kind, accountId: chosen.account?.id ?? null, model: chosen.model,
    chars: request.text.length, bytes: saved.sizeBytes, now,
  });
  const name = saved.filename ?? filename;
  return {
    artifacts: [{ id: saved.id }],
    id: saved.id,
    name,
    mime,
    bytes: saved.sizeBytes,
    voice,
    backend: chosen.backend.kind,
    account: chosen.account?.label ?? null,
    model: chosen.model,
    text: request.text,
    forAgent: `The voice is in the Files library as ${name} (id ${saved.id}). You have not heard it: say what you had it say, and give the id.`,
  };
}

/* ------------------------------------------------------------------ *
 * The approval rule both tools share
 * ------------------------------------------------------------------ */

/**
 * Core's owner path (`OWNER_AGENT_ID`): the owner acting themselves, as the
 * Telegram surface does for a voice note, is never asked to approve their own
 * call. The caps still count it.
 */
export const OWNER_CALLER = 'owner';

async function oncePerConversation(tool: string, ctx: ToolContext, side: 'listening' | 'speaking') {
  // Nothing to use is a refusal now, not after the owner approved.
  await chooseSide(ctx, side);
  if (ctx.agentId === OWNER_CALLER) return { tier: 'auto' as const };
  if (side === 'speaking' && await ctx.buddi?.approvals.configuredForRun?.(tool)) return { tier: 'auto' as const };
  if (ctx.conversationId && UUID.test(ctx.conversationId) && (await ctx.buddi!.approvals.approvedInConversation(tool, ctx.conversationId))) {
    return { tier: 'auto' as const };
  }
  // The owner's standing yes for this agent ("Always: this agent" on a card,
  // core's `tool_permissions`): a morning edition is a new conversation every
  // day, and must not wait on a card each time. Only `speech.say` offers it.
  if (side === 'speaking' && (await standingYes(tool, ctx))) return { tier: 'auto' as const };
  return {
    tier: 'gated' as const,
    reason: side === 'listening'
      ? 'The first recording in a conversation is yours to approve; later ones in the same conversation then run.'
      : 'The first spoken reply in a conversation is yours to approve; later ones in the same conversation then run.',
  };
}

/**
 * Whether the owner said "always" to this tool for the calling agent. Core
 * keys the row on the agent, the tool and its version, and answers nothing
 * for a delegate; an older buddi without `standing` simply never says yes.
 */
async function standingYes(tool: string, ctx: ToolContext): Promise<boolean> {
  try {
    return (await ctx.buddi?.approvals.standing?.(tool)) != null;
  } catch {
    return false;
  }
}

function requireAgent(ctx: ToolContext): string {
  const agentId = ctx.agentId?.trim();
  if (!agentId) throw new SpeechRefusal('refused: this call has no agent to act for.');
  return agentId;
}

/* ------------------------------------------------------------------ *
 * speech.transcribe
 * ------------------------------------------------------------------ */

export const transcribeInput = z
  .object({
    artifactId: z.string().uuid().describe('The Files library id of the recording (a voice note, an audio file).'),
    language: z
      .string()
      .trim()
      .min(2)
      .max(40)
      .optional()
      .describe('The spoken language, as a tag ("en", "fr") or a name, when you know it. Leave it out to let the service detect it.'),
  })
  .strict();

export type TranscribeInput = z.infer<typeof transcribeInput>;

/** Read the artifact, and refuse what is not audio a listening service takes. */
export async function readRecording(ctx: ToolContext, artifactId: string): Promise<{ bytes: Buffer; mime: AudioMime; filename: string; size: number }> {
  const row = await ctx.buddi!.files!.get(artifactId);
  if (!row) throw new SpeechRefusal(`refused: ${artifactId} is not a file in the Files library.`);
  if (row.kind !== 'audio') throw new SpeechRefusal(`refused: ${row.filename ?? artifactId} is not an audio file.`);
  if (row.sizeBytes > MAX_AUDIO_BYTES) throw new SpeechRefusal(`refused: ${row.filename ?? artifactId} is larger than 25 MB, the most a listening service takes.`);
  const bytes = await ctx.buddi!.files!.read(row.id);
  const mime = sniffAudio(bytes);
  if (!mime) throw new SpeechRefusal(`refused: ${row.filename ?? artifactId} is not audio this plugin can send (OGG, MP3, M4A, WAV, WebM or FLAC).`);
  return { bytes, mime, filename: row.filename ?? `${artifactId}.${AUDIO_EXTENSIONS[mime]}`, size: row.sizeBytes };
}

export interface ToolOptions {
  timeoutMs?: number;
  fetch?: typeof fetch;
}

export function createTranscribeTool(options: ToolOptions = {}): ToolDefinition<TranscribeInput, TranscribeResult> {
  const timeoutMs = options.timeoutMs ?? SPEECH_TIMEOUT_MS;
  return {
    name: 'speech.transcribe',
    description:
      'Turn a recording from the Files library (a voice note, an audio file up to 25 MB) into text. ' +
      'With a cloud service the recording leaves this machine for the listening service the owner chose in Settings → Speech ' +
      '(OpenAI, Gemini or their OpenAI-compatible server), which sends back the text; with Whisper on this computer nothing leaves. ' +
      'Returns { text, language? }.',
    tier: 'auto',
    timeoutMs: timeoutMs + 20_000,
    input: transcribeInput,
    tierFor: (_input, ctx) => oncePerConversation('speech.transcribe', ctx, 'listening'),
    async describe(input, ctx): Promise<EffectDescription> {
      const chosen = await chooseSide(ctx, 'listening');
      const row = await ctx.buddi!.files!.get(input.artifactId);
      const what = row ? `"${row.filename ?? input.artifactId}" (${Math.max(1, Math.round(row.sizeBytes / 1024))} KB)` : input.artifactId;
      return {
        envelope: {
          tool: 'speech.transcribe', backend: chosen.backend.kind, accountId: chosen.account?.id ?? null, model: chosen.model,
          artifactId: input.artifactId, language: input.language ?? null,
        },
        preview: `Transcribe ${what} with ${chosen.where}. ${chosen.backend.leaves.listening}`,
      };
    },
    async execute(input, ctx) {
      const agentId = requireAgent(ctx);
      await chooseSide(ctx, 'listening');
      const recording = await readRecording(ctx, input.artifactId);
      return transcribeBytes(
        ctx,
        { bytes: recording.bytes, mime: recording.mime, artifactId: input.artifactId, language: input.language },
        { agentId, timeoutMs, ...(options.fetch ? { fetch: options.fetch } : {}) },
      );
    },
  };
}

/* ------------------------------------------------------------------ *
 * speech.say
 * ------------------------------------------------------------------ */

export const sayInput = z
  .object({
    text: z
      .string()
      .trim()
      .min(1)
      .max(MAX_SAY_CHARS)
      .describe('What to say, written for the ear: short sentences, no tables, no markdown. At most 4,000 characters.'),
    voice: z.string().trim().min(1).max(80).optional().describe("A voice name; leave it out for the owner's choice."),
    handles: z
      .record(z.string().max(60), z.string().max(80))
      .refine((h) => Object.keys(h).length <= 100, 'at most 100 handles')
      .optional()
      .describe('Optional: agent handles and the names to read them as ({ "ledger": "Ledger" }); an @handle not listed is read as the bare word.'),
  })
  .strict();

export type SayInput = z.infer<typeof sayInput>;

export function createSayTool(options: ToolOptions = {}): ToolDefinition<SayInput, SayResult> {
  const timeoutMs = options.timeoutMs ?? SPEECH_TIMEOUT_MS;
  return {
    name: 'speech.say',
    description:
      'Say a text aloud and keep the audio in the owner\'s Files library (a voice note, OGG/Opus when the service gives it). ' +
      'With a cloud service the text leaves this machine for the speaking service the owner chose in Settings → Speech ' +
      '(OpenAI, Gemini or their OpenAI-compatible server), which sends back the audio; with Kokoro on this computer nothing leaves, ' +
      'and it speaks English, French, Spanish, Italian, Portuguese and Hindi (the voice follows the text\'s language). Write for the ear.',
    tier: 'auto',
    producesArtifacts: true,
    timeoutMs: timeoutMs + 20_000,
    input: sayInput,
    tierFor: (_input, ctx) => oncePerConversation('speech.say', ctx, 'speaking'),
    // The card offers "Always: this agent" (core's standing permission), which
    // `tierFor` honours above: an agent that speaks every morning asks once.
    reusableApproval: true,
    async describe(input, ctx): Promise<EffectDescription> {
      const chosen = await chooseSide(ctx, 'speaking');
      const picked = await pickVoice(ctx, chosen, input.voice);
      const voice = voiceForReply(chosen, input.text, picked, input.voice);
      const quoted = input.text.length > 300 ? `${input.text.slice(0, 300)}…` : input.text;
      return {
        envelope: {
          tool: 'speech.say', backend: chosen.backend.kind, accountId: chosen.account?.id ?? null, model: chosen.model,
          voice, text: input.text,
        },
        preview: `Say this with ${chosen.where}, voice ${voice}: "${quoted}" ${chosen.backend.leaves.speaking}`,
      };
    },
    async execute(input, ctx) {
      const agentId = requireAgent(ctx);
      return sayText(ctx, { text: input.text, voice: input.voice, handles: input.handles }, { agentId, timeoutMs, ...(options.fetch ? { fetch: options.fetch } : {}) });
    },
  };
}

export const transcribeTool = createTranscribeTool();
export const sayTool = createSayTool();
