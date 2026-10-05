/**
 * What the owner chose on Settings → Speech, for one side, as a backend ready
 * to call, or the one sentence that says why not.
 *
 * Checked before any approval card (from `tierFor`), so a call with nothing
 * to listen or speak with is refused at once, and the card, when there is
 * one, names the service and model it will use.
 */
import type { ProviderAccountListing, ToolContext } from '@buddi/core/plugin';
import { backendFor, COMING_BACKENDS, isGeminiUrl, localBackendFor, SpeechRefusal, type SpeechBackend } from './backends/index.js';
import { isInstalled } from './install.js';
import { installedDir } from './local/runtime.js';
import { getSettings, type Settings } from './store.js';

export type SideName = 'listening' | 'speaking';

/** The account kinds a cloud backend may run on. Codex, Claude: no audio routes. */
export const QUALIFYING_KINDS: ReadonlyArray<ProviderAccountListing['kind']> = ['openai', 'openai-compatible'];

/**
 * What an account can do with audio (host API 1.30's `capabilities`): an
 * OpenAI key and Gemini listen and speak (`known`); a ChatGPT subscription
 * and Claude do neither (`none`); Ollama and any other compatible address
 * are `probe`, which a sample that worked answers. A buddi older than 1.30
 * sends none, and the same is worked out here from the kind and address.
 */
export interface Capabilities {
  audioIn: boolean;
  audioOut: boolean;
  source: 'known' | 'probe' | 'none';
}

export function capabilitiesOf(account: ProviderAccountListing): Capabilities {
  const given = (account as { capabilities?: Partial<Capabilities> }).capabilities;
  if (given && typeof given.audioIn === 'boolean' && typeof given.audioOut === 'boolean' && ['known', 'probe', 'none'].includes(given.source as string)) {
    return { audioIn: given.audioIn, audioOut: given.audioOut, source: given.source as Capabilities['source'] };
  }
  if (account.kind === 'codex' || account.kind === 'anthropic') return { audioIn: false, audioOut: false, source: 'none' };
  if (account.kind === 'openai' || isGeminiUrl(account.baseUrl)) return { audioIn: true, audioOut: true, source: 'known' };
  return { audioIn: false, audioOut: false, source: 'probe' };
}

/** Whether an account may be offered for a side: it does it, or only a sample can tell. */
export function offeredFor(account: ProviderAccountListing, side: SideName): boolean {
  const caps = capabilitiesOf(account);
  return caps.source === 'probe' || (side === 'listening' ? caps.audioIn : caps.audioOut);
}

/** Why an account is not offered for a side, in the page's words. */
export function whyNot(account: ProviderAccountListing, side: SideName): string {
  if (account.kind === 'codex') return 'ChatGPT subscription: its backend has no audio';
  if (account.kind === 'anthropic') return 'Claude: Anthropic\'s API has no audio';
  return side === 'listening' ? 'it cannot listen' : 'it cannot speak';
}

/**
 * The backend an account runs: OpenAI's audio routes for an OpenAI key,
 * Gemini's own API for an account on Google's address, OpenAI's routes on
 * any other compatible server. None for an account with no audio.
 */
export function backendForAccount(account: ProviderAccountListing): SpeechBackend | undefined {
  if (capabilitiesOf(account).source === 'none') return undefined;
  if (account.kind === 'openai') return backendFor('openai');
  if (account.kind !== 'openai-compatible') return undefined;
  return backendFor(isGeminiUrl(account.baseUrl) ? 'gemini' : 'openai-compatible');
}

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
  if (!backend.accountKind) {
    const model = chosen.model?.trim() || port.defaultModel;
    return { backend, model, settings, where: `${backend.label} · ${model}` };
  }

  if (!chosen.accountId) {
    throw new SpeechRefusal(`refused: no account is chosen for ${side}. The owner picks one in Settings → Speech.`);
  }
  const account = listAccounts(ctx).find((a) => a.id === chosen.accountId);
  if (!account) {
    throw new SpeechRefusal(`refused: the ${side} account chosen in Settings → Speech no longer exists. The owner picks another there.`);
  }
  // The account decides the backend: a Gemini account saved before Gemini
  // had its own backend runs on it now.
  const own = backendForAccount(account);
  const ownPort = side === 'listening' ? own?.listener : own?.speaker;
  if (!own || !ownPort) {
    throw new SpeechRefusal(`refused: "${account.label}" cannot be used for ${side} (${whyNot(account, side)}). The owner picks another in Settings → Speech.`);
  }
  const model = (own.kind === backend.kind ? chosen.model?.trim() : '') || ownPort.defaultModel;
  if (!account.enabled) throw new SpeechRefusal(`refused: the ${side} account "${account.label}" is disabled in Settings → Model accounts.`);
  if (!account.configured) {
    throw new SpeechRefusal(`refused: the ${side} account "${account.label}" is not connected. Connect it in Settings → Model accounts.`);
  }
  return { backend: own, account, model, settings, where: `${account.label} · ${model}` };
}

/** The Account choice for the model on this computer (Whisper, Kokoro). */
export const LOCAL_CHOICE = 'local';
/** The model picker's last choice: a text field for an id the list does not have. */
export const OTHER_MODEL = '__other__';

/** What a Listening or Speaking row on the page holds, saved or not. */
export interface FormChoice {
  /** `local`, `off`, an account id, or empty for "nothing chosen". */
  account?: string | undefined;
  model?: string | undefined;
  /** The typed id, when `model` is "Other…". */
  modelOther?: string | undefined;
}

/** The model the row names: the typed one for "Other…", else the picked one; blank is none. */
export function modelOf(input: FormChoice): string | undefined {
  const typed = (input.model === OTHER_MODEL ? input.modelOther : input.model)?.trim();
  if (!typed) return undefined;
  if (typed.length > 150 || /[\r\n\x00-\x1f]/.test(typed)) throw new SpeechRefusal('refused: that is not a model id.');
  return typed;
}

/**
 * A row's choice as a backend ready to call, or one sentence saying why not.
 * Choosing an account here binds it to this plugin (only a bound account
 * resolves through `ctx.buddi.accounts`), as the owner's pick on the page.
 * Nothing chosen is the model on this computer once it is installed.
 */
export async function chooseFromForm(ctx: ToolContext, side: SideName, input: FormChoice): Promise<Chosen> {
  const settings = await getSettings(ctx.buddi!.db);
  const value = input.account?.trim() ?? '';
  const name = side === 'listening' ? 'listening' : 'speaking';
  if (value === OFF) throw new SpeechRefusal(`refused: ${name} is off. Choose an account first.`);
  if (value === '' || value === LOCAL_CHOICE) {
    const local = localBackendFor(side);
    const port = side === 'listening' ? local.listener! : local.speaker!;
    if (value === '' && !(localDirOf(ctx) && local.local && isInstalled(localDirOf(ctx)!, local.local))) {
      throw new SpeechRefusal(`refused: choose an account for ${name} first, or install ${side === 'listening' ? 'Whisper' : 'Kokoro'} under On this computer.`);
    }
    installedDir(localDirOf(ctx), local.local!);
    return { backend: local, model: port.defaultModel, settings, where: local.label };
  }
  const account = listAccounts(ctx).find((a) => a.id === value);
  if (!account) throw new SpeechRefusal('refused: that account is not in Settings → Model accounts.');
  const backend = backendForAccount(account);
  const port = side === 'listening' ? backend?.listener : backend?.speaker;
  if (!backend || !port || !offeredFor(account, side)) {
    throw new SpeechRefusal(`refused: "${account.label}" cannot be used for ${name}: ${whyNot(account, side)}.`);
  }
  if (!account.enabled) throw new SpeechRefusal(`refused: "${account.label}" is disabled in Settings → Model accounts.`);
  if (!account.configured) throw new SpeechRefusal(`refused: "${account.label}" is not connected. Connect it in Settings → Model accounts.`);
  const model = modelOf(input) ?? port.defaultModel;
  await ctx.buddi!.accounts!.bind(account.id);
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
