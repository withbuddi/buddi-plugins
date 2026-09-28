/**
 * Kokoro's voices by language. A voice id's first letter is its language
 * (`af_heart`: American English, `ff_siwis`: French). `kokoro-js` lists and
 * phonemizes the English ones; the pack it ships holds the rest too, and
 * `phonemes.ts` says them through eSpeak NG, as Kokoro's own Python pipeline
 * (misaki) does. Japanese and Chinese need a different G2P (pyopenjtalk,
 * a pinyin front end) and are left out.
 */

/** The languages Kokoro on this computer speaks, ISO 639-1. */
export type KokoroLanguage = 'en' | 'fr' | 'es' | 'it' | 'pt' | 'hi';

export const KOKORO_LANGUAGES: readonly KokoroLanguage[] = ['en', 'fr', 'es', 'it', 'pt', 'hi'];

/** The voice id's first letter → its language; `j` and `z` are known and not spoken. */
const BY_PREFIX: Record<string, KokoroLanguage | 'ja' | 'zh'> = {
  a: 'en', b: 'en', f: 'fr', e: 'es', i: 'it', p: 'pt', h: 'hi', j: 'ja', z: 'zh',
};

export interface KokoroVoice {
  id: string;
  name: string;
  language: KokoroLanguage;
  /** BCP-47, as the page and `Voice.language` carry it. */
  tag: string;
  gender: 'female' | 'male';
}

const NAMES: Record<Exclude<KokoroLanguage, 'en'>, string> = {
  fr: 'French', es: 'Spanish', it: 'Italian', pt: 'Portuguese', hi: 'Hindi',
};

const TAGS: Record<Exclude<KokoroLanguage, 'en'>, string> = { fr: 'fr-fr', es: 'es', it: 'it', pt: 'pt-br', hi: 'hi' };

/** The voices beyond English, in Kokoro's VOICES.md order; the first of each language is its default. */
export const OTHER_VOICES: readonly KokoroVoice[] = (
  [
    ['ff_siwis', 'Siwis'],
    ['ef_dora', 'Dora'], ['em_alex', 'Alex'], ['em_santa', 'Santa'],
    ['if_sara', 'Sara'], ['im_nicola', 'Nicola'],
    ['pf_dora', 'Dora'], ['pm_alex', 'Alex'], ['pm_santa', 'Santa'],
    ['hf_alpha', 'Alpha'], ['hf_beta', 'Beta'], ['hm_omega', 'Omega'], ['hm_psi', 'Psi'],
  ] as const
).map(([id, name]) => {
  const language = BY_PREFIX[id[0]!] as Exclude<KokoroLanguage, 'en'>;
  return { id, name, language, tag: TAGS[language], gender: id[1] === 'f' ? 'female' : 'male' };
});

/** "Siwis (French, female)". */
export function otherVoiceLabel(v: KokoroVoice): string {
  return `${v.name} (${NAMES[v.language as Exclude<KokoroLanguage, 'en'>]}, ${v.gender})`;
}

/** The language a voice speaks, by its first letter; undefined for an id Kokoro does not have. */
export function voiceLanguage(voice: string): KokoroLanguage | 'ja' | 'zh' | undefined {
  return /^[a-z][fm]_/.test(voice) ? BY_PREFIX[voice[0]!] : undefined;
}

/** The default voice for a language: the first one of it. */
export const FIRST_VOICE: Readonly<Record<KokoroLanguage, string>> = {
  en: 'af_heart',
  fr: 'ff_siwis',
  es: 'ef_dora',
  it: 'if_sara',
  pt: 'pf_dora',
  hi: 'hf_alpha',
};

export function isKokoroLanguage(code: string | undefined): code is KokoroLanguage {
  return code !== undefined && (KOKORO_LANGUAGES as readonly string[]).includes(code);
}
