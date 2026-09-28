/**
 * `speech.preview` — the play button beside the Voice, or beside each
 * language's voice ("French voice"), on Settings → Speech.
 *
 * It says one short sentence (in the row's `lang`, else in the voice's
 * language for a Kokoro voice, else English) with the service, account, model and
 * voice the form holds *now*, saved or not, and hands the audio back to the
 * page as `{ play: { mime, data } }` (core's `PagePlay`), which the browser
 * plays and forgets. Nothing is stored: no Files artifact, no usage row, and
 * it does not count against the daily limit — it is the owner listening to a
 * choice, not an agent speaking.
 *
 * `ownerOnly`, like the rest of the page's tools: no model is ever shown it.
 */
import { z } from 'zod';
import type { ToolContext, ToolDefinition } from '@buddi/core/plugin';
import { backendFor, COMING_BACKENDS, SpeechRefusal } from './backends/index.js';
import { effectiveBackend, listAccounts, localDirOf, OFF, type Chosen } from './choose.js';
import { oggCrc, PAGE_EOS } from './local/ogg-opus.js';
import { installedDir } from './local/runtime.js';
import { isKokoroLanguage, voiceLanguage, type KokoroLanguage } from './local/voices.js';
import { sniffAudio } from './magic.js';
import { RESPONSE_CAP, transportOf, withFetch } from './net.js';
import { getSettings } from './store.js';
import { pickVoice, SPEECH_TIMEOUT_MS } from './tools.js';

export const PREVIEW_PHRASE = "Hi, I'm buddi. This is how I sound.";
/** The same sentence for Kokoro's voices of other languages. */
export const PREVIEW_PHRASES: Readonly<Record<KokoroLanguage, string>> = {
  en: PREVIEW_PHRASE,
  fr: 'Bonjour, je suis buddi. Voici ma voix.',
  es: 'Hola, soy buddi. Así suena mi voz.',
  it: 'Ciao, sono buddi. Questa è la mia voce.',
  pt: 'Olá, eu sou o buddi. Esta é a minha voz.',
  hi: 'नमस्ते, मैं बडी हूँ। मेरी आवाज़ ऐसी है।',
};
/** The longest a sample plays: the sentence takes about two and a half. */
export const PREVIEW_SECONDS = 5;
/** Core's `PAGE_PLAY_MAX_BYTES`: what a page will play at all. */
export const PREVIEW_MAX_BYTES = 512 * 1024;
/** The model picker's last choice (`settings.ts`'s `OTHER_MODEL`). */
const OTHER_MODEL = '__other__';

const choice = (max: number) => z.string().max(max).optional();

export const previewInput = z
  .object({
    backend: choice(60),
    account: choice(200),
    model: choice(150),
    /** The typed id, when `model` is "Other…". */
    modelOther: choice(150),
    voice: choice(80),
    /**
     * The language of the row the play button sits on ("French voice"), ISO
     * 639-1: the sample is said in it. Absent, the voice's own language.
     */
    lang: z.string().regex(/^[a-z]{2}$/).optional(),
  })
  .strict();

export type PreviewInput = z.infer<typeof previewInput>;

export interface PreviewResult {
  play: { mime: string; data: string };
}

/**
 * An Ogg stream cut after the last page that ends by `seconds` (granule
 * positions are 48 kHz samples, pre-skip included). Whole pages are kept, and
 * the last one is marked end-of-stream with its CRC made again. Anything that
 * does not parse as Ogg pages is returned as it came.
 */
export function trimOgg(bytes: Buffer, seconds: number): Buffer {
  const limit = BigInt(Math.round(seconds * 48_000)) + 312n;
  let at = 0;
  let lastKept = -1;
  while (at + 27 <= bytes.length && bytes.toString('latin1', at, at + 4) === 'OggS') {
    const segments = bytes[at + 26]!;
    if (at + 27 + segments > bytes.length) return bytes;
    let body = 0;
    for (let i = 0; i < segments; i++) body += bytes[at + 27 + i]!;
    const end = at + 27 + segments + body;
    if (end > bytes.length) return bytes;
    const granule = bytes.readBigInt64LE(at + 6);
    if (granule !== -1n && granule > limit) {
      if (lastKept < 0) return bytes;
      const kept = Buffer.from(bytes.subarray(0, at));
      kept[lastKept + 5] = kept[lastKept + 5]! | PAGE_EOS;
      const page = kept.subarray(lastKept);
      page.writeUInt32LE(0, 22);
      page.writeUInt32LE(oggCrc(page), 22);
      return kept;
    }
    lastKept = at;
    at = end;
  }
  return bytes;
}

/** The form's choices, as a backend ready to speak, or one sentence saying why not. */
async function chosenFrom(ctx: ToolContext, input: PreviewInput): Promise<Chosen> {
  const settings = await getSettings(ctx.buddi!.db);
  const kind = input.backend?.trim() || effectiveBackend(settings, 'speaking', localDirOf(ctx));
  if (!kind || kind === OFF) throw new SpeechRefusal('refused: choose a speaking service first.');
  const coming = COMING_BACKENDS.find((b) => b.kind === kind);
  if (coming) throw new SpeechRefusal(`refused: ${coming.label} is not installed yet.`);
  const backend = backendFor(kind);
  if (!backend?.speaker) throw new SpeechRefusal('refused: choose a speaking service from the list.');
  if (backend.local) {
    installedDir(localDirOf(ctx), backend.local);
    return { backend, model: backend.speaker.defaultModel, settings, where: backend.label };
  }
  const typed = input.model === OTHER_MODEL ? input.modelOther : input.model;
  const model = typed?.trim() || backend.speaker.defaultModel;
  if (model.length > 150 || /[\r\n\x00-\x1f]/.test(model)) throw new SpeechRefusal('refused: that is not a model id.');
  if (!backend.accountKind) return { backend, model, settings, where: `${backend.label} · ${model}` };
  const accountId = input.account?.trim();
  if (!accountId) throw new SpeechRefusal(`refused: choose ${/^[AEIOU]/.test(backend.label) ? 'an' : 'a'} ${backend.label} account first.`);
  const account = listAccounts(ctx).find((a) => a.id === accountId);
  if (!account) throw new SpeechRefusal('refused: that account is not in Settings → Model accounts.');
  if (account.kind !== backend.accountKind) throw new SpeechRefusal(`refused: "${account.label}" is not ${/^[AEIOU]/.test(backend.label) ? 'an' : 'a'} ${backend.label} account.`);
  if (!account.enabled) throw new SpeechRefusal(`refused: "${account.label}" is disabled in Settings → Model accounts.`);
  if (!account.configured) throw new SpeechRefusal(`refused: "${account.label}" is not connected. Connect it in Settings → Model accounts.`);
  // Choosing it on the page is the owner binding it to this plugin, as Save
  // does: only a bound account resolves through ctx.buddi.accounts.
  await ctx.buddi!.accounts!.bind(account.id);
  return { backend, account, model, settings, where: `${account.label} · ${model}` };
}

export interface PreviewToolOptions {
  fetch?: typeof fetch;
  timeoutMs?: number;
}

export function createPreviewTool(options: PreviewToolOptions = {}): ToolDefinition<PreviewInput, PreviewResult> {
  const timeoutMs = options.timeoutMs ?? SPEECH_TIMEOUT_MS;
  return {
    name: 'speech.preview',
    description: "Play a short sample of a speaking service and voice on the Speech page; nothing is kept. The owner's own.",
    tier: 'auto',
    ownerOnly: true,
    timeoutMs: timeoutMs + 20_000,
    input: previewInput,
    async execute(input, ctx) {
      const chosen = await chosenFrom(ctx, input);
      const localDir = chosen.backend.local ? localDirOf(ctx) : undefined;
      const backendCtx = {
        ...(ctx.buddi!.accounts ? { accounts: ctx.buddi!.accounts } : {}),
        ...(chosen.account ? { account: chosen.account } : {}),
        model: chosen.model,
        signal: ctx.signal ?? new AbortController().signal,
        timeoutMs,
        ...withFetch(options.fetch ?? transportOf(ctx.buddi, { maxBytes: RESPONSE_CAP })),
        ...(localDir ? { localDir } : {}),
      };
      const voice = await pickVoice(ctx, chosen, input.voice?.trim() || undefined);
      const spoken = input.lang ?? (chosen.backend.local === 'kokoro' ? voiceLanguage(voice) : undefined);
      const language: KokoroLanguage = isKokoroLanguage(spoken) ? spoken : 'en';
      const result = await chosen.backend.speaker!.synthesize(
        { text: PREVIEW_PHRASES[language], voice, format: 'ogg-opus', language },
        backendCtx,
      );
      const mime = sniffAudio(result.bytes);
      if (!mime) throw new SpeechRefusal('refused: what came back is not audio.');
      const bytes = mime === 'audio/ogg' ? trimOgg(result.bytes, PREVIEW_SECONDS) : result.bytes;
      if (bytes.length > PREVIEW_MAX_BYTES) throw new SpeechRefusal('refused: the sample came back larger than the page plays.');
      return { play: { mime, data: bytes.toString('base64') } };
    },
  };
}

export const previewTool = createPreviewTool();
