/**
 * The owner's currency, before they have said one.
 *
 * buddi knows the owner's time zone (and, when they set one, the language they
 * are answered in), not their country. A zone is a fair guess at where the
 * money lives: America/New_York banks in dollars, Europe/London in pounds. The
 * guess is written down the first time anything is recorded
 * (`recordCurrency`), so moving to another zone later never flips the
 * currency under amounts already kept; the owner (or the CFO's
 * `finance.set_preferences`) changes it outright.
 */

/** When nothing else says: the euro. */
export const FALLBACK_CURRENCY = 'EUR';

/** Whole regions, by the zone's first part. */
const BY_REGION: Record<string, string> = {
  America: 'USD',
  Europe: 'EUR',
  Australia: 'AUD',
};

/** Zones whose region would guess wrong. */
const BY_ZONE: Record<string, string> = {
  'Europe/London': 'GBP',
  'Europe/Belfast': 'GBP',
  'Europe/Guernsey': 'GBP',
  'Europe/Jersey': 'GBP',
  'Europe/Isle_of_Man': 'GBP',
  'Europe/Zurich': 'CHF',
  'Europe/Vaduz': 'CHF',
  'Europe/Oslo': 'NOK',
  'Europe/Stockholm': 'SEK',
  'Europe/Copenhagen': 'DKK',
  'Europe/Warsaw': 'PLN',
  'Europe/Prague': 'CZK',
  'Europe/Budapest': 'HUF',
  'Europe/Bucharest': 'RON',
  'Europe/Istanbul': 'TRY',
  'Europe/Moscow': 'RUB',
  'Europe/Kiev': 'UAH',
  'Europe/Kyiv': 'UAH',
  'America/Toronto': 'CAD',
  'America/Vancouver': 'CAD',
  'America/Edmonton': 'CAD',
  'America/Winnipeg': 'CAD',
  'America/Halifax': 'CAD',
  'America/St_Johns': 'CAD',
  'America/Regina': 'CAD',
  'America/Mexico_City': 'MXN',
  'America/Monterrey': 'MXN',
  'America/Tijuana': 'MXN',
  'America/Cancun': 'MXN',
  'America/Sao_Paulo': 'BRL',
  'America/Argentina/Buenos_Aires': 'ARS',
  'America/Buenos_Aires': 'ARS',
  'America/Bogota': 'COP',
  'America/Santiago': 'CLP',
  'America/Lima': 'PEN',
  'Asia/Tokyo': 'JPY',
  'Asia/Seoul': 'KRW',
  'Asia/Shanghai': 'CNY',
  'Asia/Hong_Kong': 'HKD',
  'Asia/Singapore': 'SGD',
  'Asia/Kolkata': 'INR',
  'Asia/Calcutta': 'INR',
  'Asia/Dubai': 'AED',
  'Asia/Jerusalem': 'ILS',
  'Asia/Tel_Aviv': 'ILS',
  'Asia/Bangkok': 'THB',
  'Asia/Taipei': 'TWD',
  'Pacific/Auckland': 'NZD',
  'Africa/Johannesburg': 'ZAR',
  'Africa/Lagos': 'NGN',
  'Africa/Nairobi': 'KES',
  'Africa/Casablanca': 'MAD',
};

/** A language tag's region, when the zone says nothing useful ("en-GB", "pt-BR"). */
const BY_COUNTRY: Record<string, string> = {
  US: 'USD', CA: 'CAD', MX: 'MXN', BR: 'BRL', AR: 'ARS', GB: 'GBP', IE: 'EUR', FR: 'EUR', DE: 'EUR', ES: 'EUR',
  IT: 'EUR', PT: 'EUR', NL: 'EUR', BE: 'EUR', AT: 'EUR', FI: 'EUR', GR: 'EUR', CH: 'CHF', NO: 'NOK', SE: 'SEK',
  DK: 'DKK', PL: 'PLN', CZ: 'CZK', JP: 'JPY', KR: 'KRW', CN: 'CNY', HK: 'HKD', SG: 'SGD', IN: 'INR', AU: 'AUD',
  NZ: 'NZD', ZA: 'ZAR', AE: 'AED', IL: 'ILS',
};

/** The currency a zone suggests, or undefined when it suggests none (UTC, Etc/…, an unknown region). */
export function currencyForZone(zone: string | undefined): string | undefined {
  if (!zone) return undefined;
  const exact = BY_ZONE[zone];
  if (exact) return exact;
  const region = zone.split('/')[0] ?? '';
  return BY_REGION[region];
}

/** The currency a language tag's region suggests: "en-US" → USD; "fr" → undefined. */
export function currencyForLanguage(tag: string | undefined): string | undefined {
  const region = tag?.split(/[-_]/)[1]?.toUpperCase();
  return region ? BY_COUNTRY[region] : undefined;
}

/** What the owner's zone, then their language, suggest; the euro when neither does. */
export function derivedCurrency(zone: string | undefined, language?: string): string {
  return currencyForZone(zone) ?? currencyForLanguage(language) ?? FALLBACK_CURRENCY;
}

/** The currencies the first-run sheet offers: every one a guess can land on, most common first. */
export const CURRENCY_CHOICES: readonly string[] = [
  'USD', 'EUR', 'GBP', 'CHF', 'CAD', 'AUD', 'JPY',
  ...[...new Set([...Object.values(BY_ZONE), ...Object.values(BY_COUNTRY)])]
    .filter((c) => !['USD', 'EUR', 'GBP', 'CHF', 'CAD', 'AUD', 'JPY'].includes(c))
    .sort(),
];
