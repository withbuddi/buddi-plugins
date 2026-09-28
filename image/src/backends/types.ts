/**
 * One image backend per provider-account kind.
 *
 * The tool knows nothing about any vendor: it validates, counts, stores and
 * reports. Everything that differs between Codex, OpenAI's Images API, a local
 * FLUX server or tomorrow's Gemini is behind `generate`, which gets the prompt
 * as the agent wrote it, the reference pictures as bytes, and the shape, and
 * returns bytes. What those bytes are is decided afterwards by `sniffImage`,
 * never by what a backend claims.
 */
import type { AccountsArea, ProviderAccountListing } from '@buddi/core/plugin';

export type Aspect = 'square' | 'portrait' | 'landscape';

/** Largest picture taken back from any backend. A generated PNG is a few MB. */
export const MAX_IMAGE_BYTES = 30 * 1024 * 1024;

/** Sizes every gpt-image model and ChatGPT's image tool accept; most compatible servers take them too. */
export const SIZES: Record<Aspect, '1024x1024' | '1024x1536' | '1536x1024'> = {
  square: '1024x1024',
  portrait: '1024x1536',
  landscape: '1536x1024',
};

export interface Reference {
  bytes: Buffer;
  mime: string;
  filename: string;
}

export interface GenerateRequest {
  /** The agent's words. Data, never instructions to anything but the image model. */
  prompt: string;
  references: Reference[];
  aspect: Aspect;
}

export interface GenerateResult {
  bytes: Buffer;
  /** What the backend said. Not trusted: the tool sniffs the bytes itself. */
  mime?: string;
}

export interface BackendContext {
  /** `ctx.buddi.accounts`: resolves only an account the owner bound to this plugin. */
  accounts: Pick<AccountsArea, 'resolve'> & Partial<Pick<AccountsArea, 'generateCodexImage'>>;
  account: ProviderAccountListing;
  model: string;
  signal: AbortSignal;
  timeoutMs: number;
}

export interface ImageBackend {
  /** What it is recorded as (`image.generation.backend`), and what the settings page calls it. */
  kind: string;
  label: string;
  /** Whether it serves this account. The first backend that does is the account's. */
  serves(account: Pick<ProviderAccountListing, 'kind' | 'baseUrl'>): boolean;
  /** The model used when the owner left the field blank. */
  defaultModel(account: ProviderAccountListing): string;
  generate(request: GenerateRequest, context: BackendContext): Promise<GenerateResult>;
}

/**
 * A refusal the agent may read verbatim: one sentence, no internals.
 *
 * Flagged `refusal` — core's `ToolRefusal` convention, read by the flag so
 * this class need not extend core's — so that thrown before an approval, from
 * `tierFor` or `describe`, it reaches the agent as it stands and no card is
 * raised.
 */
export class ImageRefusal extends Error {
  readonly refusal = true;
}

/** A host or service failure as one sentence the agent may read: no newlines, bounded. */
export function refusalFrom(error: unknown): ImageRefusal {
  if (error instanceof ImageRefusal) return error;
  const raw = error instanceof Error ? error.message : '';
  const text = raw.replace(/\s+/g, ' ').trim().slice(0, 300).replace(/[.!]?$/, '.');
  return new ImageRefusal(`refused: ${text === '.' ? 'the image service failed.' : text} Nothing was stored.`);
}
