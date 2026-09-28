/**
 * Account kinds and the totals they split into. Pure — no DB, no clock.
 *
 * The rule the whole plugin turns on: an account's balance always counts
 * toward net worth, but only an account with `includeInCashflow` is money the
 * owner can spend. A 401k is not a bigger budget.
 */
import { daysBetween } from './projection.js';


export const ACCOUNT_KINDS = [
  'cash',
  'savings',
  'retirement',
  'investment',
  'hsa',
  'other',
] as const;

export type AccountKind = (typeof ACCOUNT_KINDS)[number];

/**
 * Kinds whose money is locked away, penalised on withdrawal or earmarked, so
 * they default to being left out of the cash flow. Savings and reserve pots
 * are deliberately NOT here: they are liquid, the owner can move them today.
 */
export const NON_CASHFLOW_KINDS: readonly AccountKind[] = ['retirement', 'investment', 'hsa'];

/** What `includeInCashflow` should be for a newly created account of this kind. */
export function defaultIncludeInCashflow(kind: AccountKind): boolean {
  return !NON_CASHFLOW_KINDS.includes(kind);
}

/**
 * How old a recorded balance may be before the model is told it is cold.
 *
 * Seven days, and deliberately shorter than the fortnight the stale-balance
 * sentinel nags about: the sentinel is a message the owner reads, so it waits
 * until the silence is embarrassing, while this flag is read by the agent on
 * every question about money. An advisor quoting a balance nobody has
 * confirmed in a week should say so in the same breath, or go and look.
 */
export const BALANCE_FRESH_DAYS = 7;

/** Is a balance recorded on `asOf` too old to quote without a caveat? */
export function balanceIsStale(asOf: string, today: string, maxAgeDays = BALANCE_FRESH_DAYS): boolean {
  return daysBetween(asOf, today) > maxAgeDays;
}

export interface AccountBalance {
  name: string;
  balance: number;
  kind: AccountKind;
  includeInCashflow: boolean;
}

export interface ExcludedKindTotal {
  kind: AccountKind;
  balance: number;
  accounts: string[];
}

export interface SplitTotals {
  /** Spendable money: every account with includeInCashflow. */
  cashTotal: number;
  /** Everything else, summed — real money, just not available to spend. */
  excludedTotal: number;
  /** The excluded money broken down by kind, largest first. */
  excludedByKind: ExcludedKindTotal[];
  /** cashTotal + excludedTotal − liabilities. */
  netWorth: number;
}

function round2(n: number): number {
  return Math.round(n * 100) / 100;
}

/**
 * Split account balances into spendable cash and held-but-not-spendable money,
 * and net the debts out of the sum of both.
 */
export function splitTotals(
  accounts: readonly AccountBalance[],
  totalLiabilities = 0,
): SplitTotals {
  let cashTotal = 0;
  let excludedTotal = 0;
  const byKind = new Map<AccountKind, { balance: number; accounts: string[] }>();

  for (const account of accounts) {
    if (account.includeInCashflow) {
      cashTotal += account.balance;
      continue;
    }
    excludedTotal += account.balance;
    const entry = byKind.get(account.kind) ?? { balance: 0, accounts: [] };
    entry.balance += account.balance;
    entry.accounts.push(account.name);
    byKind.set(account.kind, entry);
  }

  cashTotal = round2(cashTotal);
  excludedTotal = round2(excludedTotal);

  const excludedByKind: ExcludedKindTotal[] = [...byKind.entries()]
    .map(([kind, entry]) => ({
      kind,
      balance: round2(entry.balance),
      accounts: entry.accounts,
    }))
    .sort((a, b) => b.balance - a.balance || (a.kind < b.kind ? -1 : 1));

  return {
    cashTotal,
    excludedTotal,
    excludedByKind,
    netWorth: round2(cashTotal + excludedTotal - totalLiabilities),
  };
}
