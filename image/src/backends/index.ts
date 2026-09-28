/**
 * Which backend serves which provider account.
 *
 * An account is matched by its kind in Settings → Model accounts
 * (`ProviderAccountKind` in core) and, for Gemini, by its address: a Gemini
 * account is an `openai-compatible` account at Google's OpenAI-compatible
 * endpoint. An account no backend serves is not offered on the settings page
 * and is refused by the tool.
 *
 * Replicate or fal would need an account kind in core first: a key read from
 * the environment is exactly what this plugin does not do. FLUX served behind
 * an OpenAI-compatible Images API works today as an `openai-compatible`
 * account.
 */
import type { ProviderAccountListing } from '@buddi/core/plugin';
import { codexBackend } from './codex.js';
import { geminiBackend, openaiBackend, openaiCompatibleBackend } from './openai.js';
import type { ImageBackend } from './types.js';

/** In order: the first that serves an account is its backend. */
export const BACKENDS: readonly ImageBackend[] = [codexBackend, openaiBackend, geminiBackend, openaiCompatibleBackend];

export function backendFor(account: Pick<ProviderAccountListing, 'kind' | 'baseUrl'>): ImageBackend | undefined {
  return BACKENDS.find((backend) => backend.serves(account));
}

export * from './types.js';
export * from './codex.js';
export * from './openai.js';
