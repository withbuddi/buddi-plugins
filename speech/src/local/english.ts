/**
 * Is this text English? A Kokoro English voice reads English only, so a reply
 * in a language Kokoro has no voice for is refused (`not-english`) rather
 * than read as nonsense; one it has a voice for goes to that voice first
 * (`guessLanguage`, below, and `kokoroVoiceForText`).
 *
 * No language model: the script (letters outside Latin), accented letters,
 * and which common short words it uses. When the text is too short to tell,
 * the owner's language hint decides.
 */
const ENGLISH = new Set(['the', 'and', 'is', 'are', 'you', 'to', 'of', 'it', 'that', 'this', 'with', 'for', 'have', 'was', 'not', 'what', 'your', 'on', 'in', 'be', 'can', 'will', 'i', 'we', 'they', 'at', 'from', 'or', 'but', 'do', 'there', 'about', 'just', 'here', 'my', 'me', 'a']);
const OTHER = new Set([
  // French
  'le', 'la', 'les', 'et', 'est', 'des', 'une', 'un', 'du', 'que', 'pour', 'pas', 'vous', 'je', 'nous', 'avec', 'dans', 'sur', 'ce', 'il', 'elle', 'qui', 'mais', 'ou', 'au', 'aux', 'sont', 'suis', 'très', 'oui', 'bonjour', 'merci',
  // Spanish, Portuguese, Italian
  'el', 'los', 'las', 'y', 'es', 'por', 'con', 'para', 'una', 'lo', 'se', 'del', 'como', 'más', 'pero', 'sí', 'hola', 'gracias', 'não', 'são', 'uma', 'com', 'os', 'di', 'il', 'che', 'non', 'sono', 'per', 'gli', 'della', 'ciao', 'grazie',
  // German, Dutch
  'der', 'die', 'das', 'und', 'ist', 'nicht', 'ich', 'sie', 'mit', 'ein', 'eine', 'zu', 'den', 'auf', 'für', 'auch', 'danke', 'het', 'een', 'en', 'niet', 'ik', 'van', 'dat', 'wat',
]);

export function isProbablyEnglish(text: string, hint?: string): boolean {
  const letters = text.match(/\p{L}/gu) ?? [];
  if (letters.length === 0) return true;
  const latin = letters.filter((c) => /\p{Script=Latin}/u.test(c));
  if (latin.length / letters.length < 0.8) return false;
  const accented = latin.filter((c) => /[^a-zA-Z]/.test(c)).length;
  const words = text.toLowerCase().match(/\p{L}+/gu) ?? [];
  let english = 0;
  let other = 0;
  for (const w of words) {
    if (ENGLISH.has(w)) english += 1;
    if (OTHER.has(w)) other += 1;
  }
  if (words.length < 4 && english + other < 2) return !hint || hint === 'en';
  if (accented / latin.length > 0.03 && other >= english) return false;
  return english >= other;
}

/**
 * Which language a reply is in, among the ones buddi can tell apart without
 * a model: the script first (Devanagari is Hindi, kana Japanese, Han
 * Chinese…), then, for Latin text, common short words and letters only one
 * language uses (ñ, ã, ê…). Undefined when it cannot say: too short, or two
 * languages too close to call.
 */
const WORDS: Record<string, readonly string[]> = {
  en: [...ENGLISH],
  fr: ['le', 'la', 'les', 'et', 'est', 'des', 'une', 'un', 'du', 'que', 'pour', 'pas', 'vous', 'je', 'nous', 'avec', 'dans', 'sur', 'ce', 'il', 'elle', 'qui', 'mais', 'ou', 'au', 'aux', 'sont', 'suis', 'très', 'oui', 'bonjour', 'merci', 'votre', 'mon', 'ma', 'mes', 'ne', 'à', 'été', 'être', 'cette', "c'est", "j'ai", "n'est", "d'un", "l'on"],
  es: ['el', 'los', 'las', 'y', 'es', 'por', 'con', 'para', 'una', 'lo', 'del', 'como', 'más', 'pero', 'sí', 'hola', 'gracias', 'muy', 'yo', 'usted', 'hoy', 'qué', 'cómo', 'tu', 'su', 'hay', 'soy', 'está', 'estoy', 'bien', 'también', 'ahora', 'al', 'mi'],
  it: ['il', 'di', 'che', 'non', 'sono', 'per', 'gli', 'della', 'ciao', 'grazie', 'è', 'un', 'una', 'ho', 'mi', 'ti', 'con', 'del', 'alle', 'nel', 'anche', 'questo', 'molto', 'io', 'lei', 'buongiorno', 'oggi', 'ci', 'le', 'la', 'si'],
  pt: ['não', 'são', 'uma', 'com', 'os', 'as', 'você', 'é', 'do', 'da', 'em', 'no', 'na', 'ao', 'às', 'eu', 'olá', 'obrigado', 'obrigada', 'muito', 'hoje', 'está', 'estou', 'bem', 'também', 'agora', 'meu', 'minha', 'seu', 'sua', 'um', 'que', 'para', 'por'],
  de: ['der', 'die', 'das', 'und', 'ist', 'nicht', 'ich', 'sie', 'mit', 'ein', 'eine', 'zu', 'den', 'auf', 'für', 'auch', 'danke', 'wir', 'es', 'sind', 'heute'],
  nl: ['het', 'een', 'en', 'niet', 'ik', 'van', 'dat', 'wat', 'je', 'is', 'zijn', 'met', 'voor', 'op', 'dank', 'vandaag'],
};
/** Letters that point at one language. */
const LETTERS: ReadonlyArray<readonly [RegExp, string]> = [
  [/[ñ¿¡]/giu, 'es'],
  [/[ãõ]/giu, 'pt'],
  [/[êâôîûëïœ]/giu, 'fr'],
  [/[äöüß]/giu, 'de'],
  [/[ìò]/giu, 'it'],
];
const SCRIPTS: ReadonlyArray<readonly [RegExp, string]> = [
  [/\p{Script=Devanagari}/u, 'hi'],
  [/[\p{Script=Hiragana}\p{Script=Katakana}]/u, 'ja'],
  [/\p{Script=Hangul}/u, 'ko'],
  [/\p{Script=Han}/u, 'zh'],
  [/\p{Script=Cyrillic}/u, 'ru'],
  [/\p{Script=Arabic}/u, 'ar'],
  [/\p{Script=Greek}/u, 'el'],
  [/\p{Script=Hebrew}/u, 'he'],
  [/\p{Script=Thai}/u, 'th'],
];

export function guessLanguage(text: string): string | undefined {
  const letters = text.match(/\p{L}/gu) ?? [];
  if (letters.length === 0) return undefined;
  const latin = letters.filter((c) => /\p{Script=Latin}/u.test(c)).length;
  if (latin / letters.length < 0.5) {
    for (const [script, code] of SCRIPTS) if (script.test(text)) return code;
    return undefined;
  }
  const words = text.toLowerCase().replace(/’/g, "'").match(/[\p{L}']+/gu) ?? [];
  const score = new Map<string, number>();
  for (const [code, list] of Object.entries(WORDS)) {
    const set = new Set(list);
    score.set(code, words.filter((w) => set.has(w)).length);
  }
  for (const [re, code] of LETTERS) score.set(code, (score.get(code) ?? 0) + (text.match(re)?.length ?? 0));
  const ranked = [...score].sort((a, b) => b[1] - a[1]);
  const [first, second] = ranked;
  if (!first || first[1] < 2) return undefined;
  if (second && first[1] - second[1] < 1) return undefined;
  return first[0];
}
