/**
 * Every metric, measured the way core measures one: over postgres, through
 * `measureMetric`, which hands `measure` a context whose `db` is the read-only
 * pool — `begin isolation level repeatable read read only`, one statement,
 * `rollback`.
 *
 * The unit tests above prove the arithmetic against fixtures. What only a
 * database can prove is that these reads survive that transaction at all: a
 * metric that reached for a volatile helper, or that came in through anything
 * but a `select`, is refused there and nowhere else — and it would be refused
 * for the first time six weeks into a goal, on a sentinel tick nobody is
 * watching.
 *
 * It never touches the developer's data: a throwaway database, this plugin's
 * migrations, dropped at the end.
 */
import type { Pool } from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { ToolRegistry, createPool, measureMetricResult, migrate } from '@buddi/core/testing';
import type { CoreToolContext } from '@buddi/core/testing';
import { testDatabaseUrl } from '@buddi/core/testing';
import { manifest } from './index.js';

const databaseUrl = await testDatabaseUrl();
const suite = databaseUrl ? describe : describe.skip;

const TEST_DB = `buddi_finance_metrics_test_${process.pid}`;

suite('the finance metrics (postgres, read-only)', () => {
  let admin: Pool;
  let pool: Pool;
  let ctx: CoreToolContext;
  const registry = new ToolRegistry();

  const call = async (name: string, args: unknown): Promise<any> => {
    const result = await registry.invoke(name, args, ctx);
    if (!result.ok) throw new Error(`${name} refused (${result.reason}): ${result.message}`);
    return result.output;
  };

  /** Exactly what the goal machinery does: the registry as the metric source. */
  const measure = (id: string, params: unknown = {}) =>
    measureMetricResult(registry, id, params, ctx);

  beforeAll(async () => {
    const url = new URL(databaseUrl as string);
    admin = createPool(databaseUrl as string);
    await admin.query(`drop database if exists ${TEST_DB}`);
    await admin.query(`create database ${TEST_DB}`);

    const testUrl = new URL(url.toString());
    testUrl.pathname = `/${TEST_DB}`;
    pool = createPool(testUrl.toString());
    await migrate(pool, { schema: manifest.schema, dir: manifest.migrationsDir });

    registry.register(manifest);
    ctx = {
      db: pool,
      ownerId: 'test',
      now: () => new Date('2026-09-21T12:00:00Z'),
      timezone: 'UTC',
      agentId: 'ledger',
    };
  }, 60_000);

  afterAll(async () => {
    await pool?.end();
    if (admin) {
      await admin.query(`drop database if exists ${TEST_DB}`);
      await admin.end();
    }
  });

  it('answers "not measurable" on an empty installation rather than zero', async () => {
    expect(await measure('finance.total_debt')).toMatchObject({ ok: false, reason: 'not-measurable' });
    expect(await measure('finance.cash_available')).toMatchObject({
      ok: false,
      reason: 'not-measurable',
    });
  });

  it('measures each one under the read-only transaction, with the recorded dates', async () => {
    await call('finance.set_preferences', { currency: 'USD' });
    await call('finance.set_balance', { account: 'Checking', balance: 900, asOf: '2026-09-20' });
    await call('finance.set_balance', { account: 'Savings', balance: 4000, asOf: '2026-09-04' });
    await call('finance.set_liability', {
      name: 'Rewards Card',
      kind: 'credit_card',
      balance: 2400,
      minimumPayment: 60,
      dueDay: 12,
      creditLimit: 5000,
      asOf: '2026-09-01',
    });
    await call('finance.set_liability', {
      name: 'Car loan',
      kind: 'loan',
      balance: 11000,
      minimumPayment: 320,
      dueDay: 5,
      asOf: '2026-09-12',
    });

    const debt = await measure('finance.total_debt');
    expect(debt).toMatchObject({ ok: true });
    expect(debt.ok && debt.reading).toMatchObject({ value: 13400, currency: 'USD' });
    expect(debt.ok && debt.reading.asOf.toISOString()).toBe('2026-09-12T00:00:00.000Z');

    const cash = await measure('finance.cash_available');
    expect(cash.ok && cash.reading).toMatchObject({ value: 4900, currency: 'USD' });
    expect(cash.ok && cash.reading.asOf.toISOString()).toBe('2026-09-20T00:00:00.000Z');

    const card = await measure('finance.card_balance', { account: 'rewards card' });
    expect(card.ok && card.reading).toMatchObject({ value: 2400, currency: 'USD' });
    expect(card.ok && card.reading.asOf.toISOString()).toBe('2026-09-01T00:00:00.000Z');
  });

  it('keeps a plugin\'s own refusal as the note, and never throws at the caller', async () => {
    const unknown = await measure('finance.card_balance', { account: 'Barclaycard' });
    expect(unknown).toMatchObject({ ok: false, reason: 'threw' });
    expect(!unknown.ok && unknown.note).toContain('Rewards Card');
  });

  it('stops measuring a card that was paid off, rather than failing forever', async () => {
    // `finance.remove_liability` deactivates; the row and its history stay.
    await call('finance.remove_liability', { name: 'Rewards Card' });
    expect(await measure('finance.card_balance', { account: 'Rewards Card' })).toMatchObject({
      ok: false,
      reason: 'not-measurable',
    });
    // The total follows the same population: the debt that is left is the loan.
    const debt = await measure('finance.total_debt');
    expect(debt.ok && debt.reading.value).toBe(11000);
  });

  it('refuses a narrowing nobody declared, before any query runs', async () => {
    expect(await measure('finance.total_debt', { account: 'Checking' })).toMatchObject({
      ok: false,
      reason: 'invalid-params',
    });
    expect(await measure('finance.card_balance', {})).toMatchObject({
      ok: false,
      reason: 'invalid-params',
    });
  });
});
