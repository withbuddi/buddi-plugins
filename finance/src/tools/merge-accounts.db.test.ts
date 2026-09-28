/**
 * Folding a duplicate account into the one being kept.
 *
 * The failure these two tools exist for is an account recorded twice: the
 * history sits on one row and the fresh balance on the other, and every answer
 * is wrong by whichever half it happens to read. Merging has to move *every*
 * reference — not the ones we remembered to list — carry the newer balance
 * across, and leave nothing behind; removing has to refuse the moment anything
 * still points at the account, because deleting it would take a ledger with it.
 *
 * Both are gated, so they are called here through `execute`/`describe`
 * directly: `ToolRegistry.invoke` would (rightly) record an action and wait for
 * the owner instead of running anything.
 */
import type { Pool } from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { ToolRegistry, createPluginHost, createPool, hostBindingOf, migrate } from '@buddi/core/testing';
import type { CoreToolContext } from '@buddi/core/testing';
import { financeSkills, manifest, mergeAccounts, removeAccount } from '../index.js';
import { testDatabaseUrl } from '@buddi/core/testing';

describe('the merge and remove tools', () => {
  it('are gated in the manifest, and describe themselves before they run', () => {
    for (const name of ['finance.merge_accounts', 'finance.remove_account']) {
      const tool = manifest.tools.find((t) => t.name === name);
      expect(tool, `${name} is missing from the manifest`).toBeDefined();
      expect(tool!.tier).toBe('gated');
      expect(typeof tool!.describe).toBe('function');
    }
  });

  it('are what the skill tells the advisor to reach for on a duplicate', () => {
    const body = financeSkills.find((s) => s.name === 'an-observed-balance-is-recorded')!.body;
    expect(body).toContain('finance.merge_accounts');
    expect(body).toContain('includeInCashflow: false');
  });
});

const databaseUrl = await testDatabaseUrl();
const suite = databaseUrl ? describe : describe.skip;

const TEST_DB = `buddi_finance_merge_test_${process.pid}`;

suite('finance.merge_accounts (postgres)', () => {
  let admin: Pool;
  let pool: Pool;
  let ctx: CoreToolContext;
  const registry = new ToolRegistry();

  const call = async (name: string, args: unknown): Promise<any> => {
    const result = await registry.invoke(name, args, ctx);
    if (!result.ok) throw new Error(`${name} refused (${result.reason}): ${result.message}`);
    return result.output;
  };

  /** A fresh pair of accounts, with history on `from`, for one test. */
  const seed = async (from: string, into: string) => {
    await call('finance.set_balance', { account: from, balance: 100, asOf: '2026-09-01' });
    await call('finance.set_balance', { account: into, balance: 900, asOf: '2026-09-13' });
    await call('finance.record_transaction', {
      account: from,
      occurredOn: '2026-09-02',
      amount: -12.5,
      description: `Bakery ${from}`,
    });
    await call('finance.record_transaction', {
      account: from,
      occurredOn: '2026-09-03',
      amount: -40,
      description: `Fuel ${from}`,
    });
    await call('finance.add_recurring', {
      kind: 'charge',
      name: `Gym ${from}`,
      amount: 30,
      cadence: 'monthly',
      anchorDate: '2026-09-05',
      account: from,
    });
    await call('finance.set_liability', {
      name: `Card ${from}`,
      kind: 'credit_card',
      balance: 500,
      minimumPayment: 25,
      dueDay: 12,
      paidFrom: from,
    });
  };

  beforeAll(async () => {
    admin = createPool(databaseUrl as string);
    await admin.query(`drop database if exists ${TEST_DB}`);
    await admin.query(`create database ${TEST_DB}`);
    const testUrl = new URL(databaseUrl as string);
    testUrl.pathname = `/${TEST_DB}`;
    pool = createPool(testUrl.toString());
    await migrate(pool, { schema: manifest.schema, dir: manifest.migrationsDir });
    registry.register(manifest);
    ctx = {
      db: pool,
      ownerId: 'test',
      now: () => new Date('2026-09-13T12:00:00Z'),
      timezone: 'UTC',
    };
    ctx.buddi = createPluginHost(hostBindingOf(manifest), ctx);
  }, 60_000);

  afterAll(async () => {
    await pool?.end();
    if (admin) {
      await admin.query(`drop database if exists ${TEST_DB}`);
      await admin.end();
    }
  });

  it('moves every reference onto the survivor and deletes the duplicate', async () => {
    await seed('Checking', 'Main Checking');

    const described = await mergeAccounts.describe!({ from: 'Checking', into: 'Main Checking' }, ctx);
    expect(described.preview).toContain('2 transactions');
    expect(described.preview).toContain('1 recurring');
    expect(described.preview).toContain('1 liabilities');
    expect(described.preview).toContain('delete Checking');
    expect(described.envelope).toMatchObject({
      moving: { transactions: 2, recurring: 1, liabilities: 1 },
      balanceKept: 'into',
    });

    const merged: any = await mergeAccounts.execute({ from: 'Checking', into: 'Main Checking' }, ctx);
    expect(merged).toMatchObject({
      merged: true,
      balanceKept: 'into',
      moved: { transactions: 2, recurring: 1, liabilities: 1, stagings: 0 },
      into: { name: 'Main Checking', balance: 900, balanceAsOf: '2026-09-13' },
      deleted: { name: 'Checking' },
    });

    const listed = await call('finance.list_accounts', {});
    expect(listed.accounts.map((a: { name: string }) => a.name)).toEqual(['Main Checking']);

    const { rows } = await pool.query(
      `select count(*)::int as n from finance.transactions where account_id = $1`,
      [merged.into.id],
    );
    expect(rows[0].n).toBe(2);
    const { rows: orphans } = await pool.query(
      `select count(*)::int as n from finance.recurring_items where account_id is null`,
    );
    expect(orphans[0].n).toBe(0);
    const { rows: liab } = await pool.query(
      `select paid_from_account_id from finance.liabilities where name = 'Card Checking'`,
    );
    expect(liab[0].paid_from_account_id).toBe(merged.into.id);
  });

  it('takes the newer of the two balances, and says so', async () => {
    await call('finance.set_balance', { account: 'Old', balance: 10, asOf: '2026-09-01' });
    await call('finance.set_balance', { account: 'New', balance: 555.25, asOf: '2026-09-12' });

    const described = await mergeAccounts.describe!({ from: 'New', into: 'Old' }, ctx);
    expect(described.preview).toContain("New's newer balance 555.25 as of 2026-09-12");

    const merged: any = await mergeAccounts.execute({ from: 'New', into: 'Old' }, ctx);
    expect(merged).toMatchObject({
      balanceKept: 'from',
      into: { name: 'Old', balance: 555.25, balanceAsOf: '2026-09-12' },
    });
    expect(merged.note).toContain('2026-09-12');
  });

  it('accepts an id as readily as a name', async () => {
    const a = await call('finance.set_balance', { account: 'By id A', balance: 1 });
    const b = await call('finance.set_balance', { account: 'By id B', balance: 2 });
    const merged: any = await mergeAccounts.execute({ from: a.id, into: b.id }, ctx);
    expect(merged).toMatchObject({ merged: true, deleted: { id: a.id, name: 'By id A' } });
  });

  it('refuses an account merged into itself, or one it has never heard of', async () => {
    await call('finance.set_balance', { account: 'Solo', balance: 5 });
    await expect(mergeAccounts.execute({ from: 'Solo', into: 'solo' }, ctx)).rejects.toThrow(
      /same account/,
    );
    await expect(mergeAccounts.execute({ from: 'Ghost', into: 'Solo' }, ctx)).rejects.toThrow(
      /unknown account: Ghost/,
    );
    await expect(mergeAccounts.execute({ from: 'Solo', into: 'Ghost' }, ctx)).rejects.toThrow(
      /unknown account: Ghost/,
    );
  });

  it('refuses to fold spendable cash into money the cash flow cannot see, and says why', async () => {
    await call('finance.set_balance', { account: 'Spendable', balance: 400 });
    await call('finance.set_balance', { account: 'Brokerage', balance: 9000, kind: 'investment' });

    await expect(
      mergeAccounts.execute({ from: 'Spendable', into: 'Brokerage' }, ctx),
    ).rejects.toThrow(/excluded from the cash flow/);
    // Described, too: the refusal reaches the owner instead of an approval card.
    await expect(
      mergeAccounts.describe!({ from: 'Spendable', into: 'Brokerage' }, ctx),
    ).rejects.toThrow(/finance.update_account/);
    // The other direction is fine — nothing spendable disappears.
    const merged: any = await mergeAccounts.execute(
      { from: 'Brokerage', into: 'Spendable' },
      ctx,
    );
    expect(merged.merged).toBe(true);
  });

  it('will not remove an account with history, and names what holds it', async () => {
    await seed('Held', 'Elsewhere');
    await expect(removeAccount.execute({ account: 'Held' }, ctx)).rejects.toThrow(
      /2 transactions, 1 liabilities, 1 recurring pointing at it/,
    );
    await expect(removeAccount.execute({ account: 'Held' }, ctx)).rejects.toThrow(
      /finance\.merge_accounts/,
    );
    await expect(removeAccount.describe!({ account: 'Held' }, ctx)).rejects.toThrow(
      /cannot be deleted/,
    );
  });

  it('removes an account nothing points at', async () => {
    const typo = await call('finance.set_balance', { account: 'Chekcing', balance: 0 });
    const described = await removeAccount.describe!({ account: 'Chekcing' }, ctx);
    expect(described.preview).toContain('Delete the account Chekcing');
    expect(await removeAccount.execute({ account: 'Chekcing' }, ctx)).toEqual({
      removed: true,
      id: typo.id,
      name: 'Chekcing',
    });
    const { rows } = await pool.query(
      `select count(*)::int as n from finance.accounts where id = $1`,
      [typo.id],
    );
    expect(rows[0].n).toBe(0);
    await expect(removeAccount.execute({ account: 'Chekcing' }, ctx)).rejects.toThrow(
      /unknown account/,
    );
  });
});
