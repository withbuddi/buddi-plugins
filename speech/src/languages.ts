/**
 * "Languages you speak": the curated list the Speech page offers, by name,
 * stored as ISO 639-1 codes. All of them are Whisper languages, so the local
 * listener can restrict its detection to the chosen ones.
 */
export const LANGUAGES: ReadonlyArray<{ code: string; name: string }> = [
  { code: 'en', name: 'English' },
  { code: 'fr', name: 'French' },
  { code: 'es', name: 'Spanish' },
  { code: 'de', name: 'German' },
  { code: 'pt', name: 'Portuguese' },
  { code: 'it', name: 'Italian' },
  { code: 'nl', name: 'Dutch' },
  { code: 'ar', name: 'Arabic' },
  { code: 'zh', name: 'Chinese' },
  { code: 'ja', name: 'Japanese' },
  { code: 'ko', name: 'Korean' },
  { code: 'hi', name: 'Hindi' },
  { code: 'ru', name: 'Russian' },
  { code: 'tr', name: 'Turkish' },
  { code: 'pl', name: 'Polish' },
  { code: 'sv', name: 'Swedish' },
  { code: 'uk', name: 'Ukrainian' },
  { code: 'el', name: 'Greek' },
  { code: 'he', name: 'Hebrew' },
  { code: 'id', name: 'Indonesian' },
  { code: 'vi', name: 'Vietnamese' },
  { code: 'th', name: 'Thai' },
  { code: 'fa', name: 'Persian' },
  { code: 'ro', name: 'Romanian' },
  { code: 'cs', name: 'Czech' },
  { code: 'da', name: 'Danish' },
];

/** The most languages one owner lists. */
export const MAX_LANGUAGES = 8;

const NAME_OF = new Map(LANGUAGES.map((l) => [l.code, l.name]));

/** "fr" → "French"; a code off the list stays as it is. */
export function languageName(code: string): string {
  return NAME_OF.get(code) ?? code;
}

/** "French", "French and Spanish", "French, Spanish and German". */
export function namesOf(codes: readonly string[]): string {
  const names = codes.map(languageName);
  return names.length <= 1 ? (names[0] ?? '') : `${names.slice(0, -1).join(', ')} and ${names.at(-1)}`;
}

/**
 * An ISO-639-1 hint from what the owner or an agent wrote: a tag ("en",
 * "pt-BR") or a common language name ("French"). Anything else: no hint,
 * and the service detects the language itself.
 */
const NAMES: Record<string, string> = {
  english: 'en', french: 'fr', 'français': 'fr', francais: 'fr', spanish: 'es', 'español': 'es', espanol: 'es',
  german: 'de', deutsch: 'de', italian: 'it', italiano: 'it', portuguese: 'pt', 'português': 'pt', dutch: 'nl',
  japanese: 'ja', chinese: 'zh', mandarin: 'zh', korean: 'ko', arabic: 'ar', russian: 'ru', hindi: 'hi',
  turkish: 'tr', polish: 'pl', swedish: 'sv', ukrainian: 'uk', greek: 'el',
};

export function languageHint(value: string | null | undefined): string | undefined {
  const raw = value?.trim().toLowerCase();
  if (!raw) return undefined;
  const tag = /^([a-z]{2,3})(?:[-_][a-z0-9]{2,8})*$/.exec(raw);
  if (tag && !Object.hasOwn(NAMES, raw)) return tag[1];
  return Object.hasOwn(NAMES, raw) ? NAMES[raw] : undefined;
}
