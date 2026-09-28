/** Text for the ear: each rule of `spokenText`. */
import { describe, expect, it } from 'vitest';
import { spokenText } from './spoken.js';

const now = new Date('2026-09-27T12:00:00Z');
const say = (text: string, handles?: Record<string, string>) => spokenText(text, { now, ...(handles ? { handles } : {}) });

describe('spokenText', () => {
  it('drops emphasis, inline code, headings and quotes', () => {
    expect(say('**Groceries** were _high_ this month, see `ledger`.')).toBe('Groceries were high this month, see ledger.');
    expect(say('## Summary\nAll paid')).toBe('Summary. All paid.');
    expect(say('> Pay the rent\n> on Friday')).toBe('Pay the rent on Friday.');
    expect(say('snake_case stays a word')).toBe('snake case stays a word.');
  });

  it('makes each bullet its own sentence', () => {
    expect(say('Three things:\n- rent\n* power bill\n1. water')).toBe('Three things: rent. power bill. water.');
    expect(say('- Done!\n- Next?')).toBe('Done! Next?');
  });

  it('reads a link as its label and a bare URL as its site', () => {
    expect(say('See [the invoice](https://example.com/inv/42).')).toBe('See the invoice.');
    expect(say('It is at https://www.buddi.com/docs/speech, look.')).toBe('It is at buddi.com, look.');
    expect(say('Open <https://withbuddi.com/x>')).toBe('Open withbuddi.com.');
  });

  it('reads a table as one sentence per row', () => {
    const table = '| Item | Amount |\n|---|---:|\n| Rent | 900 |\n| Power | 60 |';
    expect(say(table)).toBe('Item, Amount. Rent, 900. Power, 60.');
  });

  it('replaces a code block', () => {
    expect(say('Run this:\n```sh\nbuddi speech install\n```\nThen restart.')).toBe('Run this: A code block. Then restart.');
  });

  it('reads handles as names when known, else as the bare word, and leaves emails alone', () => {
    expect(say('Ask @ledger or @buddi.', { ledger: 'Ledger the accountant' })).toBe('Ask Ledger the accountant or buddi.');
    expect(say('Ask @Ledger.', { '@ledger': 'Ledger' })).toBe('Ask Ledger.');
    expect(say('Ask @ledger.')).toBe('Ask ledger.');
    expect(say('Mail sam@example.com')).toBe('Mail sam@example.com.');
  });

  it('reads ISO dates as words, without this year, and keeps times', () => {
    expect(say('Due 2026-09-27 at 10:53.')).toBe('Due September 27 at 10:53.');
    expect(say('Opened 2025-01-03.')).toBe('Opened January 3, 2025.');
    expect(say('At 2026-10-01T09:30:00Z.')).toBe('At October 1 at 09:30.');
    expect(say('Not a date: 2026-13-40.')).toBe('Not a date: 2026-13-40.');
  });

  it('reads amounts with a currency as words', () => {
    expect(say('It cost 40 USD.')).toBe('It cost 40 dollars.');
    expect(say('It cost USD 40.')).toBe('It cost 40 dollars.');
    expect(say('It cost $40.')).toBe('It cost 40 dollars.');
    expect(say('Balance: -6626.35 USD.')).toBe('Balance: minus 6,626 dollars and 35 cents.');
    expect(say('Balance: -$6,626.35')).toBe('Balance: minus 6,626 dollars and 35 cents.');
    expect(say('Just $1.01')).toBe('Just 1 dollar and 1 cent.');
    expect(say('€12.50 for lunch')).toBe('12 euros and 50 cents for lunch.');
  });

  it('reads plain decimals with "point", percentages in words, and leaves grouped integers and versions', () => {
    expect(say('The ratio is 6626.35 now.')).toBe('The ratio is 6626 point 35 now.');
    expect(say('Down -2.5 today')).toBe('Down minus 2 point 5 today.');
    expect(say('Savings rate 72%.')).toBe('Savings rate 72 percent.');
    expect(say('Telegram takes 1,024 characters.')).toBe('Telegram takes 1,024 characters.');
    expect(say('buddi 0.1.0 is out.')).toBe('buddi 0.1.0 is out.');
  });

  it('removes emoji and reads symbols as words', () => {
    expect(say('Paid ✅ 🎉 rent & power')).toBe('Paid rent and power.');
    expect(say('Paris → London')).toBe('Paris to London.');
    expect(say('Keep it ≤ 3 lines')).toBe('Keep it at most 3 lines.');
    expect(say('It is 20°C outside, 70° inside')).toBe('It is 20 degrees Celsius outside, 70 degrees inside.');
    expect(say('👍🏽 🇫🇷')).toBe('👍🏽 🇫🇷');
  });

  it('normalises whitespace and never comes back empty', () => {
    expect(say('  Hello   there.\n\n\nBye  ')).toBe('Hello there. Bye.');
    expect(say('🎉')).toBe('🎉');
    expect(say('***')).toBe('***');
  });
});
