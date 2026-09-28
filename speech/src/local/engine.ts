/**
 * The real models, loaded only inside the speech worker (`worker.ts`): the
 * main thread never imports this file's Transformers.js and `kokoro-js`.
 *
 * ONNX Runtime's Node binding runs a session synchronously (in a
 * `setImmediate`), so on the gateway's thread a long reply read aloud froze
 * everything else until it finished. Here it freezes only the worker.
 *
 * Both models load on first use, stay warm, and are let go after ten idle
 * minutes; eSpeak NG (`espeak.ts`), which pronounces Kokoro's French,
 * Spanish, Italian, Portuguese and Hindi voices, too. `check` is called between chunks (Whisper's 30-second windows,
 * Kokoro's sentences) and throws once the caller cancelled.
 */
import path from 'node:path';
import { decodeForWhisper } from './audio.js';
import { loadEspeak, type LoadedEspeak } from './espeak.js';
import { ESPEAK_MODEL } from './models.js';
import { phonemize } from './phonemes.js';
import { voiceLanguage } from './voices.js';
import { encodeOggOpus } from './ogg-opus.js';
import { localRuntime, Resident } from './runtime.js';
import { detectLanguage, type AsrPipeline } from './whisper-language.js';
import type { Engine, EngineOptions, EngineVoice } from './protocol.js';
import { SpeechRefusal } from '../backends/types.js';

const IDLE_MS = 10 * 60_000;
export const KOKORO_RATE = 24_000;

interface KokoroVoiceInfo { name: string; language: string; gender: string }
interface KokoroTts {
  tokenizer(text: string, options: { truncation: boolean }): { input_ids: unknown };
  generate_from_ids(ids: unknown, options: { voice: string; speed?: number }): Promise<{ audio: Float32Array; sampling_rate: number }>;
  stream(text: unknown, options: { voice: string; speed?: number }): AsyncIterable<{ audio: { audio: Float32Array; sampling_rate: number } }>;
  model: { dispose?: () => unknown };
  dispose?: () => unknown;
}
type Splitter = new () => { push(...text: string[]): void; close(): void };

export function createEngine(options: EngineOptions): Engine {
  const session_options = { intraOpNumThreads: options.threads, interOpNumThreads: 1 };
  const whisper = new Resident<AsrPipeline>(IDLE_MS);
  const kokoro = new Resident<KokoroTts & { Splitter: Splitter }>(IDLE_MS);
  const espeak = new Resident<LoadedEspeak>(IDLE_MS);

  async function loadWhisper(dir: string): Promise<AsrPipeline> {
    const t = await localRuntime(dir);
    return (await t.pipeline('automatic-speech-recognition', 'whisper', { dtype: 'q8', device: 'cpu', session_options })) as unknown as AsrPipeline;
  }

  // Not `KokoroTTS.from_pretrained`: it passes no session options, so the
  // thread count would be ONNX Runtime's default (every core).
  async function loadKokoro(dir: string): Promise<KokoroTts & { Splitter: Splitter }> {
    const t = await localRuntime(dir);
    const { KokoroTTS, TextSplitterStream } = await import('kokoro-js');
    const [model, tokenizer] = await Promise.all([
      t.StyleTextToSpeech2Model.from_pretrained('kokoro', { dtype: 'q8', device: 'cpu', session_options }),
      t.AutoTokenizer.from_pretrained('kokoro'),
    ]);
    const tts = new KokoroTTS(model as never, tokenizer) as unknown as KokoroTts & { Splitter: Splitter };
    tts.Splitter = TextSplitterStream;
    tts.dispose = () => tts.model.dispose?.();
    return tts;
  }

  /** The pipeline with `check` run before every generate call. */
  async function withWhisper<T>(dir: string, check: () => void, run: (pipe: AsrPipeline) => Promise<T>): Promise<T> {
    const pipe = await whisper.get(dir, () => loadWhisper(dir));
    check();
    const generate = pipe.model.generate;
    pipe.model.generate = async (args: Record<string, unknown>) => {
      check();
      return generate.call(pipe.model, args);
    };
    try {
      return await run(pipe);
    } finally {
      delete (pipe.model as { generate?: unknown }).generate;
      if (pipe.model.generate !== generate) pipe.model.generate = generate;
      whisper.touch();
    }
  }

  return {
    async transcribe({ dir, bytes, mime, language, languages }, check) {
      const { pcm, seconds } = await decodeForWhisper(Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength), mime);
      check();
      return withWhisper(dir, check, async (pipe) => {
        const heard = language ?? (await detectLanguage(pipe, pcm, languages));
        const result = await pipe(pcm, {
          task: 'transcribe',
          ...(heard ? { language: heard } : {}),
          ...(seconds > 30 ? { chunk_length_s: 30, stride_length_s: 5 } : {}),
        });
        const text = (Array.isArray(result) ? result.map((r) => r.text).join(' ') : result.text).trim();
        return { text, ...(heard ? { language: heard } : {}) };
      });
    },

    async detectLanguage({ dir, bytes, mime, languages }, check) {
      const { pcm } = await decodeForWhisper(Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength), mime);
      return withWhisper(dir, check, (pipe) => detectLanguage(pipe, pcm, languages));
    },

    async synthesize({ dir, text, voice }, check) {
      const tts = await kokoro.get(dir, () => loadKokoro(dir));
      const language = voiceLanguage(voice);
      try {
        check();
        const parts: Float32Array[] = [];
        // Sentence by sentence: Kokoro reads at most 510 tokens at once. The
        // splitter is closed here: kokoro-js 1.2.1 never closes the one it
        // makes for a plain string, and its stream then waits forever.
        const splitter = new tts.Splitter();
        splitter.push(text);
        splitter.close();
        if (language === 'en') {
          for await (const { audio } of tts.stream(splitter, { voice })) {
            parts.push(audio.audio);
            check();
          }
        } else if (language && language !== 'ja' && language !== 'zh') {
          // kokoro-js phonemizes English only: eSpeak NG says the rest, and
          // the model reads its phonemes with the language's own voice.
          const g2p = await espeak.get(dir, () => loadEspeak(path.join(dir, ESPEAK_MODEL.dir)));
          try {
            for await (const sentence of splitter as unknown as AsyncIterable<string>) {
              const phonemes = phonemize(sentence, language, g2p);
              check();
              if (!phonemes) continue;
              const { input_ids } = tts.tokenizer(phonemes, { truncation: true });
              parts.push((await tts.generate_from_ids(input_ids, { voice })).audio);
              check();
            }
          } finally {
            espeak.touch();
          }
        } else {
          throw new SpeechRefusal(`refused: Kokoro on this computer has no voice "${voice}" it can speak with.`);
        }
        const length = parts.reduce((n, p) => n + p.length, 0);
        if (length === 0) throw new SpeechRefusal('refused: Kokoro made no sound for that text.');
        const pcm = new Float32Array(length);
        let at = 0;
        for (const p of parts) { pcm.set(p, at); at += p.length; }
        const ogg = encodeOggOpus(pcm, KOKORO_RATE, { bitrate: 24_000 });
        return { bytes: new Uint8Array(ogg.buffer, ogg.byteOffset, ogg.byteLength), seconds: length / KOKORO_RATE };
      } finally {
        kokoro.touch();
      }
    },

    /** Kokoro's voice pack, from `kokoro-js` itself (the list needs no model loaded). */
    async voices() {
      const { KokoroTTS } = await import('kokoro-js');
      const getter = Object.getOwnPropertyDescriptor(KokoroTTS.prototype, 'voices')?.get;
      const voices = (getter?.call(Object.create(KokoroTTS.prototype)) ?? {}) as Record<string, KokoroVoiceInfo>;
      return Object.entries(voices).map(([id, v]): EngineVoice => ({ id, name: v.name, language: v.language, gender: v.gender }));
    },
  };
}
