/**
 * A balance is a reading, and a reading has an age.
 *
 * The advisor read a live bank balance, answered from it, and recorded only
 * the transaction; the conversation rolled over after the browser session and
 * the next answer came from a ledger a fortnight old. Two halves of the fix
 * are testable without a database: `list_accounts` says out loud which numbers
 * have gone cold, and the projection names the oldest balance it rests on.
 */
import { describe, expect, it } from 'vitest';
import { createPluginHost, hostBindingOf } from '@buddi/core/testing';
import { manifest } from '../index.js';
import { BALANCE_FRESH_DAYS, balanceIsStale } from '../accounts.js';
import { financeSkills } from '../skills.js';
import { listAccounts, setBalance } from './accounts.js';
import { projectCashflow } from './cashflow.js';

const TODAY = new Date('2026-09-21T09:00:00Z');

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

const account = (name: string, asOf: string) => ({
  id: name, name, balance: 1200, balance_as_of: asOf, kind: 'cash',
  include_in_cashflow: true, institution: 'Example Bank', notes: null,
});

describe('a balance that has gone cold', () => {
  it('is stale after a week, and not a day before', () => {
    expect(BALANCE_FRESH_DAYS).toBe(7);
    expect(balanceIsStale('2026-09-14', '2026-09-21')).toBe(false);
    expect(balanceIsStale('2026-09-13', '2026-09-21')).toBe(true);
    expect(balanceIsStale('2026-09-21', '2026-09-21')).toBe(false);
  });

  it('is marked on the row list_accounts returns, with its age', async () => {
    const result = await listAccounts.execute(
      {},
      ctx({ 'from finance\\.accounts': [account('Checking', '2026-09-20'), account('Savings', '2026-09-01')] }),
    ) as { accounts: Array<{ name: string; stale?: true; balanceAgeDays: number }> };
    const [checking, savings] = result.accounts;
    expect(checking!.stale).toBeUndefined();
    expect(checking!.balanceAgeDays).toBe(1);
    expect(savings!.stale).toBe(true);
    expect(savings!.balanceAgeDays).toBe(20);
  });

  it('is the reason the tools tell the model to go and read the real one', () => {
    expect(listAccounts.description).toContain('stale: true');
    expect(listAccounts.description).toContain('finance.set_balance');
  });
});

describe('the projection', () => {
  it('names the oldest as-of date it started from, and that it is cold', async () => {
    const result = await projectCashflow.execute(
      { horizonDays: 30, includeBaseline: false, includePending: false },
      ctx({ 'min\\(balance_as_of\\)': [{ total: 2400, n: 2, oldest: '2026-09-01' }] }),
    ) as { oldestBalanceAsOf: string | null; startBalanceAgeDays: number | null; startBalanceStale: boolean };
    expect(result.oldestBalanceAsOf).toBe('2026-09-01');
    expect(result.startBalanceAgeDays).toBe(20);
    expect(result.startBalanceStale).toBe(true);
  });

  it('says nothing about an as-of date when no account has one', async () => {
    const result = await projectCashflow.execute(
      { horizonDays: 30, includeBaseline: false, includePending: false },
      ctx({}),
    ) as { oldestBalanceAsOf: string | null; startBalanceStale: boolean };
    expect(result.oldestBalanceAsOf).toBeNull();
    expect(result.startBalanceStale).toBe(false);
  });
});

describe('what set_balance is for', () => {
  it('tells the advisor to record what it observed, before answering', () => {
    expect(setBalance.description).toContain('RECORD WHAT YOU OBSERVE');
    expect(setBalance.description).toMatch(/browser/);
    expect(setBalance.description).toMatch(/NEVER recorded here/);
  });

  it('ships the same rule as a procedure the owner can accept', () => {
    const skill = financeSkills.find((s) => s.name === 'an-observed-balance-is-recorded');
    expect(skill).toBeDefined();
    expect(skill!.body).toContain('finance.set_balance');
    // Observations in; arithmetic out.
    expect(skill!.body).toMatch(/computed/);
  });
});
