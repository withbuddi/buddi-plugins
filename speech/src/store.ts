/** The plugin's two tables: the owner's settings, and one row per use. */
import type { DbArea } from '@buddi/core/plugin';
import { languageHint } from './languages.js';
import { voiceLanguage } from './local/voices.js';

/** `ctx.buddi.db`, or anything that answers a query as it does. */
type Db = Pick<DbArea, 'query'>;

export const DEFAULT_TRANSCRIBE_CAP = 200;
export const DEFAULT_SAY_CAP = 200;

export interface ListeningSettings {
  backend: string | null;
  accountId: string | null;
  model: string | null;
  /**
   * The languages the owner speaks, ISO 639-1 codes (at most 8); empty lets
   * the service detect any. One is sent as the language; several restrict
   * Whisper's detection to them.
   */
  languages: string[];
}

export interface SpeakingSettings {
  backend: string | null;
  accountId: string | null;
  model: string | null;
  /** The voice for a language not in `voices`, and the one voice of a speaker whose voices carry no language. */
  voice: string | null;
  /** ISO 639-1 → voice id: the voice that speaks each language the owner speaks (Kokoro's). */
  voices: Record<string, string>;
}

export interface Settings {
  listening: ListeningSettings;
  speaking: SpeakingSettings;
  /** Transcriptions a day. */
  transcribeCap: number;
  /** Utterances a day. */
  sayCap: number;
}

export type Side = 'listen' | 'speak';

interface Row {
  listen_backend: string | null; listen_account_id: string | null; listen_model: string | null; listen_language: string | null;
  listen_languages: string[] | null;
  speak_backend: string | null; speak_account_id: string | null; speak_model: string | null; speak_voice: string | null;
  speak_voices: Record<string, unknown> | null;
  transcribe_cap: number; say_cap: number;
}

export async function getSettings(db: Db): Promise<Settings> {
  const { rows } = await db.query(
    `select listen_backend, listen_account_id, listen_model, listen_language, listen_languages,
            speak_backend, speak_account_id, speak_model, speak_voice, speak_voices, transcribe_cap, say_cap
       from speech.settings where id`,
  );
  const row = rows[0] as Row | undefined;
  const languages = languagesOf(row);
  return {
    listening: {
      backend: row?.listen_backend ?? null,
      accountId: row?.listen_account_id ?? null,
      model: row?.listen_model ?? null,
      languages,
    },
    speaking: {
      backend: row?.speak_backend ?? null,
      accountId: row?.speak_account_id ?? null,
      model: row?.speak_model ?? null,
      voice: row?.speak_voice ?? null,
      voices: voicesOf(row, languages),
    },
    transcribeCap: row?.transcribe_cap ?? DEFAULT_TRANSCRIBE_CAP,
    sayCap: row?.say_cap ?? DEFAULT_SAY_CAP,
  };
}

/**
 * The stored list, or the one language hint an earlier version kept
 * (`listen_language`: a code or a name), as a one-element list until the
 * next save writes the list and clears the hint.
 */
function languagesOf(row: Row | undefined): string[] {
  if (row?.listen_languages && row.listen_languages.length > 0) return row.listen_languages;
  const old = languageHint(row?.listen_language);
  return old ? [old] : [];
}

/**
 * The stored voice per language; or, before the first save that writes one,
 * the one saved voice as the voice of the owner's first language (English
 * when they listed none). A Kokoro voice goes to its own language when the
 * owner speaks it: an English voice is not a French one.
 */
function voicesOf(row: Row | undefined, languages: readonly string[]): Record<string, string> {
  const stored = row?.speak_voices ?? {};
  const voices = Object.fromEntries(
    Object.entries(stored).filter((e): e is [string, string] => /^[a-z]{2}$/.test(e[0]) && typeof e[1] === 'string' && e[1] !== ''),
  );
  if (Object.keys(voices).length > 0 || Object.keys(stored).length > 0) return voices;
  const voice = row?.speak_voice?.trim();
  if (!voice) return {};
  const own = voiceLanguage(voice);
  const lang = own && languages.includes(own) ? own : (languages[0] ?? 'en');
  return { [lang]: voice };
}

export async function setSettings(db: Db, s: Settings, now: Date): Promise<Settings> {
  await db.query(
    `insert into speech.settings (id, listen_backend, listen_account_id, listen_model, listen_language, listen_languages,
                                  speak_backend, speak_account_id, speak_model, speak_voice, speak_voices,
                                  transcribe_cap, say_cap, updated_at)
     values (true, $1, $2, $3, null, $4, $5, $6, $7, $8, $12::jsonb, $9, $10, $11)
     on conflict (id) do update set
       listen_backend = excluded.listen_backend, listen_account_id = excluded.listen_account_id,
       listen_model = excluded.listen_model, listen_language = null, listen_languages = excluded.listen_languages,
       speak_backend = excluded.speak_backend, speak_account_id = excluded.speak_account_id,
       speak_model = excluded.speak_model, speak_voice = excluded.speak_voice, speak_voices = excluded.speak_voices,
       transcribe_cap = excluded.transcribe_cap, say_cap = excluded.say_cap, updated_at = excluded.updated_at`,
    [s.listening.backend, s.listening.accountId, s.listening.model, s.listening.languages,
      s.speaking.backend, s.speaking.accountId, s.speaking.model, s.speaking.voice,
      s.transcribeCap, s.sayCap, now, JSON.stringify(s.speaking.voices ?? {})],
  );
  return getSettings(db);
}

/** Uses of one side since midnight in the owner's timezone. */
export async function countToday(db: Db, side: Side, now: Date, timezone: string): Promise<number> {
  const { rows } = await db.query(
    `select count(*)::int as n from speech.usage
      where side = $1 and created_at >= (date_trunc('day', $2::timestamptz at time zone $3) at time zone $3)`,
    [side, now, timezone],
  );
  return (rows[0] as { n: number }).n;
}

export interface UsageRecord {
  side: Side;
  agentId: string;
  conversationId: string | null;
  artifactId: string | null;
  backend: string;
  accountId: string | null;
  model: string;
  chars: number;
  bytes: number;
  now: Date;
}

export async function recordUsage(db: Db, r: UsageRecord): Promise<void> {
  await db.query(
    `insert into speech.usage (side, agent_id, conversation_id, artifact_id, backend, account_id, model, chars, bytes, created_at)
     values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)`,
    [r.side, r.agentId, r.conversationId, r.artifactId, r.backend, r.accountId, r.model, r.chars, r.bytes, r.now],
  );
}

export async function recentUsage(db: Db, limit = 20): Promise<Array<Record<string, unknown>>> {
  const { rows } = await db.query(
    `select id::text, case side when 'listen' then 'Listened' else 'Spoke' end as side, agent_id as agent,
            backend, model, chars, bytes, created_at as "createdAt"
       from speech.usage order by created_at desc limit $1`,
    [limit],
  );
  return rows as Array<Record<string, unknown>>;
}

/* ------------------------------------------------------------------ *
 * Voice replies on Telegram
 * ------------------------------------------------------------------ */

export type VoiceWhen = 'spoken' | 'always' | 'off';
export type VoiceForm = 'voice' | 'both';
export const VOICE_WHEN: readonly VoiceWhen[] = ['spoken', 'always', 'off'];
export const VOICE_FORM: readonly VoiceForm[] = ['voice', 'both'];

/** What the owner chose here; null is "not chosen here", and the chat's own setting applies. */
export interface TelegramVoice {
  when: VoiceWhen | null;
  form: VoiceForm | null;
}

export async function getTelegramVoice(db: Db): Promise<TelegramVoice> {
  const { rows } = await db.query(`select telegram_voice_when, telegram_voice_form from speech.settings where id`);
  const row = rows[0] as { telegram_voice_when: string | null; telegram_voice_form: string | null } | undefined;
  const when = row?.telegram_voice_when ?? null;
  const form = row?.telegram_voice_form ?? null;
  return {
    when: when && (VOICE_WHEN as readonly string[]).includes(when) ? (when as VoiceWhen) : null,
    form: form && (VOICE_FORM as readonly string[]).includes(form) ? (form as VoiceForm) : null,
  };
}

/** Set either or both; what is left out keeps its value. */
export async function setTelegramVoice(db: Db, patch: Partial<TelegramVoice>, now: Date): Promise<TelegramVoice> {
  await db.query(
    `insert into speech.settings (id, telegram_voice_when, telegram_voice_form, updated_at)
     values (true, $1, $2, $3)
     on conflict (id) do update set
       telegram_voice_when = coalesce(excluded.telegram_voice_when, speech.settings.telegram_voice_when),
       telegram_voice_form = coalesce(excluded.telegram_voice_form, speech.settings.telegram_voice_form),
       updated_at = excluded.updated_at`,
    [patch.when ?? null, patch.form ?? null, now],
  );
  return getTelegramVoice(db);
}
