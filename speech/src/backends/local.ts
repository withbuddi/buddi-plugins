/**
 * The two backends that run on this computer: Whisper small for listening
 * and Kokoro-82M for speaking, both on ONNX Runtime through Transformers.js
 * (`kokoro-js` for Kokoro), both from the files `installLocal` fetched and
 * verified into the plugin's directory. Nothing leaves the machine.
 *
 * The models run in the speech worker (`local/worker.ts`, `local/client.ts`),
 * never on the gateway's thread: one call at a time, with a budget each.
 *
 * Whisper: the recording is decoded to 16 kHz mono in WebAssembly
 * (`local/audio.ts`), 60 seconds of work at most per clip, clips over ten
 * minutes refused. Kokoro: English through `kokoro-js`, and French, Spanish,
 * Italian, Portuguese and Hindi with their own voices through eSpeak NG
 * (`local/phonemes.ts`, fetched with the model). The language is the voice's;
 * `voiceForText` picks the reply's language's voice first. An English voice
 * given a text clearly not English is a typed `not-english` refusal. At most
 * 4,000 characters, 90 seconds of work, 24 kHz PCM encoded to OGG/Opus at
 * 24 kbps (`local/ogg-opus.ts`).
 */
import { localWorker } from '../local/client.js';
import { guessLanguage, isProbablyEnglish } from '../local/english.js';
import type { EngineVoice, SynthesizeArgs, TranscribeArgs } from '../local/protocol.js';
import { installedDir } from '../local/runtime.js';
import { FIRST_VOICE, isKokoroLanguage, OTHER_VOICES, otherVoiceLabel, voiceLanguage } from '../local/voices.js';
import { isInstalled } from '../install.js';
import { NotEnglishRefusal, SpeechRefusal, type SpeechBackend, type Voice, type VoiceChoice } from './types.js';

export { detectLanguage, onlyTokens, type AsrPipeline, type LogitsBatch } from '../local/whisper-language.js';

/** The most work one clip may take. */
export const LOCAL_LISTEN_LIMIT_MS = 60_000;
/** The most work one reply read aloud may take. */
export const LOCAL_SPEAK_LIMIT_MS = 90_000;
/** The longest text Kokoro reads in one call, as the surfaces already cap it. */
export const LOCAL_SPEAK_MAX_CHARS = 4000;

export const WHISPER_MODEL = 'whisper-small (q8)';
export const KOKORO_MODEL = 'kokoro-82m (q8)';
export const KOKORO_DEFAULT_VOICE = 'af_heart';
export const KOKORO_RATE = 24_000;

/** A copy of the bytes in a buffer of their own, which the worker then owns. */
function transferable(bytes: Buffer): Uint8Array {
  return new Uint8Array(bytes);
}

export const whisperLocalBackend: SpeechBackend = {
  kind: 'whisper-local',
  label: 'Whisper on this computer',
  local: 'whisper',
  leaves: {
    listening: 'Nothing: the recording is transcribed on this computer.',
    speaking: 'Nothing.',
  },
  models: async () => [WHISPER_MODEL],
  listener: {
    defaultModel: WHISPER_MODEL,
    async transcribe(audio, ctx) {
      const dir = installedDir(ctx.localDir, 'whisper');
      const bytes = transferable(audio.bytes);
      const args: TranscribeArgs = {
        dir,
        bytes,
        mime: audio.mime,
        ...(audio.language ? { language: audio.language } : {}),
        ...(audio.languages ? { languages: audio.languages } : {}),
      };
      return localWorker.call('transcribe', args, {
        signal: ctx.signal,
        limitMs: LOCAL_LISTEN_LIMIT_MS,
        what: 'Transcribing',
        transfer: [bytes.buffer as ArrayBuffer],
      });
    },
  },
};

let voiceList: Voice[] | undefined;

/**
 * Kokoro's voices: the English ones from `kokoro-js`'s pack in the worker (no
 * model loaded), then French, Spanish, Italian, Portuguese and Hindi
 * (`local/voices.ts`). Japanese and Chinese are in the pack and not listed.
 */
export async function kokoroVoices(): Promise<Voice[]> {
  if (voiceList) return voiceList;
  const voices = await localWorker.call<EngineVoice[]>('voices', {}, { limitMs: 60_000, what: 'Listing the voices' });
  voiceList = [
    ...voices
      .filter((v) => /^en-(us|gb)$/i.test(v.language))
      .map((v) => ({
        id: v.id,
        label: `${v.name} (${/gb/i.test(v.language) ? 'British' : 'American'}, ${v.gender.toLowerCase()})`,
        language: v.language,
      })),
    ...OTHER_VOICES.map((v) => ({ id: v.id, label: otherVoiceLabel(v), language: v.tag })),
  ];
  return voiceList;
}

/**
 * The voice for this reply, in the reply's language: a voice the call named
 * when it speaks it, else the owner's voice for that language
 * (`choice.voices`), else the chosen voice when it speaks it, else that
 * language's first Kokoro voice. A language Kokoro has no voice for keeps
 * `voice` (and the English voice's `not-english` refusal follows). The
 * reply's language is what the text looks like, or, when it cannot be told,
 * the owner's one spoken language.
 */
export function kokoroVoiceForText(text: string, voice: string, spoken: readonly string[] = [], choice: VoiceChoice = {}): string {
  const reply = guessLanguage(text) ?? (spoken.length === 1 ? spoken[0] : undefined);
  if (!isKokoroLanguage(reply)) return voice;
  if (choice.asked && voiceLanguage(voice) === reply) return voice;
  const mapped = choice.voices?.[reply];
  if (mapped && voiceLanguage(mapped) === reply) return mapped;
  return voiceLanguage(voice) === reply ? voice : FIRST_VOICE[reply];
}

export const kokoroLocalBackend: SpeechBackend = {
  kind: 'kokoro-local',
  label: 'Kokoro on this computer',
  local: 'kokoro',
  closedVoices: true,
  languageVoices: true,
  models: async () => [KOKORO_MODEL],
  leaves: {
    listening: 'Nothing.',
    speaking: 'Nothing: the voice is made on this computer.',
  },
  speaker: {
    defaultModel: KOKORO_MODEL,
    defaultVoice: KOKORO_DEFAULT_VOICE,
    voiceForText: kokoroVoiceForText,
    async synthesize(request, ctx) {
      const voice = request.voice ?? KOKORO_DEFAULT_VOICE;
      const language = voiceLanguage(voice);
      if (language === 'ja' || language === 'zh') {
        throw new SpeechRefusal('refused: Kokoro on this computer does not speak Japanese or Chinese; choose a cloud speaker for them.');
      }
      if ((language ?? 'en') === 'en' && !isProbablyEnglish(request.text, request.language)) throw new NotEnglishRefusal();
      const dir = installedDir(ctx.localDir, 'kokoro');
      if (language && language !== 'en' && !isInstalled(dir, 'espeak')) {
        throw new SpeechRefusal(
          "refused: Kokoro's pronunciation of languages other than English (eSpeak NG) is not installed. The owner installs it with Kokoro's Install on Settings → Speech, or with buddi speech install kokoro.",
        );
      }
      if (request.format !== 'ogg-opus') throw new SpeechRefusal('refused: Kokoro on this computer makes OGG/Opus voice notes only.');
      if (request.text.length > LOCAL_SPEAK_MAX_CHARS) {
        throw new SpeechRefusal(
          `refused: Kokoro on this computer reads up to ${LOCAL_SPEAK_MAX_CHARS.toLocaleString('en')} characters at a time, and this text is ${request.text.length.toLocaleString('en')}.`,
        );
      }
      const args: SynthesizeArgs = { dir, text: request.text, voice };
      const limitMs = Math.min(ctx.timeoutMs, LOCAL_SPEAK_LIMIT_MS);
      const said = await localWorker.call<{ bytes: Uint8Array }>('synthesize', args, { signal: ctx.signal, limitMs, what: 'Speaking' });
      return { bytes: Buffer.from(said.bytes.buffer, said.bytes.byteOffset, said.bytes.byteLength), mime: 'audio/ogg' };
    },
  },
  voices: () => kokoroVoices(),
};
