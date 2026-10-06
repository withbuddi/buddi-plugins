import { describe, expect, it } from 'vitest';
import { CURRENCY_CHOICES, currencyForLanguage, currencyForZone, derivedCurrency } from './currency.js';

describe('the currency a zone suggests', () => {
  it('reads the region, and the zones a region would get wrong', () => {
    expect(currencyForZone('America/New_York')).toBe('USD');
    expect(currencyForZone('America/Los_Angeles')).toBe('USD');
    expect(currencyForZone('America/Toronto')).toBe('CAD');
    expect(currencyForZone('Europe/Paris')).toBe('EUR');
    expect(currencyForZone('Europe/London')).toBe('GBP');
    expect(currencyForZone('Europe/Zurich')).toBe('CHF');
    expect(currencyForZone('Asia/Tokyo')).toBe('JPY');
    expect(currencyForZone('Australia/Sydney')).toBe('AUD');
    expect(currencyForZone('UTC')).toBeUndefined();
    expect(currencyForZone('Asia/Ulaanbaatar')).toBeUndefined();
  });

  it('falls back to the language’s region, then the euro', () => {
    expect(currencyForLanguage('en-GB')).toBe('GBP');
    expect(currencyForLanguage('pt-BR')).toBe('BRL');
    expect(currencyForLanguage('fr')).toBeUndefined();
    expect(derivedCurrency('UTC', 'en-US')).toBe('USD');
    expect(derivedCurrency('America/Chicago', 'fr-FR')).toBe('USD'); // the zone wins
    expect(derivedCurrency(undefined)).toBe('EUR');
  });

  it('offers every currency a guess can land on, the common ones first', () => {
    expect(CURRENCY_CHOICES.slice(0, 3)).toEqual(['USD', 'EUR', 'GBP']);
    for (const zone of ['America/Sao_Paulo', 'Asia/Kolkata', 'Pacific/Auckland']) expect(CURRENCY_CHOICES).toContain(currencyForZone(zone));
    expect(new Set(CURRENCY_CHOICES).size).toBe(CURRENCY_CHOICES.length);
  });
});
