/**
 * Settings → Speech: which service listens and which speaks, with which
 * account, model, language and voice, and how many of each a day. The
 * owner's own: `speech.set_settings`, `speech.test` and `speech.preview` are
 * `ownerOnly`, so no model is ever shown them.
 */
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { z } from 'zod';
import type { Field, PageDescriptor, PageQuery, ToolContext, ToolDefinition } from '@buddi/core/plugin';
import { backendFor, backendsFor, COMING_BACKENDS, isOllamaCloud, localBackendFor, SpeechRefusal } from './backends/index.js';
import { chooseSide, effectiveBackend, listAccounts, localDirOf, NOT_SET, OFF, ownerLanguage, QUALIFYING_KINDS, type SideName } from './choose.js';
import {
  clearInstallJob, downloadBytes, installedLocal, installJob, LOCAL_KINDS, LOCAL_MODELS, megabytes, progressLine, removeLocal,
  startInstall, type LocalKind,
} from './install.js';
import { FIRST_VOICE, isKokoroLanguage, KOKORO_LANGUAGES, voiceLanguage } from './local/voices.js';
import { LANGUAGES, languageName, MAX_LANGUAGES, namesOf } from './languages.js';
import { sniffAudio } from './magic.js';
import { DOWNLOAD_CAP, RESPONSE_CAP, transportOf, withFetch } from './net.js';
import {
  countToday, getSettings, getTelegramVoice, recentUsage, setSettings, setTelegramVoice, VOICE_FORM, VOICE_WHEN, type Settings,
} from './store.js';
import { transcribeBytes } from './tools.js';

export const FIXTURES_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', 'fixtures');
/** A two-second clip, "Hello from buddi. This is a test.", made with eSpeak NG. */
export const TEST_CLIP = path.join(FIXTURES_DIR, 'test-clip.ogg');

export const SPEECH_NOTICE =
  'Agents listen to a recording with speech.transcribe and answer with a voice with speech.say, through the ' +
  'service you choose here. The first use of each in a conversation asks you first; the rest of that ' +
  'conversation runs, up to the daily limits.';

export const LOCAL_NOTE =
  'Whisper listens and Kokoro speaks (English, French, Spanish, Italian, Portuguese and Hindi) without anything leaving this machine. buddi downloads each ' +
  'model once, checks it, and keeps it with its data. Installed and nothing else chosen, they are used.';

export const WHY_NOT_LISTED =
  'Only OpenAI accounts with an API key and OpenAI-compatible accounts are offered. A ChatGPT subscription, ' +
  'a Claude sign-in and Ollama Cloud serve no audio routes, so they are not listed.';

export const COMING_LABEL = 'Not installed yet — coming in the next update';
export const NOT_INSTALLED_LABEL = 'not installed: Install it under On this computer';

/** The model picker's last choice: a text field for an id the list does not have. */
export const OTHER_MODEL = '__other__';

/**
 * The languages a speaker whose voices each speak one language can have a
 * row for ("French voice"): Kokoro's, the one such speaker. One field each
 * on the page, in this order, shown for the languages the owner speaks.
 */
export const ROW_LANGUAGES: readonly string[] = KOKORO_LANGUAGES;

/** The speakers whose voices carry their language: a voice per language on the page. */
const LANGUAGE_VOICED = backendsFor('speaking').filter((b) => b.languageVoices).map((b) => b.kind);

/**
 * The Speaking block's notice: the languages the owner speaks that no Kokoro
 * voice covers (Japanese, Chinese, German…), which have no voice row. Empty
 * when there is nothing to say.
 */
export function kokoroNotice(speakKind: string | null, languages: readonly string[]): string {
  if (speakKind !== 'kokoro-local') return '';
  const uncovered = languages.filter((l) => !isKokoroLanguage(l)).map(languageName);
  if (uncovered.length === 0) return '';
  const or = uncovered.length === 1 ? uncovered[0] : `${uncovered.slice(0, -1).join(', ')} or ${uncovered.at(-1)}`;
  return `No ${or} voice on this computer; ${namesOf(languages.filter((l) => !isKokoroLanguage(l)))} replies use the cloud speaker when one is set, else text.`;
}

/**
 * The Speaking form's voice rows, for the service in use: whether it offers a
 * voice per language (`voiceByLanguage`), which rows show (`voiceRows`, the
 * languages the owner speaks that it has voices for) and the voice each row
 * starts on (`speakVoices`: the owner's, else the saved voice when it speaks
 * that language, else the language's first). With no language listed, or
 * none it has voices for, the single Voice field stays.
 */
export function voiceRowsOf(settings: Settings, speakKind: string | null | undefined): {
  voiceByLanguage: boolean;
  voiceRows: Record<string, boolean>;
  speakVoices: Record<string, string>;
} {
  const byLanguage = !!speakKind && LANGUAGE_VOICED.includes(speakKind)
    && settings.listening.languages.some((l) => ROW_LANGUAGES.includes(l));
  const voiceRows = Object.fromEntries(ROW_LANGUAGES.map((l) => [l, byLanguage && settings.listening.languages.includes(l)]));
  const { voice, voices } = settings.speaking;
  const speakVoices = Object.fromEntries(
    ROW_LANGUAGES.filter(isKokoroLanguage).map((l) => {
      const mapped = voices[l];
      if (mapped && voiceLanguage(mapped) === l) return [l, mapped];
      return [l, voice && voiceLanguage(voice) === l ? voice : FIRST_VOICE[l]];
    }),
  );
  return { voiceByLanguage: byLanguage, voiceRows, speakVoices };
}

/**
 * The model choices for one side of a backend: what the account offers (the
 * default first), the saved model when the list does not have it, then
 * "Other…", which reveals a text field.
 */
export async function modelChoices(
  ctx: ToolContext,
  side: SideName,
  backendKind: string | undefined,
  accountId: string | undefined,
  options: { fetch?: typeof fetch } = {},
): Promise<Array<{ id: string; label: string }>> {
  const backend = backendFor(backendKind);
  const port = side === 'listening' ? backend?.listener : backend?.speaker;
  if (!backend || !port) return [];
  const account = accountId ? listAccounts(ctx).find((a) => a.id === accountId && a.kind === backend.accountKind) : undefined;
  const ids = backend.models
    ? await backend.models(side, {
        ...(ctx.buddi?.accounts ? { accounts: ctx.buddi.accounts } : {}),
        ...(account ? { account } : {}),
        model: port.defaultModel,
        signal: ctx.signal ?? new AbortController().signal,
        timeoutMs: 10_000,
        ...withFetch(options.fetch ?? transportOf(ctx.buddi, { maxBytes: RESPONSE_CAP })),
      })
    : [port.defaultModel];
  // The saved model, for the service it was saved with.
  const stored = (await getSettings(ctx.buddi!.db))[side];
  const saved = stored.backend === backend.kind ? stored.model?.trim() : undefined;
  const all = saved && !ids.includes(saved) ? [...ids, saved] : ids;
  const choices = all.map((id) => ({ id, label: id === port.defaultModel ? `${id} (default)` : id }));
  return backend.accountKind ? [...choices, { id: OTHER_MODEL, label: 'Other…' }] : choices;
}

/** The backend choices for one side: the cloud ones, then the one on this computer, installed or not, then Off. */
export function backendChoices(side: SideName, localDir?: string): Array<{ id: string; label: string; available: boolean }> {
  const installed = localDir ? installedLocal(localDir) : undefined;
  return [
    ...backendsFor(side).map((b) => {
      const ready = !b.local || installed?.[b.local].usable === true;
      return { id: b.kind, label: ready ? b.label : `${b.label} — ${NOT_INSTALLED_LABEL}`, available: ready };
    }),
    ...COMING_BACKENDS.filter((b) => b.side === side).map((b) => ({ id: b.kind, label: `${b.label} — ${COMING_LABEL}`, available: false })),
    { id: OFF, label: 'Off', available: true },
  ];
}

/** The accounts a backend may use, with their state. */
export function accountChoices(ctx: ToolContext, backendKind: string | undefined): Array<{ id: string; label: string }> {
  const backend = backendFor(backendKind);
  return listAccounts(ctx)
    .filter((a) => (backend?.accountKind ? a.kind === backend.accountKind : QUALIFYING_KINDS.includes(a.kind)))
    .map((a) => ({ id: a.id, label: `${a.label}${!a.enabled ? ' (disabled)' : !a.configured ? ' (not connected)' : ''}` }));
}

/** "What leaves", in the page's words, for the current choice of one side. */
export function whatLeaves(settings: Settings, side: SideName, localDir?: string): string {
  const kind = effectiveBackend(settings, side, localDir);
  const backend = backendFor(kind);
  const name = side === 'listening' ? 'Listening' : 'Speaking';
  if (settings[side].backend === OFF) return `${name}: nothing, because it is off.`;
  if (!kind) return `${name}: nothing, because no service is chosen.`;
  if (!backend) return `${name}: nothing yet; this service is not installed.`;
  if (backend.local && !(localDir && installedLocal(localDir)[backend.local].usable)) {
    return `${name}: nothing yet; ${backend.label} is not installed.`;
  }
  if (!backend.accountKind) return `${name}: nothing. It runs on this computer.`;
  return `${name}: ${side === 'listening' ? backend.leaves.listening : backend.leaves.speaking}`;
}

/** The model each side can install here, for "or install Whisper". */
const LOCAL_NAME: Record<SideName, string> = { listening: 'Whisper', speaking: 'Kokoro' };

/**
 * One side's state, in the page's words: "Listening: Whisper on this
 * computer." or "Listening: not set up. Pick a service below, or install
 * Whisper." The refusal an agent gets (`NOT_SET`) speaks of the owner; this
 * one speaks to them, on the page where they fix it.
 */
export async function sideStatus(ctx: ToolContext, side: SideName): Promise<string> {
  const name = side === 'listening' ? 'Listening' : 'Speaking';
  if ((await getSettings(ctx.buddi!.db))[side].backend === OFF) return `${name}: off.`;
  try {
    const chosen = await chooseSide(ctx, side);
    return `${name}: ${chosen.where}.`;
  } catch (error) {
    if (!(error instanceof SpeechRefusal) || error.message === NOT_SET[side]) {
      return `${name}: not set up. Pick a service below, or install ${LOCAL_NAME[side]}.`;
    }
    // The first sentence says what is wrong; the rest tells the owner where to go, and they are here.
    const reason = error.message.replace(/^refused: /, '');
    const first = /^.*?\.(?=\s|$)/.exec(reason)?.[0] ?? reason;
    return `${name}: ${first.charAt(0).toLowerCase()}${first.slice(1)}`;
  }
}

/**
 * With no language listed, the one from the owner's profile is the hint:
 * "From your profile: French." Empty when languages are listed or the profile
 * names none.
 */
export async function profileLanguageNote(ctx: ToolContext, settings: Settings): Promise<string> {
  if (settings.listening.languages.length > 0) return '';
  const own = await ownerLanguage(ctx);
  return own ? `From your profile: ${languageName(own)}.` : '';
}

export const speechQueries: PageQuery[] = [
  {
    name: 'settings',
    params: z.object({}),
    async produce(_params, ctx: ToolContext) {
      const settings = await getSettings(ctx.buddi!.db);
      const now = ctx.buddi!.clock.now();
      const tz = ctx.buddi!.owner.timezone;
      const dir = localDirOf(ctx);
      // What each side uses: the owner's choice, or the one on this computer when they chose nothing.
      const listenKind = effectiveBackend(settings, 'listening', dir);
      const speakKind = effectiveBackend(settings, 'speaking', dir);
      const speakBackend = backendFor(speakKind);
      return {
        listenStatus: await sideStatus(ctx, 'listening'),
        speakStatus: await sideStatus(ctx, 'speaking'),
        listenBackend: settings.listening.backend === OFF ? OFF : listenKind ?? '',
        listenAccount: settings.listening.accountId ?? '',
        listenModel: settings.listening.model ?? backendFor(listenKind)?.listener?.defaultModel ?? '',
        listenLanguages: settings.listening.languages,
        listenLanguagesNote: await profileLanguageNote(ctx, settings),
        listenModelDefault: backendFor(listenKind)?.listener?.defaultModel ?? backendsFor('listening')[0]?.listener?.defaultModel ?? '',
        speakBackend: settings.speaking.backend === OFF ? OFF : speakKind ?? '',
        speakAccount: settings.speaking.accountId ?? '',
        speakModel: settings.speaking.model ?? speakBackend?.speaker?.defaultModel ?? '',
        speakNotice: kokoroNotice(speakKind, settings.listening.languages),
        speakVoice: settings.speaking.voice ?? '',
        ...voiceRowsOf(settings, speakKind),
        speakModelDefault: speakBackend?.speaker?.defaultModel ?? backendsFor('speaking')[0]?.speaker?.defaultModel ?? '',
        transcribeCap: settings.transcribeCap,
        sayCap: settings.sayCap,
        ...(await telegramChoice(ctx)),
        listenedToday: await countToday(ctx.buddi!.db, 'listen', now, tz),
        spokenToday: await countToday(ctx.buddi!.db, 'speak', now, tz),
        listenBackends: backendChoices('listening', dir),
        speakBackends: backendChoices('speaking', dir),
        leavesListening: whatLeaves(settings, 'listening', dir),
        leavesSpeaking: whatLeaves(settings, 'speaking', dir),
        accounts: listAccounts(ctx).map((a) => ({
          label: a.label,
          kind: a.kind,
          offered: QUALIFYING_KINDS.includes(a.kind) ? 'offered' : 'no audio routes',
        })),
      };
    },
  },
  {
    name: 'listen_accounts',
    params: z.object({ listenBackend: z.string().max(60).optional() }).strict(),
    async produce(params, ctx: ToolContext) {
      return { choices: accountChoices(ctx, (params as { listenBackend?: string }).listenBackend) };
    },
  },
  {
    name: 'speak_accounts',
    params: z.object({ speakBackend: z.string().max(60).optional() }).strict(),
    async produce(params, ctx: ToolContext) {
      return { choices: accountChoices(ctx, (params as { speakBackend?: string }).speakBackend) };
    },
  },
  {
    name: 'listen_models',
    params: z.object({ listenBackend: z.string().max(60).optional(), account: z.string().max(200).optional() }).strict(),
    async produce(params, ctx: ToolContext) {
      const p = params as { listenBackend?: string; account?: string };
      return { choices: await modelChoices(ctx, 'listening', p.listenBackend, p.account) };
    },
  },
  {
    name: 'speak_models',
    params: z.object({ speakBackend: z.string().max(60).optional(), account: z.string().max(200).optional() }).strict(),
    async produce(params, ctx: ToolContext) {
      const p = params as { speakBackend?: string; account?: string };
      return { choices: await modelChoices(ctx, 'speaking', p.speakBackend, p.account) };
    },
  },
  {
    name: 'voices',
    // `lang`: one row's language ("French voice"). Without it, a speaker
    // whose voices carry their language lists its English ones: the single
    // Voice field, when the owner listed no language it has voices for.
    params: z.object({ speakBackend: z.string().max(60).optional(), lang: z.string().regex(/^[a-z]{2}$/).optional() }).strict(),
    async produce(params, ctx: ToolContext) {
      const p = params as { speakBackend?: string; lang?: string };
      const backend = backendFor(p.speakBackend);
      if (!backend?.voices) return { voices: [] };
      const voices = await backend.voices({ model: '', signal: ctx.signal ?? new AbortController().signal, timeoutMs: 10_000 });
      const lang = p.lang ?? (backend.languageVoices ? 'en' : undefined);
      const listed = lang ? voices.filter((v) => v.language?.toLowerCase().split('-')[0] === lang) : voices;
      return { voices: listed.map((v) => ({ id: v.id, label: v.label })) };
    },
  },
  {
    name: 'recent',
    params: z.object({}),
    async produce(_params, ctx: ToolContext) {
      return { uses: await recentUsage(ctx.buddi!.db, 20) };
    },
  },
  {
    name: 'install_status',
    params: z.object({}),
    async produce(_params, ctx: ToolContext) {
      return installStatus(requireDir(ctx));
    },
  },
];

/* ------------------------------------------------------------------ *
 * On this computer: Install, its progress, Remove
 * ------------------------------------------------------------------ */

const SIDE_OF: Record<LocalKind, SideName> = { whisper: 'listening', kokoro: 'speaking' };

function requireDir(ctx: ToolContext): string {
  const dir = localDirOf(ctx);
  if (!dir) throw new Error('This plugin has no directory of its own here, so nothing can be installed.');
  return dir;
}

export interface InstallRow {
  kind: LocalKind;
  label: string;
  side: string;
  state: 'absent' | 'installing' | 'installed' | 'failed';
  /** The sentence for an agent or a notice: what it is and where it stands. */
  line: string;
  /** "Whisper on this computer · listening": the line above the page's bar. */
  heading: string;
  /** Bytes so far and in all, for the bar; both the size on disk once installed. */
  bytes: number;
  total: number;
  /** "Installed, 252 MB": the line in place of the bar once it is full. */
  done: string;
}

/** Each local model's state and the one line the page shows for it. */
export function installStatus(dir: string): { busy: boolean; models: InstallRow[] } {
  const installed = installedLocal(dir);
  const models = LOCAL_KINDS.map((kind): InstallRow => {
    const model = LOCAL_MODELS[kind];
    const backend = localBackendFor(SIDE_OF[kind]);
    const job = installJob(dir, kind);
    const head = `${backend.label} (${model.label}, ${SIDE_OF[kind]})`;
    const base = { kind, label: backend.label, side: SIDE_OF[kind], heading: `${backend.label} · ${SIDE_OF[kind]}` };
    if (job?.state === 'running') {
      return { ...base, state: 'installing', line: `${head}. ${progressLine(job)}`, bytes: job.bytes, total: job.total, done: '' };
    }
    if (installed[kind].installed) {
      const size = installed[kind].bytes;
      const done = `Installed, ${megabytes(size)}`;
      return { ...base, state: 'installed', line: `${head}. ${done}.`, bytes: size, total: size, done };
    }
    const total = installed[kind].missing;
    if (job?.state === 'failed') return { ...base, state: 'failed', line: `${head}. ${job.error ?? 'The download failed.'}`, bytes: 0, total, done: '' };
    // Kokoro installed before eSpeak NG came with it: it speaks English, and Install fetches the rest.
    if (installed[kind].usable) {
      return { ...base, state: 'absent', line: `${head}. Installed for English; French, Spanish, Italian, Portuguese and Hindi need a ${megabytes(total)} download.`, bytes: 0, total, done: '' };
    }
    return { ...base, state: 'absent', line: `${head}. Not installed; a ${megabytes(total)} download.`, bytes: 0, total, done: '' };
  });
  return { busy: models.some((m) => m.state === 'installing'), models };
}

const kindInput = z.object({ kind: z.enum(['whisper', 'kokoro']) }).strict();

export interface InstallToolOptions {
  fetch?: typeof fetch;
}

export function createInstallTool(options: InstallToolOptions = {}): ToolDefinition<z.infer<typeof kindInput>, unknown> {
  return {
    name: 'speech.install',
    description: "Download a speech model to run on this computer, in the background. The owner's own.",
    tier: 'auto',
    ownerOnly: true,
    input: kindInput,
    async execute(input, ctx) {
      const dir = requireDir(ctx);
      const model = LOCAL_MODELS[input.kind];
      const job = startInstall(input.kind, { dir, ...withFetch(options.fetch ?? transportOf(ctx.buddi, { maxBytes: DOWNLOAD_CAP })) });
      if (job.state === 'done') return { note: `${model.label} is installed.` };
      return { note: `Downloading ${model.label} (${megabytes(installedLocal(dir)[input.kind].missing || downloadBytes(input.kind))}). You can leave this page; it carries on.` };
    },
  };
}

export const installTool = createInstallTool();

export const removeTool: ToolDefinition<z.infer<typeof kindInput>, unknown> = {
  name: 'speech.remove',
  description: "Delete a speech model downloaded to this computer. The owner's own.",
  tier: 'auto',
  ownerOnly: true,
  input: kindInput,
  async execute(input, ctx) {
    const dir = requireDir(ctx);
    if (installJob(dir, input.kind)?.state === 'running') throw new Error('It is still downloading; wait for it to finish, then remove it.');
    const removed = await removeLocal(input.kind, dir);
    clearInstallJob(dir, input.kind);
    const label = localBackendFor(SIDE_OF[input.kind]).label;
    return { note: removed ? `Removed ${label}. ${SIDE_OF[input.kind] === 'listening' ? 'Listening' : 'Speaking'} needs another service, or Install again.` : `${label} was not installed.` };
  },
};


/* ------------------------------------------------------------------ *
 * speech.set_settings — one side, or the limits, per save
 * ------------------------------------------------------------------ */

const text = (max: number) => z.string().max(max).optional();

const settingsInput = z
  .object({
    side: z.enum(['listening', 'speaking', 'limits']),
    backend: text(60),
    account: text(200),
    model: text(150),
    /** The typed id, when `model` is "Other…". */
    modelOther: text(150),
    languages: z.array(z.string().max(12)).max(40).optional(),
    voice: text(80),
    /** One per row language: `voice_fr`, the French voice. */
    ...Object.fromEntries(ROW_LANGUAGES.map((l) => [`voice_${l}`, text(80)])) as Record<`voice_${string}`, ReturnType<typeof text>>,
    transcribeCap: z.coerce.number().int().min(1).max(10000).optional(),
    sayCap: z.coerce.number().int().min(1).max(10000).optional(),
  })
  .strict();

function cleanId(value: string | undefined, what: string, max: number): string | null {
  const v = value?.trim() || null;
  if (v && (v.length > max || /[\r\n\x00-\x1f]/.test(v))) throw new Error(`Enter a valid ${what}.`);
  return v;
}

/** Check and bind the account for a cloud backend; the side's pieces, cleaned. */
async function sideChoice(ctx: ToolContext, side: SideName, input: z.infer<typeof settingsInput>): Promise<{ backend: string | null; accountId: string | null; model: string | null }> {
  const kind = input.backend?.trim() || null;
  if (!kind) return { backend: null, accountId: null, model: null };
  if (kind === OFF) return { backend: OFF, accountId: null, model: null };
  if (COMING_BACKENDS.some((b) => b.kind === kind)) throw new Error(`That one is not installed yet; it comes in the next update.`);
  const backend = backendFor(kind);
  if (!backend || !(side === 'listening' ? backend.listener : backend.speaker)) throw new Error('Choose a service from the list.');
  if (backend.local) {
    const dir = localDirOf(ctx);
    if (!dir || !installedLocal(dir)[backend.local].usable) throw new Error(`Install ${backend.label} first, under On this computer.`);
    return { backend: kind, accountId: null, model: null };
  }
  const model = input.model === OTHER_MODEL ? cleanId(input.modelOther, 'model id', 150) : cleanId(input.model, 'model id', 150);
  if (!backend.accountKind) return { backend: kind, accountId: null, model };
  const accountId = input.account?.trim() || null;
  if (!accountId) throw new Error(`Choose an ${backend.label} account for ${side}.`);
  const account = ctx.buddi!.accounts!.list().find((a) => a.id === accountId);
  if (!account) throw new Error('That account is not in Settings → Model accounts.');
  if (account.kind !== backend.accountKind) throw new Error(`"${account.label}" is not an ${backend.label} account.`);
  // Choosing it here is the owner binding it to this plugin: only a bound
  // account can be resolved through ctx.buddi.accounts.
  await ctx.buddi!.accounts!.bind(accountId);
  // An Ollama Cloud account is an OpenAI-compatible kind with no audio
  // routes; the listing cannot tell it apart, the resolved address can.
  let resolved: { baseUrl: string; deviceKey?: string } | null = null;
  try {
    resolved = await ctx.buddi!.accounts!.resolve(accountId, model ?? 'whisper-1');
  } catch {
    // Not resolvable now (a locked vault, no key yet): the tool says so when it is used.
  }
  if (resolved && isOllamaCloud(resolved)) throw new Error('Ollama Cloud serves no audio routes; choose another account.');
  return { backend: kind, accountId, model };
}

/** The chosen languages: ISO 639-1 codes, each once, at most eight. */
function cleanLanguages(input: string[] | undefined): string[] {
  const codes = [...new Set((input ?? []).map((c) => c.trim().toLowerCase()).filter((c) => c !== ''))];
  if (codes.some((c) => !/^[a-z]{2}$/.test(c))) throw new Error('Choose the languages from the list.');
  if (codes.length > MAX_LANGUAGES) throw new Error(`Choose at most ${MAX_LANGUAGES} languages.`);
  return codes;
}

/**
 * The Speaking form's voices: the one Voice field, and a voice per language
 * row. A row left out (hidden, greyed) keeps its voice; one emptied drops it.
 * Saved from the rows, the one voice follows the owner's first language that
 * has a voice, so a language outside the map and a later switch to the one
 * field start from it.
 */
function voicesFrom(input: z.infer<typeof settingsInput>, current: Settings): { voice: string | null; voices: Record<string, string> } {
  const voices = { ...current.speaking.voices };
  const rows = input as unknown as Record<string, string | undefined>;
  const given = ROW_LANGUAGES.filter((l) => rows[`voice_${l}`] !== undefined);
  for (const l of given) {
    const v = cleanId(rows[`voice_${l}`], 'voice name', 80);
    if (v) voices[l] = v;
    else delete voices[l];
  }
  if (input.voice !== undefined) return { voice: cleanId(input.voice, 'voice name', 80), voices };
  if (given.length === 0) return { voice: current.speaking.voice, voices };
  const first = current.listening.languages.find((l) => voices[l]);
  return { voice: first ? voices[first]! : current.speaking.voice, voices };
}

/** What Save says about one side's service. */
function savedNote(side: SideName, backend: string | null): string {
  const name = side === 'listening' ? 'Listening' : 'Speaking';
  const tool = side === 'listening' ? 'speech.transcribe' : 'speech.say';
  if (backend && backend !== OFF) return `Saved. ${name} uses ${backendFor(backend)!.label}.`;
  if (backend === OFF) return `Saved. ${name} is off, so ${tool} refuses, even with a model on this computer.`;
  return `Saved. ${name} uses the model on this computer once it is installed; until then ${tool} refuses.`;
}

export const setSettingsTool: ToolDefinition<z.infer<typeof settingsInput>, unknown> = {
  name: 'speech.set_settings',
  description: "The Speech settings. The owner's own.",
  tier: 'auto',
  ownerOnly: true,
  input: settingsInput,
  async execute(input, ctx) {
    const current = await getSettings(ctx.buddi!.db);
    const next: Settings = structuredClone(current);
    let note: string;
    if (input.side === 'limits') {
      next.transcribeCap = input.transcribeCap ?? current.transcribeCap;
      next.sayCap = input.sayCap ?? current.sayCap;
      note = `Saved. Up to ${next.transcribeCap} transcriptions and ${next.sayCap} spoken replies a day.`;
    } else if (input.side === 'listening') {
      const choice = await sideChoice(ctx, 'listening', input);
      next.listening = { ...choice, languages: cleanLanguages(input.languages) };
      note = savedNote('listening', choice.backend);
    } else {
      const choice = await sideChoice(ctx, 'speaking', input);
      next.speaking = { ...choice, ...voicesFrom(input, current) };
      note = savedNote('speaking', choice.backend);
    }
    const saved = await setSettings(ctx.buddi!.db, next, ctx.buddi!.clock.now());
    return { ...saved, note };
  },
};

/* ------------------------------------------------------------------ *
 * speech.telegram_voice — voice replies on Telegram
 * ------------------------------------------------------------------ */

/** The page's two selects, with the defaults shown when nothing is chosen yet. */
async function telegramChoice(ctx: ToolContext): Promise<{ telegramWhen: string; telegramForm: string }> {
  const chosen = await getTelegramVoice(ctx.buddi!.db);
  return { telegramWhen: chosen.when ?? 'spoken', telegramForm: chosen.form ?? 'voice' };
}

const telegramVoiceInput = z
  .object({
    when: z.enum(VOICE_WHEN as [string, ...string[]]).optional(),
    form: z.enum(VOICE_FORM as [string, ...string[]]).optional(),
  })
  .strict();

const WHEN_WORDS: Record<string, string> = {
  spoken: 'a voice note answers yours',
  always: 'every answer is spoken',
  off: 'answers are text only',
};

/**
 * Read (no arguments) or set when Telegram answers with a voice and what it
 * sends. The owner's own: the page's On Telegram block and the Telegram
 * surface (`/voice`, and every answer, which reads it) call it as the owner.
 * `when`/`form` come back null when never chosen here.
 */
export const telegramVoiceTool: ToolDefinition<z.infer<typeof telegramVoiceInput>, unknown> = {
  name: 'speech.telegram_voice',
  description: "Voice replies on Telegram: when, and what is sent. The owner's own.",
  tier: 'auto',
  ownerOnly: true,
  input: telegramVoiceInput,
  async execute(input, ctx) {
    const db = ctx.buddi!.db;
    if (input.when === undefined && input.form === undefined) return getTelegramVoice(db);
    const saved = await setTelegramVoice(
      db,
      { ...(input.when ? { when: input.when as never } : {}), ...(input.form ? { form: input.form as never } : {}) },
      ctx.buddi!.clock.now(),
    );
    const when = saved.when ?? 'spoken';
    const form = saved.form ?? 'voice';
    const note = when === 'off'
      ? `Saved. On Telegram, ${WHEN_WORDS.off}.`
      : `Saved. On Telegram, ${WHEN_WORDS[when]}, ${form === 'both' ? 'with its text as the caption' : 'the voice note alone'}.`;
    return { ...saved, note };
  },
};

/* ------------------------------------------------------------------ *
 * speech.test — the Listening block's Test button
 *
 * Speaking has no Test: the play button beside the Voice (`speech.preview`)
 * says a sample in the browser and keeps nothing.
 * ------------------------------------------------------------------ */

const testInput = z.object({ side: z.literal('listening') }).strict();

export interface TestToolOptions {
  fetch?: typeof fetch;
  timeoutMs?: number;
}

export function createTestTool(options: TestToolOptions = {}): ToolDefinition<z.infer<typeof testInput>, unknown> {
  const passOn = { ...(options.fetch ? { fetch: options.fetch } : {}), ...(options.timeoutMs ? { timeoutMs: options.timeoutMs } : {}) };
  return {
    name: 'speech.test',
    description: "Try the chosen listening service on a short clip. The owner's own.",
    tier: 'auto',
    ownerOnly: true,
    input: testInput,
    async execute(_input, ctx) {
      const agentId = ctx.agentId?.trim() || 'owner';
      const bytes = await readFile(TEST_CLIP);
      const heard = await transcribeBytes(ctx, { bytes, mime: sniffAudio(bytes)!, artifactId: null, language: 'en' }, { agentId, ...passOn });
      return { ...heard, note: heard.text ? `Heard: "${heard.text}" (the clip says "Hello from buddi. This is a test.")` : 'The service answered with no words.' };
    },
  };
}

export const testTool = createTestTool();

/* ------------------------------------------------------------------ *
 * The page
 * ------------------------------------------------------------------ */

const cloud = ['openai', 'openai-compatible'];

/**
 * One language's voice on the Speaking form ("French voice"), with its play
 * button saying the sample in that language. Shown for a language the owner
 * speaks when the saved service has voices per language; greyed while the
 * form holds a service that has not.
 */
function voiceRow(lang: string): Field {
  const name = languageName(lang);
  return {
    name: `voice_${lang}`, label: `${name} voice`, type: 'select', from: `speakVoices.${lang}`,
    optionsFrom: { query: { query: 'voices', params: { lang: { const: lang } } }, rows: 'voices', value: 'id', label: 'label', dependsOn: ['speakBackend'] },
    when: { path: `voiceRows.${lang}`, equals: true },
    disabledWhen: { path: 'speakBackend', in: LANGUAGE_VOICED, not: true },
    action: {
      tool: 'speech.preview', label: `Play a sample in ${name}`, icon: 'play',
      args: {
        backend: { field: 'speakBackend' }, account: { field: 'account' }, model: { field: 'model' },
        modelOther: { field: 'modelOther' }, voice: { field: `voice_${lang}` }, lang: { const: lang },
      },
    },
  };
}

export const speechPages: PageDescriptor[] = [
  {
    id: 'settings',
    title: 'Speech',
    place: 'settings',
    icon: 'bell',
    data: { query: 'settings' },
    body: [
      { kind: 'notice', text: { path: 'listenStatus' } },
      { kind: 'notice', text: { path: 'speakStatus' } },
      { kind: 'notice', text: SPEECH_NOTICE },
      {
        kind: 'section',
        title: 'On this computer',
        note: LOCAL_NOTE,
        body: [
          {
            kind: 'repeat',
            query: { query: 'install_status' },
            rows: 'models',
            key: 'kind',
            poll: { seconds: 2, while: { path: 'busy', equals: true } },
            body: [
              { kind: 'notice', text: { path: 'line' }, when: { path: 'state', in: ['absent', 'failed'] } },
              {
                kind: 'progress',
                when: { path: 'state', in: ['installing', 'installed'] },
                value: { path: 'bytes' },
                total: { path: 'total' },
                label: { path: 'heading' },
                done: { path: 'done' },
              },
              {
                kind: 'button',
                when: { path: 'state', in: ['absent', 'failed'] },
                action: { tool: 'speech.install', label: 'Install', busy: 'Starting…', args: { kind: { path: 'kind' } }, done: { path: 'note' } },
              },
              {
                kind: 'button',
                when: { path: 'state', equals: 'installed' },
                action: {
                  tool: 'speech.remove', label: 'Remove', tone: 'danger', busy: 'Removing…',
                  confirm: 'Remove {label} from this computer? It can be installed again later.',
                  args: { kind: { path: 'kind' } }, done: { path: 'note' },
                },
              },
            ],
          },
        ],
      },
      {
        kind: 'section',
        title: 'Listening',
        note: 'Turns a recording into text for speech.transcribe.',
        actions: [{ kind: 'button', action: { tool: 'speech.test', label: 'Test', busy: 'Listening…', args: { side: { const: 'listening' } }, done: { path: 'note' } } }],
        body: [
          { kind: 'notice', tone: 'neutral', text: { path: 'listenLanguagesNote' }, when: { path: 'listenLanguagesNote', equals: '', not: true } },
          {
            kind: 'form',
            initial: { query: 'settings' },
            fields: [
              { name: 'listenBackend', label: 'Service', type: 'select', from: 'listenBackend', optionsFrom: { query: { query: 'settings' }, rows: 'listenBackends', value: 'id', label: 'label' } },
              {
                name: 'account', label: 'Account', type: 'select', from: 'listenAccount',
                optionsFrom: { query: { query: 'listen_accounts' }, rows: 'choices', value: 'id', label: 'label', dependsOn: ['listenBackend'] },
                when: { path: 'listenBackend', in: cloud },
              },
              {
                name: 'model', label: 'Model', type: 'select', from: 'listenModel',
                optionsFrom: { query: { query: 'listen_models' }, rows: 'choices', value: 'id', label: 'label', dependsOn: ['listenBackend', 'account'] },
                hint: 'The models this account offers. A new account lists them once it is saved.',
                when: { path: 'listenBackend', in: cloud },
              },
              { name: 'modelOther', label: 'Model id', type: 'text', hint: 'The id your server names, e.g. whisper-1.', when: { path: 'model', equals: OTHER_MODEL } },
              {
                name: 'languages', label: 'Languages you speak', type: 'select', multiple: true, from: 'listenLanguages',
                options: LANGUAGES.map((l) => ({ value: l.code, label: l.name })),
                max: MAX_LANGUAGES,
                hint: 'None uses the language in your profile, or lets the service detect any; one is sent as the language; several are the ones Whisper chooses between.',
              },
            ],
            submit: {
              tool: 'speech.set_settings', label: 'Save', busy: 'Saving…',
              args: {
                side: { const: 'listening' }, backend: { field: 'listenBackend' }, account: { field: 'account' },
                model: { field: 'model' }, modelOther: { field: 'modelOther' }, languages: { field: 'languages' },
              },
              done: { path: 'note' },
            },
          },
        ],
      },
      {
        kind: 'section',
        title: 'Speaking',
        note: 'Turns a reply into a voice for speech.say.',
        body: [
          { kind: 'notice', text: { path: 'speakNotice' }, when: { path: 'speakNotice', equals: '', not: true } },
          {
            kind: 'form',
            initial: { query: 'settings' },
            columns: 3,
            fields: [
              { name: 'speakBackend', label: 'Service', type: 'select', from: 'speakBackend', optionsFrom: { query: { query: 'settings' }, rows: 'speakBackends', value: 'id', label: 'label' } },
              {
                name: 'account', label: 'Account', type: 'select', from: 'speakAccount',
                optionsFrom: { query: { query: 'speak_accounts' }, rows: 'choices', value: 'id', label: 'label', dependsOn: ['speakBackend'] },
                when: { path: 'speakBackend', in: cloud },
              },
              {
                name: 'model', label: 'Model', type: 'select', from: 'speakModel',
                optionsFrom: { query: { query: 'speak_models' }, rows: 'choices', value: 'id', label: 'label', dependsOn: ['speakBackend', 'account'] },
                hint: 'The models this account offers. A new account lists them once it is saved.',
                when: { path: 'speakBackend', in: cloud },
              },
              { name: 'modelOther', label: 'Model id', type: 'text', hint: 'The id your server names.', when: { path: 'model', equals: OTHER_MODEL } },
              {
                name: 'voice', label: 'Voice', type: 'select', from: 'speakVoice',
                optionsFrom: { query: { query: 'voices' }, rows: 'voices', value: 'id', label: 'label', dependsOn: ['speakBackend'] },
                when: { path: 'voiceByLanguage', equals: false },
                // Heard in the browser with what the form holds now, saved or not; nothing is kept.
                action: {
                  tool: 'speech.preview', label: 'Play a sample', icon: 'play',
                  args: {
                    backend: { field: 'speakBackend' }, account: { field: 'account' }, model: { field: 'model' },
                    modelOther: { field: 'modelOther' }, voice: { field: 'voice' },
                  },
                },
              },
              ...ROW_LANGUAGES.map(voiceRow),
            ],
            submit: {
              tool: 'speech.set_settings', label: 'Save', busy: 'Saving…',
              args: {
                side: { const: 'speaking' }, backend: { field: 'speakBackend' }, account: { field: 'account' },
                model: { field: 'model' }, modelOther: { field: 'modelOther' }, voice: { field: 'voice' },
                ...Object.fromEntries(ROW_LANGUAGES.map((l) => [`voice_${l}`, { field: `voice_${l}` }])),
              },
              done: { path: 'note' },
            },
          },
        ],
      },
      {
        kind: 'section',
        title: 'On Telegram',
        note: 'How your chat answers with a voice. /voice in the chat changes the same two choices.',
        body: [
          {
            kind: 'form',
            initial: { query: 'settings' },
            fields: [
              {
                name: 'when', label: 'Answer with a voice', type: 'select', from: 'telegramWhen',
                options: [
                  { value: 'spoken', label: 'When I send a voice note' },
                  { value: 'always', label: 'Always' },
                  { value: 'off', label: 'Never: text only' },
                ],
              },
              {
                name: 'form', label: 'Send', type: 'select', from: 'telegramForm',
                options: [
                  { value: 'voice', label: 'The voice note alone' },
                  { value: 'both', label: 'The voice note with the text' },
                ],
                when: { path: 'when', in: ['spoken', 'always'] },
              },
            ],
            submit: {
              tool: 'speech.telegram_voice', label: 'Save', busy: 'Saving…',
              args: { when: { field: 'when' }, form: { field: 'form' } },
              done: { path: 'note' },
            },
          },
        ],
      },
      {
        kind: 'section',
        title: 'Daily limits',
        note: 'Counted from midnight, yours and every agent\'s together.',
        body: [
          {
            kind: 'form',
            initial: { query: 'settings' },
            fields: [
              { name: 'transcribeCap', label: 'Transcriptions per day', type: 'number', min: 1, max: 10000, step: 1, required: true, from: 'transcribeCap' },
              { name: 'sayCap', label: 'Spoken replies per day', type: 'number', min: 1, max: 10000, step: 1, required: true, from: 'sayCap' },
            ],
            submit: {
              tool: 'speech.set_settings', label: 'Save', busy: 'Saving…',
              args: { side: { const: 'limits' }, transcribeCap: { field: 'transcribeCap' }, sayCap: { field: 'sayCap' } },
              done: { path: 'note' },
            },
          },
        ],
      },
      {
        kind: 'section',
        title: 'What leaves',
        body: [
          { kind: 'notice', text: { path: 'leavesListening' } },
          { kind: 'notice', text: { path: 'leavesSpeaking' } },
          { kind: 'notice', text: WHY_NOT_LISTED },
          {
            kind: 'table',
            query: { query: 'settings' },
            rows: 'accounts',
            columns: [
              { key: 'label', label: 'Account' },
              { key: 'kind', label: 'Kind' },
              { key: 'offered', label: 'Speech', pill: {} },
            ],
            empty: 'No model accounts yet. Add one in Settings → Model accounts.',
          },
        ],
      },
      {
        kind: 'section',
        title: 'Recent',
        note: 'The newest twenty uses, with who asked.',
        body: [
          {
            kind: 'table',
            query: { query: 'recent' },
            rows: 'uses',
            columns: [
              { key: 'side', label: 'What' },
              { key: 'agent', label: 'Agent' },
              { key: 'model', label: 'Model' },
              { key: 'chars', label: 'Characters' },
              { key: 'createdAt', label: 'When', type: 'date' },
            ],
            empty: 'Nothing yet.',
          },
        ],
      },
    ],
  },
];
