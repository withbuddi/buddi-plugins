/**
 * What the owner chose on Settings → Speech, for one side, as a backend ready
 * to call, or the one sentence that says why not.
 *
 * Checked before any approval card (from `tierFor`), so a call with nothing
 * to listen or speak with is refused at once, and the card, when there is
 * one, names the service and model it will use.
 */
import type { ProviderAccountListing, ToolContext } from '@buddi/core/plugin';
import { backendFor, COMING_BACKENDS, localBackendFor, SpeechRefusal, type SpeechBackend } from './backends/index.js';
import { isInstalled } from './install.js';
import { installedDir } from './local/runtime.js';
import { getSettings, type Settings } from './store.js';

export type SideName = 'listening' | 'speaking';

/** The account kinds a cloud backend may run on. Codex, Claude: no audio routes. */
export const QUALIFYING_KINDS: ReadonlyArray<ProviderAccountListing['kind']> = ['openai', 'openai-compatible'];

export const NOT_SET: Record<SideName, string> = {
  listening: 'refused: listening is not set up. The owner chooses a service in Settings → Speech.',
  speaking: 'refused: speaking is not set up. The owner chooses a service in Settings → Speech.',
};

export interface Chosen {
  backend: SpeechBackend;
  account?: ProviderAccountListing;
  model: string;
  settings: Settings;
  /** "OpenAI · gpt-4o-mini-tts", for cards and captions. */
  where: string;
}

export function listAccounts(ctx: ToolContext): ProviderAccountListing[] {
  try {
    return ctx.buddi?.accounts?.list() ?? [];
  } catch {
    // No model accounts in this process at all.
    return [];
  }
}

/** The plugin's own directory, where the local models live. */
export function localDirOf(ctx: ToolContext): string | undefined {
  try {
    return ctx.buddi?.dir.path;
  } catch {
    return undefined;
  }
}

/** The Service choice that turns a side off, even with a model on this computer. */
export const OFF = 'off';

/**
 * The backend a side uses: the owner's choice, or, when they chose nothing,
 * the one on this computer once it is installed (the spec's default). Off
 * is none, whatever is installed.
 */
export function effectiveBackend(settings: Settings, side: SideName, localDir: string | undefined): string | null {
  const chosen = settings[side].backend;
  if (chosen === OFF) return null;
  if (chosen) return chosen;
  const local = localBackendFor(side);
  return localDir && local.local && isInstalled(localDir, local.local) ? local.kind : null;
}

export async function chooseSide(ctx: ToolContext, side: SideName): Promise<Chosen> {
  const settings = await getSettings(ctx.buddi!.db);
  const chosen = { ...settings[side], backend: effectiveBackend(settings, side, localDirOf(ctx)) };
  if (!chosen.backend) throw new SpeechRefusal(NOT_SET[side]);
  const backend = backendFor(chosen.backend);
  const port = side === 'listening' ? backend?.listener : backend?.speaker;
  if (!backend || !port) {
    const coming = COMING_BACKENDS.find((b) => b.kind === chosen.backend);
    throw new SpeechRefusal(
      coming
        ? `refused: ${coming.label} is not installed yet. The owner chooses another service in Settings → Speech.`
        : NOT_SET[side],
    );
  }
  if (backend.local) {
    installedDir(localDirOf(ctx), backend.local);
    return { backend, model: port.defaultModel, settings, where: backend.label };
  }
  const model = chosen.model?.trim() || port.defaultModel;
  if (!backend.accountKind) return { backend, model, settings, where: `${backend.label} · ${model}` };

  if (!chosen.accountId) {
    throw new SpeechRefusal(`refused: no account is chosen for ${side}. The owner picks one in Settings → Speech.`);
  }
  const account = listAccounts(ctx).find((a) => a.id === chosen.accountId);
  if (!account) {
    throw new SpeechRefusal(`refused: the ${side} account chosen in Settings → Speech no longer exists. The owner picks another there.`);
  }
  if (account.kind !== backend.accountKind) {
    throw new SpeechRefusal(`refused: "${account.label}" is not an ${backend.label} account. The owner picks another in Settings → Speech.`);
  }
  if (!account.enabled) throw new SpeechRefusal(`refused: the ${side} account "${account.label}" is disabled in Settings → Model accounts.`);
  if (!account.configured) {
    throw new SpeechRefusal(`refused: the ${side} account "${account.label}" is not connected. Connect it in Settings → Model accounts.`);
  }
  return { backend, account, model, settings, where: `${account.label} · ${model}` };
}

export { languageHint } from './languages.js';

/**
 * The owner's language from their profile ("Answer me in"), as an ISO 639-1
 * code, or undefined: blank, not a language, or a buddi older than host API
 * 1.5.
 */
export async function ownerLanguage(ctx: ToolContext): Promise<string | undefined> {
  const owner = ctx.buddi?.owner as { language?: () => Promise<string | undefined> } | undefined;
  if (typeof owner?.language !== 'function') return undefined;
  try {
    const tag = await owner.language();
    const code = tag?.split('-')[0]?.toLowerCase();
    return code && /^[a-z]{2}$/.test(code) ? code : undefined;
  } catch {
    return undefined;
  }
}

/**
 * The languages the owner speaks, for a hint: the ones listed on Settings →
 * Speech, else the one their profile answers in, else none (detect any).
 */
export async function spokenLanguages(ctx: ToolContext, settings: Settings): Promise<string[]> {
  if (settings.listening.languages.length > 0) return settings.listening.languages;
  const own = await ownerLanguage(ctx);
  return own ? [own] : [];
}
