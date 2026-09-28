/**
 * Correcting the ledger: find, update, delete.
 *
 * The failure these exist for is a bad import — charges read as payments, day
 * and month swapped — that the owner could see but never fix. Update and
 * delete are gated, so they are called here through `describe`/`execute`
 * directly: `ToolRegistry.invoke` would (rightly) record an action and wait.
 */
import type { Pool } from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  ToolRegistry,
  createPluginHost,
  createPool,
  hostBindingOf,
  migrate,
  testDatabaseUrl,
} from '@buddi/core/testing';
import type { CoreToolContext } from '@buddi/core/testing';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { commitImport, deleteTransactions, importCsv, manifest, updateTransactions } from '../index.js';
import { invokeApproved } from '../testing/approve.js';

describe('the correction tools', () => {
  const tool = (name: string) => manifest.tools.find((t) => t.name === name);

  it('find is auto; update and delete are gated, described, and never remembered', () => {
    expect(tool('finance.find_transactions')?.tier).toBe('auto');
    for (const name of ['finance.update_transactions', 'finance.delete_transactions']) {
      const t = tool(name);
      expect(t, `${name} is missing from the manifest`).toBeDefined();
      expect(t!.tier).toBe('gated');
      expect(t!.reusableApproval).toBe(false);
      expect(typeof t!.describe).toBe('function');
    }
  });

  it('tells the model how to undo an import', () => {
    expect(deleteTransactions.description).toContain('To undo an import');
    expect(deleteTransactions.description).toContain('finance.find_transactions');
    expect(commitImport.description).toContain('finance.delete_transactions');
    expect(updateTransactions.description).toMatch(/keeps its sign/);
  });

  it('refuses a delete that names more than one selection, or half a range', () => {
    const id = '00000000-0000-4000-8000-000000000000';
    expect(deleteTransactions.input!.safeParse({ ids: [id], artifactId: id }).success).toBe(false);
    expect(deleteTransactions.input!.safeParse({ account: 'A', from: '2026-01-01' }).success).toBe(false);
    expect(deleteTransactions.input!.safeParse({ from: '2026-01-01', to: '2026-01-02' }).success).toBe(false);
    expect(
      deleteTransactions.input!.safeParse({ account: 'A', from: '2026-01-01', to: '2026-01-02' }).success,
    ).toBe(true);
  });
});

const databaseUrl = await testDatabaseUrl();
const suite = databaseUrl ? describe : describe.skip;

const TEST_DB = `buddi_finance_corrections_test_${process.pid}`;

suite('finance corrections (postgres)', () => {
  let admin: Pool;
  let pool: Pool;
  let ctx: CoreToolContext;
  const registry = new ToolRegistry();
  let docCounter = 0;

  const call = async (name: string, args: unknown): Promise<any> => {
    const result = await invokeApproved(registry, name, args, ctx, (c) => createPluginHost(hostBindingOf(manifest), c));
    if (!result.ok) throw new Error(`${name} refused (${result.reason}): ${result.message}`);
    return result.output;
  };

  const newDoc = () => `00000000-0000-4000-8000-${String(++docCounter).padStart(12, '0')}`;

  /** Stage and commit rows from one document onto one ledger; returns the document id. */
  const importRows = async (
    ledger: { account?: string; liability?: string },
    rows: Array<{ date: string; amount: number; description: string; category?: string; status?: 'pending' | 'posted' }>,
  ): Promise<string> => {
    const artifactId = newDoc();
    const staged = await call('finance.stage_import', { ...ledger, source: 'statement', artifactId, rows });
    await call('finance.commit_import', { stagingId: staged.stagingId });
    return artifactId;
  };

  const find = (args: Record<string, unknown>) => call('finance.find_transactions', args);

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
      now: () => new Date('2026-09-20T12:00:00Z'),
      timezone: 'UTC',
    };
    ctx.buddi = createPluginHost(hostBindingOf(manifest), ctx);
    await call('finance.set_preferences', { currency: 'USD' });
  }, 60_000);

  afterAll(async () => {
    await pool?.end();
    if (admin) {
      await admin.query(`drop database if exists ${TEST_DB}`);
      await admin.end();
    }
  });

  it('commit_import and import_csv put the count and the ledger on the card, and refuse a spent staging there', async () => {
    await call('finance.set_balance', { account: 'Card', balance: 10 });
    const staged = await call('finance.stage_import', {
      account: 'Card',
      source: 'statement',
      artifactId: newDoc(),
      rows: [
        { date: '2026-09-01', amount: -1, description: 'Card one' },
        { date: '2026-09-03', amount: -2, description: 'Card two' },
      ],
    });
    const effect = await commitImport.describe!({ stagingId: staged.stagingId }, ctx);
    expect(effect.preview).toBe('Add 2 transactions to the account Card, 2026-09-01 to 2026-09-03.');
    expect(effect.envelope).toMatchObject({ stagingId: staged.stagingId, ledger: { kind: 'account', name: 'Card' }, newRows: 2 });
    await call('finance.commit_import', { stagingId: staged.stagingId });
    await expect(commitImport.describe!({ stagingId: staged.stagingId }, ctx)).rejects.toMatchObject({
      refusal: true,
      message: expect.stringMatching(/already committed/),
    });

    const dir = await mkdtemp(path.join(tmpdir(), 'finance-card-'));
    const file = path.join(dir, 'september.csv');
    await writeFile(file, 'Date,Description,Amount\n2026-09-05,Bakery,-4.50\n2026-09-06,Fuel,-30\n');
    const csv = await importCsv.describe!({ path: file, account: 'Fresh' }, ctx);
    expect(csv.preview).toBe(
      'Import 2 rows from september.csv into the account Fresh (a new account), 2026-09-05 to 2026-09-06. Rows already recorded are skipped.',
    );
    // Describing wrote nothing: the account does not exist yet.
    expect((await pool.query(`select 1 from finance.accounts where name = 'Fresh'`)).rowCount).toBe(0);
    await writeFile(file, 'Date,Description,Amount\n2026-09-05,Bakery,-45.00\n');
    await expect(
      importCsv.execute({ path: file, account: 'Fresh' }, { ...ctx, approvedEffect: { envelope: csv.envelope } }),
    ).rejects.toThrow(/changed after the owner approved/);
    await rm(dir, { recursive: true, force: true });
  });

  it('commit_import stamps the document on every row it writes', async () => {
    await call('finance.set_balance', { account: 'Stamp', balance: 10 });
    const doc = await importRows({ account: 'Stamp' }, [
      { date: '2026-09-01', amount: -1, description: 'One' },
      { date: '2026-09-02', amount: -2, description: 'Two' },
    ]);
    const { rows } = await pool.query(
      `select t.artifact_id from finance.transactions t join finance.accounts a on a.id = t.account_id
        where a.name = 'Stamp'`,
    );
    expect(rows).toHaveLength(2);
    expect(rows.every((r) => r.artifact_id === doc)).toBe(true);
  });

  it('finds by every filter', async () => {
    await call('finance.set_balance', { account: 'Find', balance: 100 });
    await call('finance.set_liability', {
      name: 'Find Card', kind: 'credit_card', balance: 0, minimumPayment: 25, dueDay: 5,
    });
    const doc = await importRows({ account: 'Find' }, [
      { date: '2026-08-01', amount: -12.5, description: 'Bakery Rue', category: 'food' },
      { date: '2026-08-10', amount: 2000, description: 'Salary ACME', category: 'income' },
      { date: '2026-08-20', amount: -80, description: 'FUEL station', category: 'car' },
    ]);
    await call('finance.record_transaction', {
      account: 'Find', occurredOn: '2026-08-15', amount: -5, description: 'Coffee', category: 'food',
    });
    await call('finance.record_transaction', {
      liability: 'Find Card', occurredOn: '2026-08-16', amount: -40, description: 'Dinner',
    });

    const all = await find({ account: 'Find' });
    expect(all.total).toBe(4);
    expect(all.rows[0]).toMatchObject({ date: '2026-08-20', account: 'Find', liability: null });
    expect(all.rows[0].id).toMatch(/^[0-9a-f-]{36}$/);
    expect(all.rows[0].createdAt).toBeTruthy();

    const card = await find({ liability: 'Find Card' });
    expect(card.rows.map((r: any) => r.description)).toEqual(['Dinner']);
    expect(card.rows[0].liability).toBe('Find Card');

    const range = await find({ account: 'Find', from: '2026-08-10', to: '2026-08-15' });
    expect(range.rows.map((r: any) => r.description).sort()).toEqual(['Coffee', 'Salary ACME']);

    const amounts = await find({ account: 'Find', minAmount: -20, maxAmount: 0 });
    expect(amounts.rows.map((r: any) => r.description).sort()).toEqual(['Bakery Rue', 'Coffee']);

    const text = await find({ text: 'fuel' });
    expect(text.rows.map((r: any) => r.description)).toEqual(['FUEL station']);

    const category = await find({ account: 'Find', category: 'FOOD' });
    expect(category.total).toBe(2);

    const byDoc = await find({ artifactId: doc });
    expect(byDoc.total).toBe(3);
    expect(byDoc.rows.every((r: any) => r.artifactId === doc && r.source === 'statement')).toBe(true);

    const manual = await find({ account: 'Find', source: 'manual' });
    expect(manual.rows.map((r: any) => r.description)).toEqual(['Coffee']);

    const page = await find({ account: 'Find', limit: 2, offset: 1 });
    expect(page.total).toBe(4);
    expect(page.rows.map((r: any) => r.date)).toEqual(['2026-08-15', '2026-08-10']);

    await expect(find({ account: 'Nowhere' })).rejects.toThrow(/no account called Nowhere/);
  });

  it('updates the fields, previews every row, and reconciles after', async () => {
    await call('finance.set_balance', { account: 'Upd', balance: 500 });
    await call('finance.set_liability', {
      name: 'Upd Card', kind: 'credit_card', balance: 0, minimumPayment: 25, dueDay: 5,
    });
    // The bad import: a charge read as a payment with day and month swapped,
    // and a posted grocery charge a cent off its pending twin.
    await importRows({ account: 'Upd' }, [
      { date: '2026-12-09', amount: 40, description: 'Rahmas Poultry' },
      { date: '2026-09-05', amount: -23.45, description: 'LIDL 883', status: 'pending' },
      { date: '2026-09-06', amount: -23.46, description: 'LIDL 883' },
      { date: '2026-09-07', amount: -60, description: 'Gas bill' },
    ]);
    const rows = (await find({ account: 'Upd' })).rows;
    const byText = (t: string, status = 'posted') =>
      rows.find((r: any) => r.description === t && r.status === status);
    const poultry = byText('Rahmas Poultry');
    const posted = byText('LIDL 883');
    const gas = byText('Gas bill');

    const input = {
      changes: [
        { id: poultry.id, date: '2026-09-12', amount: -40 },
        { id: posted.id, amount: -23.45, category: 'groceries' },
        { id: gas.id, liability: 'Upd Card' },
      ],
    };
    const described = await updateTransactions.describe!(input, ctx);
    expect(described.preview.split('\n')).toEqual([
      'Change 3 transactions:',
      '2026-12-09 +$40.00 Rahmas Poultry → 2026-09-12 −$40.00',
      '2026-09-06 −$23.46 LIDL 883 (no category) → −$23.45 (groceries)',
      '2026-09-07 −$60.00 Gas bill on Upd → on Upd Card',
    ]);
    expect(described.envelope).toMatchObject({ count: 3 });

    const result: any = await updateTransactions.execute(input, ctx);
    expect(result.updated).toBe(3);
    // Reconcile ran: the corrected posted row now settles the pending one.
    expect(result.reconciled.pendingMatched).toBe(1);

    const { rows: after } = await pool.query(
      `select id, occurred_on::text as d, amount::float as a, category, account_id, liability_id, superseded_by
         from finance.transactions where id = any($1)`,
      [[poultry.id, posted.id, gas.id, byText('LIDL 883', 'pending').id]],
    );
    const get = (id: string) => after.find((r) => r.id === id);
    expect(get(poultry.id)).toMatchObject({ d: '2026-09-12', a: -40 });
    expect(get(posted.id)).toMatchObject({ a: -23.45, category: 'groceries' });
    expect(get(gas.id).account_id).toBeNull();
    expect(get(gas.id).liability_id).not.toBeNull();
    expect(get(byText('LIDL 883', 'pending').id).superseded_by).toBe(posted.id);

    // The dedup identity follows the correction: the right statement reads as a duplicate.
    const restaged = await call('finance.stage_import', {
      account: 'Upd', source: 'statement',
      rows: [{ date: '2026-09-12', amount: -40, description: 'Rahmas Poultry' }],
    });
    expect(restaged.summary.duplicates).toBe(1);
  });

  it('refuses unknown ids and unknown ledgers in a sentence, before any card', async () => {
    const ghost = '00000000-0000-4000-8000-00000000dead';
    await expect(
      updateTransactions.describe!({ changes: [{ id: ghost, amount: 1 }] }, ctx),
    ).rejects.toThrow(`This id is not in the ledger: ${ghost}. Look the rows up with finance.find_transactions first.`);
    await expect(
      updateTransactions.execute({ changes: [{ id: ghost, amount: 1 }] }, ctx),
    ).rejects.toThrow(/not in the ledger/);
    const [row] = (await find({ account: 'Stamp' })).rows;
    await expect(
      updateTransactions.describe!({ changes: [{ id: row.id, liability: 'No Such Card' }] }, ctx),
    ).rejects.toThrow('There is no card or loan called No Such Card.');
  });

  it('deletes by ids', async () => {
    await call('finance.set_balance', { account: 'DelIds', balance: 0 });
    for (const [d, a] of [['2026-07-01', -1], ['2026-07-02', -2], ['2026-07-03', 3]] as const) {
      await call('finance.record_transaction', { account: 'DelIds', occurredOn: d, amount: a, description: `Row ${d}` });
    }
    const rows = (await find({ account: 'DelIds' })).rows;
    const ids = rows.filter((r: any) => r.date !== '2026-07-02').map((r: any) => r.id);

    const described = await deleteTransactions.describe!({ ids }, ctx);
    expect(described.preview.split('\n')).toEqual([
      'Delete 2 transactions on DelIds, 2026-07-01 to 2026-07-03: +$3.00 in, −$1.00 out.',
      '2026-07-01 −$1.00 Row 2026-07-01',
      '2026-07-03 +$3.00 Row 2026-07-03',
    ]);
    expect(described.envelope).toMatchObject({ count: 2, ids: expect.arrayContaining(ids) });

    const result: any = await deleteTransactions.execute({ ids }, ctx);
    expect(result.deleted).toBe(2);
    expect((await find({ account: 'DelIds' })).rows.map((r: any) => r.date)).toEqual(['2026-07-02']);

    await expect(deleteTransactions.describe!({ ids }, ctx)).rejects.toThrow(/not in the ledger/);
  });

  it('undoes an import by its document, and the pending row it settled comes back', async () => {
    await call('finance.set_balance', { account: 'Undo', balance: 0 });
    await call('finance.record_transaction', {
      account: 'Undo', occurredOn: '2026-05-31', amount: -9.99, description: 'NETFLIX', status: 'pending',
    });
    const doc = await importRows(
      { account: 'Undo' },
      Array.from({ length: 7 }, (_, i) => ({
        date: `2026-06-0${i + 1}`,
        amount: i === 0 ? -9.99 : i === 6 ? 100 : -(i + 1),
        description: i === 0 ? 'NETFLIX' : `Line ${i + 1}`,
      })),
    );
    const pendingBefore = await pool.query(
      `select superseded_by from finance.transactions where status = 'pending' and description = 'NETFLIX'`,
    );
    expect(pendingBefore.rows[0].superseded_by).not.toBeNull();

    const described = await deleteTransactions.describe!({ artifactId: doc }, ctx);
    const lines = described.preview.split('\n');
    expect(lines[0]).toBe(
      `Delete 7 transactions on Undo, 2026-06-01 to 2026-06-07, every row from document ${doc}: +$100.00 in, −$29.99 out.`,
    );
    expect(lines.slice(1, 6)).toEqual([
      '2026-06-01 −$9.99 NETFLIX',
      '2026-06-02 −$2.00 Line 2',
      '2026-06-03 −$3.00 Line 3',
      '2026-06-04 −$4.00 Line 4',
      '2026-06-05 −$5.00 Line 5',
    ]);
    expect(lines[6]).toBe('and 2 more');

    const result: any = await deleteTransactions.execute({ artifactId: doc }, ctx);
    expect(result.deleted).toBe(7);
    expect(result.reconciled.pendingOutstanding).toBeGreaterThanOrEqual(1);
    const left = (await find({ account: 'Undo' })).rows;
    expect(left).toHaveLength(1);
    expect(left[0]).toMatchObject({ description: 'NETFLIX', status: 'pending' });
    expect(left[0].superseded).toBeUndefined();

    await expect(deleteTransactions.describe!({ artifactId: doc }, ctx)).rejects.toThrow(
      `No transaction came from document ${doc}, so there is nothing to undo.`,
    );
    await expect(deleteTransactions.execute({ artifactId: doc }, ctx)).rejects.toThrow(/nothing to undo/);
  });

  it('deletes a date range on one ledger, and refuses an empty one', async () => {
    await call('finance.set_balance', { account: 'Range', balance: 0 });
    await call('finance.set_balance', { account: 'Other', balance: 0 });
    for (const d of ['2026-05-01', '2026-05-15', '2026-05-31', '2026-06-01']) {
      await call('finance.record_transaction', { account: 'Range', occurredOn: d, amount: -10, description: `R ${d}` });
    }
    await call('finance.record_transaction', { account: 'Other', occurredOn: '2026-05-15', amount: -10, description: 'O' });

    const input = { account: 'Range', from: '2026-05-01', to: '2026-05-31' };
    const described = await deleteTransactions.describe!(input, ctx);
    expect(described.preview.split('\n')[0]).toBe(
      'Delete 3 transactions on Range, 2026-05-01 to 2026-05-31: +$0.00 in, −$30.00 out.',
    );
    const result: any = await deleteTransactions.execute(input, ctx);
    expect(result.deleted).toBe(3);
    expect((await find({ account: 'Range' })).rows.map((r: any) => r.date)).toEqual(['2026-06-01']);
    expect((await find({ account: 'Other' })).total).toBe(1);

    await expect(deleteTransactions.describe!(input, ctx)).rejects.toThrow(
      'Range has no transactions from 2026-05-01 to 2026-05-31, so there is nothing to delete.',
    );
  });
});
