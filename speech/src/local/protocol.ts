/**
 * What the main thread and the speech worker say to each other.
 *
 * main → worker: `{ type: 'call', id, op, args }` (buffers transferred) and
 * `{ type: 'cancel', id }`. worker → main: `{ type: 'result', id, value }` or
 * `{ type: 'error', id, error }`. One call at a time: the queue is the
 * client's (`client.ts`). An `Engine` is what the worker runs the calls on: the real models
 * (`engine.ts`), or a fake one in the tests, named by module URL.
 */
import { NotEnglishRefusal, SpeechRefusal } from '../backends/types.js';

export interface EngineOptions {
  /** ONNX Runtime's intra-op threads (`threads.ts`). */
  threads: number;
}

export interface TranscribeArgs {
  dir: string;
  bytes: Uint8Array;
  mime: string;
  language?: string;
  languages?: string[];
}

export interface SynthesizeArgs {
  dir: string;
  text: string;
  voice: string;
}

export interface EngineVoice {
  id: string;
  name: string;
  language: string;
  gender: string;
}

export interface Engine {
  transcribe(args: TranscribeArgs, check: () => void): Promise<{ text: string; language?: string }>;
  detectLanguage(args: Omit<TranscribeArgs, 'language'>, check: () => void): Promise<string | undefined>;
  synthesize(args: SynthesizeArgs, check: () => void): Promise<{ bytes: Uint8Array; seconds: number }>;
  voices(): Promise<EngineVoice[]>;
}

/** A module the worker can load: `createEngine` is its one export it uses. */
export interface EngineModule {
  createEngine(options: EngineOptions): Engine;
}

export type Op = 'transcribe' | 'detectLanguage' | 'synthesize' | 'voices';

export interface WorkerSetup {
  /** The engine module's URL; absent is the real models (`engine.js`). */
  engine?: string;
  threads: number;
}

export type ToWorker =
  | { type: 'call'; id: number; op: Op; args: unknown }
  | { type: 'cancel'; id: number };

export type FromWorker =
  | { type: 'result'; id: number; value: unknown }
  | { type: 'error'; id: number; error: WireError };

export interface WireError {
  message: string;
  refusal?: boolean;
  code?: string;
}

export const CANCELLED = 'refused: the call was cancelled.';

export function toWire(error: unknown): WireError {
  if (error instanceof Error) {
    const e = error as Error & { refusal?: unknown; code?: unknown };
    return {
      message: e.message,
      ...(e.refusal === true ? { refusal: true } : {}),
      ...(typeof e.code === 'string' ? { code: e.code } : {}),
    };
  }
  return { message: String(error) };
}

/** Back to the classes the tools know: a refusal stays a refusal, not-english stays typed. */
export function fromWire(error: WireError): Error {
  if (error.code === 'not-english') return new NotEnglishRefusal();
  if (error.refusal) return new SpeechRefusal(error.message);
  return new Error(error.message);
}
