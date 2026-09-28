/**
 * Text → Kokoro's phonemes for French, Spanish, Italian, Portuguese and
 * Hindi, the way Kokoro's own pipeline does it (misaki's `EspeakG2P`, for
 * the v1.0 model): eSpeak NG's IPA with stress, the phonemes eSpeak writes as
 * one (affricates, diphthongs) folded to Kokoro's single symbols, then only
 * what Kokoro's tokenizer knows. English does not come here: `kokoro-js`
 * phonemizes it itself.
 *
 * Punctuation is kept the way misaki's phonemizer keeps it: the text is cut
 * at the marks, each piece goes to eSpeak, and the marks go back between the
 * pieces. A mark between two digits ("15:30", "3,5") is part of the number.
 *
 * eSpeak itself (`espeak.ts`) runs only in the speech worker; this file is
 * plain string work, so the tests feed it eSpeak's recorded output.
 */
import type { KokoroLanguage } from './voices.js';

/** What `phonemize` needs from eSpeak: its raw phoneme string for one piece of text. */
export interface EspeakLike {
  /**
   * Phonemes in IPA with each phoneme followed by `_` (so a phoneme written
   * with two letters, like `tʃ`, stays one), words by spaces, clauses by `|`.
   */
  raw(text: string, voice: string): string;
}

/** The eSpeak voice for each language: Kokoro's `LANG_CODES` (Brazilian Portuguese). */
export const ESPEAK_VOICE: Readonly<Record<Exclude<KokoroLanguage, 'en'>, string>> = {
  fr: 'fr',
  es: 'es',
  it: 'it',
  pt: 'pt-br',
  hi: 'hi',
};

/**
 * misaki's `EspeakG2P.e2m` (v1.0): phonemes eSpeak writes with two letters
 * and a tie, as Kokoro's one symbol.
 */
const E2M: ReadonlyArray<readonly [string, string]> = [
  ['aɪ', 'I'], ['aʊ', 'W'],
  ['dz', 'ʣ'], ['dʒ', 'ʤ'],
  ['eɪ', 'A'],
  ['oʊ', 'O'], ['əʊ', 'Q'],
  ['ss', 'S'],
  ['ts', 'ʦ'], ['tʃ', 'ʧ'],
  ['ɔɪ', 'Y'],
];

/** Kokoro-82M v1.0's tokenizer vocabulary (`tokenizer.json`, pinned in `models.ts`): every symbol it reads. */
export const KOKORO_SYMBOLS: ReadonlySet<string> = new Set(
  " !\"$(),.:;?AIOQSTWYabcdefhijklmnopqrstuvwxyzæçðøŋœɐɑɒɔɕɖəɚɛɜɟɡɣɤɥɨɪɯɰɲɳɴɸɹɻɽɾʁʂʃʈʊʋʌʎʒʔʝʣʤʥʦʧʨʰʲˈˌː̃βθχᵊᵝᵻ—“”…→↓↗↘ꭧ",
);

/** The marks the text is cut at (phonemizer's default set, and the Devanagari danda). */
const MARKS = ';:,.!?¡¿—…"«»“”(){}[]।॥';
const MARK_CLASS = MARKS.replace(/[\]\[\\^-]/g, '\\$&');
/** A run of marks, but not `.`, `,` or `:` inside a number. */
const CUT = new RegExp(`((?:[${MARK_CLASS.replace(/[.,:]/g, '')}]|[.,:](?!\\d)|(?<!\\d)[.,:])+)`, 'u');
const IS_MARKS = new RegExp(`^(?:[${MARK_CLASS}])+$`, 'u');

/** Marks Kokoro has no symbol for, as the ones it has; the rest pass through the vocabulary check. */
function kokoroMarks(marks: string): string {
  return marks
    .replace(/[।॥]/g, '.')
    .replace(/«/g, '“')
    .replace(/»/g, '”')
    .replace(/[{[]/g, '(')
    .replace(/[}\]]/g, ')')
    .replace(/[¡¿]/g, '');
}

/**
 * eSpeak's raw output as Kokoro's phonemes: language-switch flags out,
 * each phoneme folded (`E2M`), the separators, clause bars and the `-` misaki
 * deletes gone.
 */
export function fromEspeak(raw: string): string {
  return raw
    .replace(/\([a-z]{2,3}(?:-[a-z0-9]+)*\)/gi, '')
    .split(/\s+/)
    .filter((w) => w !== '' && w !== '|')
    .map((word) =>
      word
        .split('_')
        .map((phoneme) => {
          let p = phoneme.replace(/-/g, '');
          for (const [from, to] of E2M) if (p.includes(from)) p = p.replace(from, to);
          return p;
        })
        .join(''),
    )
    .join(' ');
}

const dropped = new Set<string>();

/**
 * Only what Kokoro's tokenizer reads: a symbol it lacks is tried as its
 * decomposition (a precomposed nasal vowel is a vowel and U+0303), and
 * dropped otherwise, with one line in the log the first time.
 */
export function kokoroOnly(phonemes: string, log: (line: string) => void = (l) => console.warn(l)): string {
  let out = '';
  for (const c of phonemes) {
    if (KOKORO_SYMBOLS.has(c)) { out += c; continue; }
    const parts = [...c.normalize('NFD')];
    if (parts.length > 1 && parts.every((p) => KOKORO_SYMBOLS.has(p))) { out += parts.join(''); continue; }
    if (!dropped.has(c)) {
      dropped.add(c);
      log(`speech: Kokoro has no symbol for "${c}" (U+${c.codePointAt(0)!.toString(16).toUpperCase().padStart(4, '0')}); it is left out.`);
    }
  }
  return out;
}

/** Forget which symbols were logged (for tests). */
export function resetDropped(): void {
  dropped.clear();
}

/**
 * `text` in `language` as the phonemes Kokoro reads, with the marks kept.
 * Empty when there is nothing to say.
 */
export function phonemize(text: string, language: Exclude<KokoroLanguage, 'en'>, espeak: EspeakLike, log?: (line: string) => void): string {
  const voice = ESPEAK_VOICE[language];
  const clean = text.replace(/[‘’]/g, "'").replace(/\s+/g, ' ');
  let out = '';
  for (const part of clean.split(CUT)) {
    if (part === '') continue;
    if (IS_MARKS.test(part)) { out += kokoroMarks(part); continue; }
    const words = part.trim();
    const lead = part !== part.trimStart() ? ' ' : '';
    const trail = part !== part.trimEnd() ? ' ' : '';
    const said = words ? fromEspeak(espeak.raw(words, voice)) : '';
    out += said ? `${lead}${said}${trail}` : lead || trail;
  }
  return kokoroOnly(out.replace(/\s+/g, ' ').trim(), log);
}
