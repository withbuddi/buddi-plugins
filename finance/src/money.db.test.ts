/**
 * The Money page, the widgets and the setup sheet on a real Postgres, through
 * the host a plugin is handed. Fixtures: three accounts (one stale and not
 * spendable), a card over its target and a loan, rent, a phone bill on the
 * card and a salary, and a September statement read into Checking.
 * Skipped without `DATABASE_URL`; the suite makes and drops its own database.
 */
import type { Pool } from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  ToolRegistry, createPluginHost, createPool, hostBindingOf, migrate, testDatabaseUrl, type CoreToolContext,
} from '@buddi/core/testing';
import type { BuddiHost, WidgetBody } from '@buddi/core/plugin';
import { manifest } from './index.js';
import { invokeApproved } from './testing/approve.js';
import { setupTool } from './tools/money.js';

const databaseUrl = await testDatabaseUrl();
const suite = databaseUrl ? describe : describe.skip;
const TEST_DB = `buddi_finance_money_${process.pid}`;
const STATEMENT = '22222222-2222-4222-8222-222222222222';

suite('the Money page (postgres)', () => {
  let admin: Pool;
  let pool: Pool;
  const registry = new ToolRegistry();
  const now = new Date('2026-10-05T08:00:00Z'); // Monday 5 Oct

  const facts = (over: Partial<CoreToolContext> & { agentForRole?: (r: string) => string | undefined } = {}): CoreToolContext =>
    ({ db: pool, ownerId: 'owner', now: () => now, timezone: 'UTC', agentId: 'owner', ...over }) as CoreToolContext;
  const host = (over = {}): BuddiHost => createPluginHost(hostBindingOf(manifest), facts(over));
  const ctx = (over = {}): CoreToolContext => ({ ...facts(over), buddi: host(over) });
  const call = async (name: string, args: unknown): Promise<any> => {
    const result = await invokeApproved(registry, name, args, facts(), (c) => createPluginHost(hostBindingOf(manifest), c));
    if (!result.ok) throw new Error(`${name} refused (${result.reason}): ${result.message}`);
    return result.output;
  };
  const query = (name: string, over = {}): Promise<any> => manifest.queries!.find((q) => q.name === name)!.produce({}, ctx(over));
  const widget = (id: string, size: 'small' | 'medium'): Promise<WidgetBody | null> =>
    manifest.widgets!.find((w) => w.id === id)!.produce(ctx(), { size, settings: {} });

  beforeAll(async () => {
    admin = createPool(databaseUrl as string);
    await admin.query(`drop database if exists ${TEST_DB}`);
    await admin.query(`create database ${TEST_DB}`);
    const url = new URL(databaseUrl as string);
    url.pathname = `/${TEST_DB}`;
    pool = createPool(url.toString());
    await migrate(pool, { schema: manifest.schema, dir: manifest.migrationsDir });
    registry.register(manifest);
  }, 60_000);

  afterAll(async () => {
    await pool?.end();
    if (admin) {
      await admin.query(`drop database if exists ${TEST_DB}`);
      await admin.end();
    }
  });

  it('says "No accounts yet" and offers the first-run sheet before anything is recorded', async () => {
    expect(await query('money')).toMatchObject({ advisor: null, hasAccounts: false });
    expect(await query('accounts')).toEqual({ accounts: [], count: 0 });
    expect(await widget('finance.money', 'medium')).toMatchObject({ kind: 'text' });
    expect(await widget('finance.due', 'small')).toMatchObject({ kind: 'text' });
  });

  it('offers the currency the owner’s zone suggests, before anything is recorded', async () => {
    expect((await query('money_settings', { timezone: 'America/New_York' })).currency).toBe('USD');
    expect((await query('money_settings', { timezone: 'Europe/London' })).currency).toBe('GBP');
    expect((await query('money_settings')).currency).toBe('EUR'); // UTC says nothing: the euro
  });

  it('loads the fixtures', async () => {
    await call('finance.set_balance', { account: 'Checking', balance: 2400, asOf: '2026-10-03', institution: 'Example Bank' });
    await call('finance.set_balance', { account: 'Savings', balance: 8000, kind: 'savings', asOf: '2026-10-01' });
    await call('finance.set_balance', { account: 'Old 401k', balance: 30000, kind: 'retirement', asOf: '2026-09-01' });
    await call('finance.set_liability', { name: 'Amex', kind: 'credit_card', balance: 1800, minimumPayment: 35, dueDay: 15, creditLimit: 4000, statementDay: 9 });
    await call('finance.set_liability', { name: 'Car loan', kind: 'loan', balance: 9000, minimumPayment: 250, dueDay: 20, apr: 4.9 });
    await call('finance.add_recurring', { kind: 'charge', name: 'Rent', amount: 1250, cadence: 'monthly', anchorDate: '2026-01-08', account: 'Checking' });
    await call('finance.add_recurring', { kind: 'charge', name: 'Phone', amount: 19.99, cadence: 'monthly', anchorDate: '2026-01-06', liability: 'Amex' });
    await call('finance.add_recurring', { kind: 'income', name: 'Salary', amount: 3200, cadence: 'monthly', anchorDate: '2026-01-28', account: 'Checking' });
    const staged = await call('finance.stage_import', {
      account: 'Checking', source: 'statement', artifactId: STATEMENT,
      rows: [
        { date: '2026-09-02', amount: -64.2, description: 'MONOPRIX', category: 'groceries' },
        { date: '2026-09-08', amount: -1250, description: 'RENT SEPTEMBER', category: 'housing' },
        { date: '2026-09-28', amount: 3200, description: 'SALARY', category: 'income' },
      ],
    });
    await call('finance.commit_import', { stagingId: staged.stagingId });
  });

  it('lists the accounts, one line each, with the balance and when it was read', async () => {
    const { accounts } = await query('accounts');
    expect(accounts.map((a: any) => [a.name, a.line, a.balance, a.stale])).toEqual([
      ['Checking', 'Current account · Example Bank · as of 3 Oct', '€2,400', null],
      ['Old 401k', 'Retirement · not spendable · as of 1 Sep', '€30,000', 'Not updated in 34 days'],
      ['Savings', 'Savings · as of 1 Oct', '€8,000', null],
    ]);
    const totals = await query('money_totals');
    expect(totals).toMatchObject({ cash: '€10,400', netWorth: '€29,600', debt: '€10,800' });
  });

  it('keeps every amount in a field of its own: names, institutions, dates and card lines carry no figure', async () => {
    const { accounts } = await query('accounts');
    expect(accounts.map((a: any) => a.line).join(' ')).not.toMatch(/€/);
    const totals = await query('money_totals');
    expect(totals.cards.map((c: any) => [c.label, c.value, c.line])).toEqual([
      ['Cash', '€10,400', '2 accounts · as of 3 Oct'],
      ['Net worth', '€29,600', 'everything, less what you owe'],
      ['Owed', '€10,800', 'cards and loans'],
      ['Low point', expect.stringMatching(/^€/), expect.stringMatching(/^lowest, /)],
    ]);
    const { due } = await query('coming_up');
    expect(due.map((d: any) => d.line).join(' ')).not.toMatch(/€/);
    const { debts } = await query('debts');
    expect(debts.map((d: any) => d.line).join(' ')).not.toMatch(/€/);
    expect(debts.find((d: any) => d.name === 'Amex')).toMatchObject({ minimumWords: '€35 minimum' });
  });

  it('shows the charges coming up in 30 days, the card\'s on the card, and marks one paid', async () => {
    const { due } = await query('coming_up');
    expect(due.map((d: any) => [d.name, d.when, d.line, d.side])).toEqual([
      ['Phone', 'tomorrow', 'Due tomorrow · on Amex · Monthly', '€19.99'],
      ['Rent', 'Thu', 'Due Thu · from Checking · Monthly', '€1,250'],
    ]);
    const rent = due[1];
    const before = await call('finance.project_cashflow', { horizonDays: 10, includeBaseline: false });
    const marked = await call('finance.mark_paid', { id: rent.id, through: rent.date, balance: 1150 });
    expect(marked).toMatchObject({ paidThrough: '2026-10-08', account: 'Checking', message: 'Rent is marked paid, and Checking holds 1150 as of today.' });
    expect((await query('coming_up')).due.map((d: any) => d.name)).toEqual(['Phone']);
    // Paid early: the projection starts from the new balance and does not take the rent a second time.
    const after = await call('finance.project_cashflow', { horizonDays: 10, includeBaseline: false });
    expect(before.endBalance - after.endBalance).toBe(0);
    expect(after.startBalance).toBe(9150);
  });

  it('draws Cards & debts from the credit overview, the card over its target with the computed sentence', async () => {
    const { debts, utilization } = await query('debts');
    const amex = debts.find((d: any) => d.name === 'Amex');
    expect(amex).toMatchObject({ owed: '€1,800', over: 'Over target', dueOn: '2026-10-15', minimum: 35, paid: false });
    expect(amex.line).toMatch(/^Card · [0-9.]+% used · closes Fri · minimum due Thu 15 Oct$/);
    expect(amex.advice).toMatch(/Amex closes/);
    const loan = debts.find((d: any) => d.name === 'Car loan');
    expect(loan).toMatchObject({ owed: '€9,000', over: null, advice: null, line: 'Loan · minimum due Tue 20 Oct · 4.9% APR', minimumWords: '€250 minimum' });
    expect(utilization).toMatch(/% of your limits, on course to report$/);
    await call('finance.record_payment', { liability: 'Amex', dueOn: '2026-10-15', status: 'paid_on_time', amount: 35 });
    expect((await query('debts')).debts.find((d: any) => d.name === 'Amex')).toMatchObject({ paid: true });
  });

  it('lists the statement read, its account, its date and what it added, with the file to open', async () => {
    // Committed on the database's clock, not the test's: the day it really ran, in UTC.
    const [, m, d] = new Date().toISOString().slice(0, 10).split('-').map(Number);
    const readOn = `${d} ${['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'][m! - 1]}`;
    const { statements } = await query('statements');
    expect(statements).toEqual([
      {
        id: expect.any(String), artifactId: STATEMENT, title: `Checking · read ${readOn}`,
        line: '3 new lines · 2 Sep – 28 Sep',
        summary: `Checking · read ${readOn} — 3 new lines · 2 Sep – 28 Sep`,
        moved: '−€1,314 out · +€3,200 in',
      },
    ]);
  });

  it('draws the Money widget with the cash and the next bills, and Coming up without amounts until allowed', async () => {
    expect(await widget('finance.money', 'medium')).toEqual({
      kind: 'list', max: 5,
      rows: [{ title: 'Cash across 3 accounts', side: '€9,150' }, { title: 'Phone', side: '€19.99 · tomorrow' }],
    });
    expect(await widget('finance.money', 'small')).toEqual({ kind: 'stat', value: '€9,150', caption: 'cash across 3 accounts', foot: 'Phone due tomorrow' });
    expect(await widget('finance.due', 'small')).toEqual({ kind: 'list', rows: [{ title: 'Phone', side: 'tomorrow' }] });
    await call('finance.set_money_settings', { amountsOnLockScreen: true, currency: '', safetyFloor: 500 });
    expect(await query('money_settings')).toEqual({ currency: 'EUR', safetyFloor: 500, amountsOnLockScreen: true });
    expect(await widget('finance.due', 'small')).toEqual({ kind: 'list', rows: [{ title: 'Phone', side: '€19.99 · tomorrow' }] });
  });

  it('fixed the guessed currency at the first record: a move to another zone does not flip it', async () => {
    expect((await query('money_settings', { timezone: 'America/New_York' })).currency).toBe('EUR');
  });

  it('keeps setup and the settings from an agent', async () => {
    const asAgent = await registry.invoke('finance.setup', { name: 'Revolut', balance: 10 }, { ...facts(), agentId: 'cfo' } as CoreToolContext);
    expect(asAgent.ok).toBe(false);
  });

  it('sets up an account from the first-run sheet and answers its id', async () => {
    const out = await call('finance.setup', { name: 'Revolut', kind: '', balance: 320.5 });
    expect(out).toMatchObject({ name: 'Revolut', kind: 'cash', balance: 320.5, balanceAsOf: '2026-10-05', created: true, message: 'Revolut is added.', link: '#/p/finance/money' });
    expect(out.accountId).toMatch(/^[0-9a-f-]{36}$/);
    const again = await call('finance.setup', { name: 'revolut', balance: 300 });
    expect(again).toMatchObject({ accountId: out.accountId, created: false, message: 'Revolut is updated.' });
    await expect(call('finance.setup', { name: 'Joint' })).rejects.toThrow(/say what the account holds, or hand in a statement/);
  });

  it('hands a dropped statement to the CFO, who stages it and asks; without one, keeps it in Files', async () => {
    const runs: Array<{ agentId: string; prompt: string; dedupKey: string }> = [];
    const over = { agentForRole: (role: string) => (role === 'overview' ? 'cfo' : undefined), enqueueRun: async (r: any) => void runs.push(r) };
    const withFile = (h: BuddiHost): BuddiHost => ({ ...h, files: { ...h.files!, get: async (id: string) => (id === STATEMENT ? ({ id, filename: 'joint-sept.pdf' } as never) : null) } });
    const handed = await setupTool.execute({ name: 'Joint', kind: 'cash', artifactId: STATEMENT }, { ...ctx(over), buddi: withFile(host(over)) });
    expect(handed).toMatchObject({ name: 'Joint', balance: null, created: true, statement: { artifactId: STATEMENT, handedTo: 'cfo' } });
    expect(handed.message).toBe('Joint is added. Your CFO is reading the statement and will ask before anything is written.');
    expect(runs).toEqual([{ agentId: 'cfo', dedupKey: `finance.setup:${STATEMENT}`, prompt: expect.stringContaining('finance.stage_import (account "Joint"') }]);
    expect((await query('money', over)).advisor).toBe('cfo');

    const alone = await setupTool.execute({ name: 'Joint', artifactId: STATEMENT }, { ...ctx(), buddi: withFile(host()) });
    expect(alone).toMatchObject({ accountId: handed.accountId, statement: { handedTo: null } });
    await expect(setupTool.execute({ name: 'Joint', artifactId: '33333333-3333-4333-8333-333333333333' }, { ...ctx(), buddi: withFile(host()) }))
      .rejects.toThrow(/not in your Files library/);
  });

  it('takes the currency the owner confirmed on the first-run sheet', async () => {
    await call('finance.setup', { name: 'Chase', balance: 100, currency: 'usd' });
    expect((await query('money_settings')).currency).toBe('USD');
    expect((await query('accounts')).accounts.find((a: any) => a.name === 'Chase').balance).toBe('$100');
  });
});
