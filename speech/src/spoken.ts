/**
 * Text for the ear: what a reply says, rewritten so a voice reads it as a
 * person would, before any backend synthesizes it (`speech.say`, and the
 * Telegram voice-out path, which calls it).
 *
 * Markdown goes (a bullet, a heading, a table row each become a sentence),
 * links are read as their label or their site, handles as names, dates and
 * amounts as words, emoji and most symbols vanish. Plain numbers stay digits:
 * every voice reads those well. The result is never empty: when nothing
 * would be left, the original is said.
 */

export interface SpokenOptions {
  /** Agent handle → display name, `ledger` or `@ledger` → "Ledger". */
  handles?: Record<string, string>;
  /** Today, for leaving out this year in a date. Defaults to now. */
  now?: Date;
}

const MONTHS = [
  'January', 'February', 'March', 'April', 'May', 'June',
  'July', 'August', 'September', 'October', 'November', 'December',
];

interface Currency {
  one: string;
  many: string;
  cent: string;
  cents: string;
}

const DOLLAR: Currency = { one: 'dollar', many: 'dollars', cent: 'cent', cents: 'cents' };
const EURO: Currency = { one: 'euro', many: 'euros', cent: 'cent', cents: 'cents' };
const POUND: Currency = { one: 'pound', many: 'pounds', cent: 'penny', cents: 'pence' };

const BY_SYMBOL: Record<string, Currency> = { $: DOLLAR, '€': EURO, '£': POUND };
const BY_CODE: Record<string, Currency> = { USD: DOLLAR, EUR: EURO, GBP: POUND };

/** An amount: digits with optional thousands commas and optional decimals. */
const AMOUNT = String.raw`\d{1,3}(?:,\d{3})+(?:\.\d+)?|\d+(?:\.\d+)?`;
const MINUS = String.raw`[-−]`;

/** "minus 6,626 dollars and 35 cents". */
function sayAmount(sign: string | undefined, amount: string, currency: Currency): string {
  const [whole = '0', fraction] = amount.replace(/,/g, '').split('.');
  const units = Number(whole);
  const cents = fraction ? Math.round(Number(`0.${fraction}`) * 100) : 0;
  const parts: string[] = [];
  if (units !== 0 || cents === 0) parts.push(`${units.toLocaleString('en-US')} ${units === 1 ? currency.one : currency.many}`);
  if (cents !== 0) parts.push(`${cents} ${cents === 1 ? currency.cent : currency.cents}`);
  return `${sign ? 'minus ' : ''}${parts.join(' and ')}`;
}

/** A site's name from a URL: "buddi.com", or "a link" when it has none. */
function siteOf(url: string): string {
  try {
    const host = new URL(/^[a-z][a-z0-9+.-]*:\/\//i.test(url) ? url : `https://${url}`).hostname.replace(/^www\./, '');
    return host || 'a link';
  } catch {
    return 'a link';
  }
}

/** Ends a sentence that has no end of its own. */
function closed(sentence: string): string {
  const s = sentence.trim();
  if (s === '') return '';
  return /[.!?…:;]$/.test(s) ? s : `${s}.`;
}

const TABLE_RULE = /^\|?\s*:?-{2,}:?\s*(\|\s*:?-{2,}:?\s*)*\|?$/;
const LIST_MARKER = /^(?:[-*+•·]|\d{1,3}[.)])\s+/;

/** Block structure: code, tables, headings, quotes, lists, paragraphs, each into sentences. */
function blocks(text: string): string {
  const withoutCode = text.replace(/```[\s\S]*?(?:```|$)/g, '\n\nA code block.\n\n');
  const out: string[] = [];
  let paragraph: string[] = [];
  const flush = () => {
    if (paragraph.length > 0) out.push(closed(paragraph.join(' ')));
    paragraph = [];
  };
  for (const raw of withoutCode.split(/\r?\n/)) {
    let line = raw.trim();
    // Quotes, nested or not, are read as what they quote.
    while (line.startsWith('>')) line = line.slice(1).trim();
    if (line === '') {
      flush();
      continue;
    }
    if (/^(?:-{3,}|\*{3,}|_{3,})$/.test(line)) {
      flush();
      continue;
    }
    if (line.startsWith('|') || (line.includes('|') && TABLE_RULE.test(line))) {
      flush();
      if (TABLE_RULE.test(line)) continue;
      const cells = line.replace(/^\|/, '').replace(/\|$/, '').split('|').map((c) => c.trim()).filter((c) => c !== '');
      out.push(closed(cells.join(', ')));
      continue;
    }
    const heading = /^#{1,6}\s+(.*?)\s*#*$/.exec(line);
    if (heading) {
      flush();
      out.push(closed(heading[1]!));
      continue;
    }
    if (LIST_MARKER.test(line)) {
      flush();
      out.push(closed(line.replace(LIST_MARKER, '').replace(/^\[[ xX]\]\s+/, '')));
      continue;
    }
    paragraph.push(line);
  }
  flush();
  return out.join(' ');
}

/** Links, inline code and emphasis. */
function inline(text: string): string {
  return text
    // Images and links: their words.
    .replace(/!\[([^\]]*)\]\([^)]*\)/g, '$1')
    .replace(/\[([^\]]+)\]\(([^)\s]*)[^)]*\)/g, (_m, label: string, url: string) => (label.trim() === url.trim() ? siteOf(url) : label))
    .replace(/<((?:https?:\/\/)[^>\s]+)>/g, (_m, url: string) => siteOf(url))
    // Bare URLs: their site.
    .replace(/\b(?:https?:\/\/|www\.)[^\s<>()]+/gi, (match) => {
      const url = match.replace(/[.,;:!?'"]+$/, '');
      return siteOf(url) + match.slice(url.length);
    })
    .replace(/`([^`]*)`/g, '$1')
    .replace(/\*\*|__/g, '')
    .replace(/(^|[^\p{L}\p{N}])[*_]([^*_\n]+?)[*_](?=[^\p{L}\p{N}]|$)/gu, '$1$2')
    .replace(/~~/g, '');
}

/** `@ledger` → its name when known, else the bare word. An email is left alone. */
function handles(text: string, names: Record<string, string> | undefined): string {
  const lookup = new Map<string, string>();
  for (const [key, name] of Object.entries(names ?? {})) {
    if (name.trim()) lookup.set(key.replace(/^@/, '').toLowerCase(), name.trim());
  }
  return text.replace(/(^|[^\p{L}\p{N}_.@])@([A-Za-z0-9_][A-Za-z0-9_-]*)/gu, (_m, before: string, handle: string) =>
    `${before}${lookup.get(handle.toLowerCase()) ?? handle}`);
}

/** ISO dates as words; this year's without the year. */
function dates(text: string, now: Date): string {
  const thisYear = now.getFullYear();
  return text.replace(
    /\b(\d{4})-(\d{2})-(\d{2})(?:[T ](\d{2}:\d{2})(?::\d{2}(?:\.\d+)?)?(?:Z|[+-]\d{2}:?\d{2})?)?\b/g,
    (match, y: string, m: string, d: string, time: string | undefined) => {
      const year = Number(y);
      const month = Number(m);
      const day = Number(d);
      if (month < 1 || month > 12 || day < 1 || day > 31) return match;
      const date = `${MONTHS[month - 1]} ${day}${year === thisYear ? '' : `, ${year}`}`;
      return time ? `${date} at ${time}` : date;
    },
  );
}

/** Amounts with a currency as words; other decimals as "6626 point 35"; percentages. */
function numbers(text: string): string {
  const notDigitBefore = String.raw`(?<![\p{L}\p{N}.,])`;
  const notDigitAfter = String.raw`(?![\p{N}]|[.,]\p{N})`;
  const symbol = String.raw`([$€£])`;
  const code = String.raw`(USD|EUR|GBP)`;
  return text
    // -$40, $-40, $40
    .replace(new RegExp(`${notDigitBefore}(${MINUS})?${symbol}\\s?(${MINUS})?(${AMOUNT})${notDigitAfter}`, 'gu'),
      (_m, s1: string | undefined, sym: string, s2: string | undefined, amount: string) => sayAmount(s1 ?? s2, amount, BY_SYMBOL[sym]!))
    // USD 40, USD -40
    .replace(new RegExp(`\\b${code}\\s?(${MINUS})?(${AMOUNT})${notDigitAfter}`, 'gu'),
      (_m, c: string, sign: string | undefined, amount: string) => sayAmount(sign, amount, BY_CODE[c]!))
    // 40 USD, -6626.35 USD, 40 €
    .replace(new RegExp(`${notDigitBefore}(${MINUS})?(${AMOUNT})\\s?(?:${code}\\b|${symbol})`, 'gu'),
      (_m, sign: string | undefined, amount: string, c: string | undefined, sym: string | undefined) =>
        sayAmount(sign, amount, c ? BY_CODE[c]! : BY_SYMBOL[sym!]!))
    // A plain decimal: "6626 point 35"; a version (0.1.0) is left alone.
    .replace(new RegExp(`${notDigitBefore}(${MINUS})?(\\d{1,3}(?:,\\d{3})+|\\d+)\\.(\\d+)${notDigitAfter}`, 'gu'),
      (_m, sign: string | undefined, whole: string, fraction: string) => `${sign ? 'minus ' : ''}${whole} point ${fraction}`)
    .replace(/(\d)\s?%/g, '$1 percent');
}

/** Symbols as words, and the rest of them gone. */
function symbols(text: string): string {
  return text
    .replace(/\s*(?:→|⟶|->|=>)\s*/g, ' to ')
    .replace(/\s*&\s*/g, ' and ')
    .replace(/\s*(?:≤|<=)\s*/g, ' at most ')
    .replace(/\s*(?:≥|>=)\s*/g, ' at least ')
    .replace(/°\s?C\b/g, ' degrees Celsius')
    .replace(/°\s?F\b/g, ' degrees Fahrenheit')
    .replace(/\s*°/g, ' degrees')
    // Emoji, with their joiners, variation selectors, skin tones and flags.
    .replace(/[\p{Extended_Pictographic}\u{1F1E6}-\u{1F1FF}\u{1F3FB}-\u{1F3FF}‍︎️⃣]/gu, '')
    .replace(/[*#|~^<>`=_\\]/g, ' ')
    // Arrows and marks that are not emoji.
    .replace(/[←↑↓↔⇒⇐•·▪►▶◀✓✔✗✘]/g, ' ');
}

/** Spaces once, none before a stop, sentences ending cleanly. */
function tidy(text: string): string {
  return text
    .replace(/\s+/g, ' ')
    .replace(/\s+([.,;:!?])/g, '$1')
    .replace(/([.!?])(?:\s*[.])+/g, '$1')
    .replace(/,(?:\s*,)+/g, ',')
    .replace(/\(\s*\)/g, '')
    .replace(/^[\s.,;:]+/, '')
    .trim();
}

/** The text a voice reads: see the file comment. Never empty. */
export function spokenText(text: string, opts: SpokenOptions = {}): string {
  const now = opts.now ?? new Date();
  let out = blocks(text);
  out = inline(out);
  out = handles(out, opts.handles);
  out = dates(out, now);
  out = numbers(out);
  out = symbols(out);
  out = tidy(out);
  return /[\p{L}\p{N}]/u.test(out) ? out : text;
}
