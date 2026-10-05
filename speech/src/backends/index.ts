/**
 * Every speech backend, by the id the settings store.
 *
 * Imported from the package root by another plugin (the telephony plugin
 * uses the ports directly for audio both ways). A backend is one file
 * implementing `SpeechBackend` and one line below.
 *
 * `whisper-local` and `kokoro-local` run on this computer from the files
 * `installLocal` fetched; until then they are offered as installable and
 * refuse with a sentence naming the Install. Vendors that are not
 * OpenAI-shaped (Deepgram first, then ElevenLabs) are next, each keeping its
 * key in Keys and secrets.
 */
import { geminiBackend } from './gemini.js';
import { kokoroLocalBackend, whisperLocalBackend } from './local.js';
import { openaiBackend, openaiCompatibleBackend } from './openai.js';
import type { SpeechBackend } from './types.js';

export const BACKENDS: Readonly<Record<string, SpeechBackend>> = {
  openai: openaiBackend,
  'openai-compatible': openaiCompatibleBackend,
  gemini: geminiBackend,
  'whisper-local': whisperLocalBackend,
  'kokoro-local': kokoroLocalBackend,
};

/** Backends the page names before they exist. None at the moment. */
export const COMING_BACKENDS: ReadonlyArray<{ kind: string; label: string; side: 'listening' | 'speaking' }> = [];

export function backendFor(kind: string | null | undefined): SpeechBackend | undefined {
  return kind && Object.hasOwn(BACKENDS, kind) ? BACKENDS[kind] : undefined;
}

/** The backends that can take this side. */
export function backendsFor(side: 'listening' | 'speaking'): SpeechBackend[] {
  return Object.values(BACKENDS).filter((b) => (side === 'listening' ? b.listener : b.speaker));
}

/** The local backend for a side. */
export function localBackendFor(side: 'listening' | 'speaking'): SpeechBackend {
  return side === 'listening' ? whisperLocalBackend : kokoroLocalBackend;
}

export * from './types.js';
export * from './openai.js';
export * from './gemini.js';
export * from './local.js';
