/**
 * The three numbers a goal can watch here, over the same fixtures the tools'
 * own unit tests use: a fake `db` that answers a regex with rows.
 *
 * What is worth proving without a database is exactly what a goal rests on for
 * months — the *figure* is the one the Money block shows, the currency is the
 * owner's preference, and `asOf` is the day the number is true of rather than
 * the day it was asked for. The last one is why these tests spell out dates:
 * a metric that quietly stamped `now` would draw a flat, confident line across
 * a fortnight in which nothing had been recorded at all.
 */
import { describe, expect, it } from 'vitest';
import { createPluginHost, hostBindingOf } from '@buddi/core/testing';
import { cardBalance, cashAvailable, financeMetrics, totalDebt } from './metrics.js';
import { manifest } from './index.js';

const TODAY = new Date('2026-09-21T09:00:00Z');

/** The tools' own fake context: a regex over the SQL, and the rows it answers. */
function ctx(rows: Record<string, unknown[]>): never {
  const query = async (sql: string) => {
    for (const [pattern, result] of Object.entries(rows)) {
      if (new RegExp(pattern).test(sql)) return { rows: result };
    }
    return { rows: [] };
  };
  const facts = { db: { query }, now: () => TODAY, timezone: 'UTC' } as never;
  return { ...(facts as object), buddi: createPluginHost(hostBindingOf(manifest), facts) } as never;
}

const account = (name: string, balance: number, asOf: string, includeInCashflow = true) => ({
  id: name,
  name,
  balance,
  balance_as_of: asOf,
  kind: includeInCashflow ? 'cash' : 'retirement',
  include_in_cashflow: includeInCashflow,
  institution: 'Example Bank',
  notes: null,
});

const liability = (
  name: string,
  balance: number,
  asOf: string,
  kind: 'credit_card' | 'loan' = 'credit_card',
  active = true,
) => ({
  id: `id-${name}`,
  name,
  kind,
  balance,
  credit_limit: kind === 'credit_card' ? 5000 : null,
  minimum_payment: 50,
  due_day: 12,
  apr: 24.99,
  paid_from_account_id: null,
  as_of: asOf,
  active,
  statement_day: 3,
  reported_balance: null,
  reported_on: null,
  account_name: null,
});

/** Accounts, preferences and liabilities, as the three tables the tools read. */
function books(opts: {
  accounts?: unknown[];
  liabilities?: unknown[];
  currency?: string;
}): never {
  return ctx({
    'from finance\\.accounts': opts.accounts ?? [],
    'from finance\\.preferences': [{ key: 'currency', value: opts.currency ?? 'USD' }],
    // `list_accounts` sums the debts in one statement of its own; the tool
    // that lists them selects the rows. Both are answered here.
    'coalesce\\(sum\\(balance\\), 0\\)': [
      {
        total: (opts.liabilities ?? []).reduce<number>(
          (sum, l) => sum + Number((l as { balance: number }).balance),
          0,
        ),
        n: (opts.liabilities ?? []).length,
      },
    ],
    'from finance\\.liabilities': opts.liabilities ?? [],
  });
}

describe('the metrics this plugin contributes', () => {
  it('are on the manifest, namespaced, with a direction each', () => {
    expect(manifest.metrics).toBe(financeMetrics);
    expect(financeMetrics.map((m) => m.id)).toEqual([
      'finance.total_debt',
      'finance.card_balance',
      'finance.cash_available',
    ]);
    expect(financeMetrics.every((m) => m.unit === 'currency')).toBe(true);
    expect(financeMetrics.map((m) => m.direction)).toEqual(['down', 'down', 'up']);
  });
});

describe('finance.total_debt', () => {
  it('is the sum the Money block calls "Debt", in the owner\'s currency, as of the newest statement', async () => {
    const reading = await totalDebt.measure(
      {},
      books({
        currency: 'EUR',
        liabilities: [
          liability('Rewards Card', 2400, '2026-09-01'),
          liability('Car loan', 11000, '2026-09-12', 'loan'),
        ],
      }),
    );
    expect(reading).toMatchObject({ value: 13400, currency: 'EUR' });
    // The newest as-of of the debts it summed — not today, which is the 21st.
    expect(reading?.asOf.toISOString()).toBe('2026-09-12T00:00:00.000Z');
    expect(reading?.note).toContain('2 recorded debts');
  });

  it('is null when no debt is recorded — zero owed and nothing written down are not the same fact', async () => {
    expect(await totalDebt.measure({}, books({ accounts: [account('Checking', 900, '2026-09-20')] }))).toBeNull();
  });
});

describe('finance.cash_available', () => {
  it('is the spendable total, as of the newest balance it rests on', async () => {
    const reading = await cashAvailable.measure(
      {},
      books({
        accounts: [
          account('Checking', 900, '2026-09-20'),
          account('Savings', 4000, '2026-09-04'),
          account('401k', 90000, '2026-09-19', false),
        ],
      }),
    );
    // The 401k is counted in net worth and is never available money.
    expect(reading).toMatchObject({ value: 4900, currency: 'USD' });
    expect(reading?.asOf.toISOString()).toBe('2026-09-20T00:00:00.000Z');
    expect(reading?.note).toContain('2 spendable accounts');
  });

  it('is null when there is no spendable account at all', async () => {
    expect(await cashAvailable.measure({}, books({}))).toBeNull();
    expect(
      await cashAvailable.measure({}, books({ accounts: [account('401k', 90000, '2026-09-19', false)] })),
    ).toBeNull();
  });
});

describe('finance.card_balance', () => {
  const cards = books({
    liabilities: [liability('Rewards Card', 2400, '2026-09-01'), liability('Amex', 800, '2026-09-18')],
  });

  it('answers one card, by name, case-insensitively, as of the day it was stated', async () => {
    const reading = await cardBalance.measure({ account: 'amex' }, cards);
    expect(reading).toMatchObject({ value: 800, currency: 'USD' });
    expect(reading?.asOf.toISOString()).toBe('2026-09-18T00:00:00.000Z');
    expect(reading?.note).toContain('Amex');
  });

  it('answers it by id too — the way the other tools accept one', async () => {
    expect(await cardBalance.measure({ account: 'id-Amex' }, cards)).toMatchObject({ value: 800 });
  });

  it('throws naming the active cards, when the card does not exist', async () => {
    await expect(cardBalance.measure({ account: 'Barclaycard' }, cards)).rejects.toThrow(
      /no active card here is "Barclaycard".*Rewards Card, Amex/s,
    );
  });

  it('throws when no card is recorded at all', async () => {
    await expect(cardBalance.measure({ account: 'Amex' }, books({}))).rejects.toThrow(
      /no active credit card is recorded here/,
    );
  });

  it('is null for a card that was paid off and deactivated — that is the ending, not an outage', async () => {
    const paidOff = books({
      liabilities: [
        liability('Rewards Card', 2400, '2026-09-01'),
        liability('Amex', 0, '2026-09-18', 'credit_card', false),
      ],
    });
    expect(await cardBalance.measure({ account: 'Amex' }, paidOff)).toBeNull();
    // ...and the card still there is still measured.
    expect(await cardBalance.measure({ account: 'Rewards Card' }, paidOff)).toMatchObject({
      value: 2400,
    });
  });

  it('ignores a loan: a card balance is a card', async () => {
    await expect(
      cardBalance.measure(
        { account: 'Car loan' },
        books({ liabilities: [liability('Car loan', 11000, '2026-09-12', 'loan')] }),
      ),
    ).rejects.toThrow(/no active credit card is recorded here/);
  });
});
