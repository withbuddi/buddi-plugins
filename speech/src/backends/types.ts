/**
 * The two ports every speech backend implements, and nothing else.
 *
 * The tools, the Speech page and (later) Telegram know no vendor. What differs
 * between OpenAI, an OpenAI-compatible server, a local Whisper or Kokoro, and
 * tomorrow's Deepgram or ElevenLabs sits behind `Listener` (speech to text)
 * and `Speaker` (text to speech). What a speaker's bytes are is decided
 * afterwards by `sniffAudio`, never by what the backend claims.
 *
 * The telephony plugin imports this registry from the package root
 * (`@buddi/tool-speech`); it does not go through the tool registry for audio.
 */
import type { AccountsArea, ProviderAccountListing } from '@buddi/core/plugin';
import type { SpeakFormat } from '../magic.js';

export type { SpeakFormat } from '../magic.js';

/** A recording to transcribe. */
export interface ListenRequest {
  bytes: Buffer;
  /** The sniffed container, e.g. `audio/ogg`. */
  mime: string;
  /** An ISO-639-1 hint ("en", "fr"); absent means the service detects it. */
  language?: string;
  /**
   * The languages the owner speaks, when there are several and no `language`:
   * a backend that detects the language itself (Whisper on this computer)
   * picks the likeliest of these. One that cannot ignores it.
   */
  languages?: string[];
}

export interface ListenResult {
  text: string;
  /** The language the service heard, when it says. */
  language?: string;
}

/** Text to say. */
export interface SpeakRequest {
  text: string;
  voice?: string;
  format: SpeakFormat;
  /**
   * The owner's language hint (ISO-639-1), when set. A speaker that speaks
   * one language per voice (Kokoro) weighs it with the text itself.
   */
  language?: string;
}

export interface SpeakResult {
  bytes: Buffer;
  /** What the backend said. Not trusted: the caller sniffs the bytes itself. */
  mime: string;
}

export interface Voice {
  id: string;
  label: string;
  /** A BCP-47 tag when the backend knows it. */
  language?: string;
}

/** What one call gets beyond its request. */
export interface BackendContext {
  /** `ctx.buddi.accounts`: resolves only an account the owner bound to this plugin. */
  accounts?: Pick<AccountsArea, 'resolve'>;
  /** The account chosen on Settings → Speech, for a backend that uses one. */
  account?: ProviderAccountListing;
  model: string;
  signal: AbortSignal;
  timeoutMs: number;
  /** A transport for tests; the global `fetch` otherwise. */
  fetch?: typeof fetch;
  /**
   * The plugin's own directory (`ctx.buddi.dir.path`), where the local
   * models live; a local backend refuses without it.
   */
  localDir?: string;
}

/**
 * Partial and final text from a live audio stream.
 *
 * **No backend implements this in this version.** It is the seam the
 * telephony plugin needs (a call is audio both ways and partials matter;
 * Deepgram offers them over a socket), defined now so the first backends do
 * not grow a shape that only fits files.
 */
export interface ListenStream {
  /** Feed audio as it arrives. */
  push(chunk: Buffer): void;
  /** No more audio; the final text follows. */
  end(): void;
  on(event: 'partial' | 'final', listener: (text: string) => void): void;
  on(event: 'error', listener: (error: Error) => void): void;
  close(): void;
}

/**
 * Audio chunks as text arrives.
 *
 * **No backend implements this in this version**; the telephony plugin will
 * (ElevenLabs and Cartesia stream over a socket).
 */
export interface SpeakStream {
  /** Feed text as the model writes it. */
  write(text: string): void;
  /** No more text; the last audio follows, then `end`. */
  end(): void;
  on(event: 'audio', listener: (chunk: Buffer) => void): void;
  on(event: 'end', listener: () => void): void;
  on(event: 'error', listener: (error: Error) => void): void;
  close(): void;
}

/** Speech to text. */
export interface Listener {
  transcribe(audio: ListenRequest, ctx: BackendContext): Promise<ListenResult>;
  /** Optional: partials over a socket. Implemented by no backend yet. */
  stream?(ctx: BackendContext): ListenStream;
  /** The model used when the owner left the field blank. */
  defaultModel: string;
}

/** The owner's voice per language, and whether the call named its own. */
export interface VoiceChoice {
  /** ISO 639-1 → voice id, from Settings → Speech. */
  voices?: Readonly<Record<string, string>>;
  /** The call named `voice` itself. */
  asked?: boolean;
}

/** Text to speech. */
export interface Speaker {
  synthesize(request: SpeakRequest, ctx: BackendContext): Promise<SpeakResult>;
  /** Optional: audio chunks as text arrives. Implemented by no backend yet. */
  stream?(ctx: BackendContext): SpeakStream;
  /** The model used when the owner left the field blank. */
  defaultModel: string;
  /** The voice used when neither the call nor the owner named one. */
  defaultVoice: string;
  /**
   * Optional: the voice to say this text with, given the one chosen and the
   * languages the owner speaks. A speaker whose voices each speak one language
   * (Kokoro) swaps in a voice of the text's language: the one the owner chose
   * for it (`choice.voices`), else that language's first; the rest keep
   * `voice`. `choice.asked` is a voice the call named, kept when it speaks
   * the text's language.
   */
  voiceForText?(text: string, voice: string, spoken: readonly string[], choice?: VoiceChoice): string;
}

export interface SpeechBackend {
  /** The id the settings store: `openai`, `openai-compatible`, later `whisper-local`… */
  kind: string;
  /** What the Speech page calls it. */
  label: string;
  /**
   * The model-account kind this backend runs on, for a cloud backend; absent
   * for a local one, which needs no account.
   */
  accountKind?: ProviderAccountListing['kind'];
  /** Where the audio or text goes, for the page's "What leaves" line. */
  leaves: { listening: string; speaking: string };
  /** For a local backend: the model it runs, fetched by `installLocal`. */
  local?: 'whisper' | 'kokoro';
  /** Only the voices it lists exist (OpenAI, Kokoro); a call naming another is refused. */
  closedVoices?: boolean;
  /**
   * Each voice it lists carries its `language` and speaks only that one
   * (Kokoro): Settings → Speech offers a voice per language the owner speaks.
   */
  languageVoices?: boolean;
  listener?: Listener;
  speaker?: Speaker;
  voices?(ctx: BackendContext): Promise<Voice[]>;
  /**
   * The model ids this backend offers for one side, the default first. A
   * cloud backend asks the account (`GET /models`); a local one has its one.
   * Never throws: nothing found is the default alone.
   */
  models?(side: 'listening' | 'speaking', ctx: BackendContext): Promise<string[]>;
}

/**
 * A refusal the agent may read verbatim: one sentence, no internals.
 *
 * Flagged `refusal`, core's `ToolRefusal` convention, so that thrown before an
 * approval (from `tierFor` or `describe`) it reaches the agent as it stands
 * and no card is raised.
 */
export class SpeechRefusal extends Error {
  readonly refusal = true;
}

/**
 * A speaker that cannot say this text in its voice's language (a Kokoro
 * English voice, with a text in a language Kokoro has no voice for). Typed so
 * a caller (Telegram) can fall back to sending the text; the message is still
 * one sentence an agent may read. The code keeps its first name.
 */
export class NotEnglishRefusal extends SpeechRefusal {
  readonly code = 'not-english' as const;
  constructor() {
    super('refused: not-english: this text is not in a language this voice speaks, and Kokoro on this computer has no voice for it.');
  }
}
