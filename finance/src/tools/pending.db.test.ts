/**
 * DB-backed tests for pending money, receipts and staged imports. Skipped
 * unless DATABASE_URL is set.
 *
 * Like the other DB suite, this never touches the developer's data: it creates
 * a throwaway database, migrates this plugin into it, and drops it at the end.
 */
import { readFileSync } from 'node:fs';
import type { Pool } from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { ToolRegistry, createPluginHost, createPool, hostBindingOf, migrate } from '@buddi/core/testing';
import type { CoreToolContext } from '@buddi/core/testing';
import { manifest } from '../index.js';
import { stageImport } from './staging.js';
import { testDatabaseUrl } from '@buddi/core/testing';
import { invokeApproved } from '../testing/approve.js';

const databaseUrl = await testDatabaseUrl();
const suite = databaseUrl ? describe : describe.skip;

const TEST_DB = `buddi_finance_pending_test_${process.pid}`;

suite('pending, receipts and staged imports (postgres)', () => {
  let admin: Pool;
  let pool: Pool;
  let ctx: CoreToolContext;
  const registry = new ToolRegistry();

  const call = async (name: string, args: unknown): Promise<any> => {
    const result = await invokeApproved(registry, name, args, ctx, (c) => createPluginHost(hostBindingOf(manifest), c));
    if (!result.ok) throw new Error(`${name} refused (${result.reason}): ${result.message}`);
    return result.output;
  };

  /** Invoke expecting a refusal, and return the message. */
  const refusal = async (name: string, args: unknown): Promise<string> => {
    const result = await invokeApproved(registry, name, args, ctx, (c) => createPluginHost(hostBindingOf(manifest), c));
    if (result.ok) throw new Error(`${name} unexpectedly succeeded`);
    return result.message;
  };

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
      now: () => new Date('2026-09-13T12:00:00Z'),
      timezone: 'UTC',
    };
  }, 60_000);

  afterAll(async () => {
    await pool?.end();
    if (admin) {
      await admin.query(`drop database if exists ${TEST_DB}`);
      await admin.end();
    }
  });

  describe('pending becomes posted', () => {
    it('supersedes a pending row with the posted row that replaced it', async () => {
      await call('finance.set_balance', { account: 'Checking', balance: 1000 });
      const pending = await call('finance.record_transaction', {
        account: 'Checking',
        occurredOn: '2026-09-10',
        amount: -42.5,
        description: 'POS DEBIT CARD1234 LIDL #883',
        status: 'pending',
      });
      expect(pending).toMatchObject({ recorded: true, status: 'pending' });

      // Nothing to match yet.
      const first = await call('finance.reconcile', {});
      expect(first).toMatchObject({ matched: 0, unmatched: 1 });

      const posted = await call('finance.record_transaction', {
        account: 'Checking',
        occurredOn: '2026-09-12',
        amount: -42.5,
        description: 'LIDL PARIS 11',
      });
      expect(posted).toMatchObject({ recorded: true, status: 'posted' });

      const second = await call('finance.reconcile', {});
      expect(second.matched).toBe(1);
      expect(second.unmatched).toBe(0);
      expect(second.pending.matched[0]).toMatchObject({
        pendingId: pending.id,
        postedId: posted.id,
        dayGap: 2,
      });

      const { rows } = await pool.query(
        `select superseded_by from finance.transactions where id = $1`,
        [pending.id],
      );
      expect(rows[0].superseded_by).toBe(posted.id);

      // The pending row is neither deleted nor matched a second time.
      const third = await call('finance.reconcile', {});
      expect(third).toMatchObject({ matched: 0, unmatched: 0 });
      const { rows: kept } = await pool.query(
        `select count(*)::int as n from finance.transactions where id = $1`,
        [pending.id],
      );
      expect(kept[0].n).toBe(1);
    });

    it('leaves a pending row alone when nothing matches it', async () => {
      await call('finance.record_transaction', {
        account: 'Checking',
        occurredOn: '2026-09-11',
        amount: -88.2,
        description: 'PENDING HOTEL DEPOSIT',
        status: 'pending',
      });
      // A posted row for a different merchant, same window, same account.
      await call('finance.record_transaction', {
        account: 'Checking',
        occurredOn: '2026-09-12',
        amount: -88.2,
        description: 'MONOPRIX LYON',
      });
      const report = await call('finance.reconcile', {});
      expect(report.matched).toBe(0);
      expect(report.unmatched).toBe(1);
    });
  });

  describe('summary', () => {
    it('counts posted money only, and folds pending in on request', async () => {
      await call('finance.record_transaction', {
        account: 'Summary',
        occurredOn: '2026-05-04',
        amount: -30,
        description: 'CARREFOUR MAY',
        category: 'groceries',
      });
      await call('finance.record_transaction', {
        account: 'Summary',
        occurredOn: '2026-05-06',
        amount: -70,
        description: 'DECATHLON MAY',
        category: 'sport',
        status: 'pending',
      });

      const posted = await call('finance.summary', { month: '2026-05' });
      expect(posted).toMatchObject({ expenses: -30, count: 1, includePending: false });
      expect(posted.pending).toMatchObject({ count: 1, total: -70, countedInTotals: false });

      const withPending = await call('finance.summary', {
        month: '2026-05',
        includePending: true,
      });
      expect(withPending).toMatchObject({ expenses: -100, count: 2, includePending: true });
    });

    it('never counts a superseded pending row', async () => {
      await call('finance.record_transaction', {
        account: 'Summary',
        occurredOn: '2026-04-02',
        amount: -25,
        description: 'POS PIN SPAR 4412',
        status: 'pending',
      });
      await call('finance.record_transaction', {
        account: 'Summary',
        occurredOn: '2026-04-04',
        amount: -25,
        description: 'SPAR AMSTERDAM',
      });
      await call('finance.reconcile', {});

      const april = await call('finance.summary', { month: '2026-04', includePending: true });
      expect(april.count).toBe(1);
      expect(april.expenses).toBe(-25);
    });
  });

  describe('projection', () => {
    it('applies pending charges inside the horizon as one-off events', async () => {
      await call('finance.set_balance', { account: 'Projection', balance: 500 });
      await call('finance.record_transaction', {
        account: 'Projection',
        occurredOn: '2026-09-20',
        amount: -100,
        description: 'AIRLINE HOLD',
        status: 'pending',
      });

      const withPending = await call('finance.project_cashflow', {
        account: 'Projection',
        horizonDays: 30,
        includeBaseline: false,
      });
      expect(withPending.includePending).toBe(true);
      expect(withPending.pendingEvents).toEqual([
        { name: 'AIRLINE HOLD (pending)', amount: -100, date: '2026-09-20' },
      ]);
      expect(withPending.endBalance).toBe(400);
      expect(withPending.minBalance).toBe(400);

      const without = await call('finance.project_cashflow', {
        account: 'Projection',
        horizonDays: 30,
        includeBaseline: false,
        includePending: false,
      });
      expect(without.pendingEvents).toEqual([]);
      expect(without.endBalance).toBe(500);
    });

    it('ignores a pending charge dated beyond the horizon', async () => {
      await call('finance.record_transaction', {
        account: 'Projection',
        occurredOn: '2026-12-24',
        amount: -250,
        description: 'FAR AWAY HOLD',
        status: 'pending',
      });
      const projected = await call('finance.project_cashflow', {
        account: 'Projection',
        horizonDays: 30,
        includeBaseline: false,
      });
      expect(projected.pendingEvents).toHaveLength(1);
      expect(projected.endBalance).toBe(400);
    });
  });

  describe('receipts', () => {
    it('matches a receipt to the charge on the same day', async () => {
      const tx = await call('finance.record_transaction', {
        account: 'Cards',
        occurredOn: '2026-06-10',
        amount: -63.4,
        description: 'TRADER JOES #22',
      });
      const result = await call('finance.record_receipt', {
        merchant: "Trader Joe's",
        occurredOn: '2026-06-10',
        total: 63.4,
        items: [{ name: 'Coffee', qty: 2, price: 11.98 }],
      });
      expect(result.matchedTransaction).toMatchObject({ id: tx.id, status: 'posted' });
      expect(result.receipt).toMatchObject({ merchantNorm: 'trader joes', total: 63.4 });
    });

    it('matches a receipt three days from the charge, and a pending charge', async () => {
      const tx = await call('finance.record_transaction', {
        account: 'Cards',
        occurredOn: '2026-06-14',
        amount: -21.75,
        description: 'MONOPRIX LYON 03',
        status: 'pending',
      });
      const result = await call('finance.record_receipt', {
        merchant: 'Monoprix',
        occurredOn: '2026-06-11',
        total: 21.75,
      });
      expect(result.matchedTransaction).toMatchObject({ id: tx.id, status: 'pending' });
    });

    it('leaves a receipt unmatched when the charge is four days away', async () => {
      await call('finance.record_transaction', {
        account: 'Cards',
        occurredOn: '2026-06-25',
        amount: -44.44,
        description: 'IKEA PARIS NORD',
      });
      const result = await call('finance.record_receipt', {
        merchant: 'IKEA',
        occurredOn: '2026-06-21',
        total: 44.44,
      });
      expect(result.matchedTransaction).toBeNull();

      const unmatched = await call('finance.list_receipts', { unmatchedOnly: true });
      expect(unmatched.receipts.map((r: any) => r.merchant)).toContain('IKEA');

      // Reconcile does not force it either — four days is four days.
      await call('finance.reconcile', {});
      const still = await call('finance.list_receipts', { unmatchedOnly: true });
      expect(still.receipts.map((r: any) => r.id)).toContain(result.receipt.id);
    });

    it('links a receipt by hand', async () => {
      const unmatched = await call('finance.list_receipts', { unmatchedOnly: true });
      const receipt = unmatched.receipts.find((r: any) => r.merchant === 'IKEA');
      const { rows } = await pool.query(
        `select id from finance.transactions where description = 'IKEA PARIS NORD'`,
      );
      const linked = await call('finance.link_receipt', {
        receiptId: receipt.id,
        transactionId: rows[0].id,
      });
      expect(linked.receipt.transactionId).toBe(rows[0].id);

      const after = await call('finance.list_receipts', { unmatchedOnly: true });
      expect(after.receipts.map((r: any) => r.id)).not.toContain(receipt.id);
    });

    it('links an outstanding receipt once its charge arrives', async () => {
      const receipt = await call('finance.record_receipt', {
        merchant: 'Gelateria Rossi',
        occurredOn: '2026-07-02',
        total: 8.5,
      });
      expect(receipt.matchedTransaction).toBeNull();

      const tx = await call('finance.record_transaction', {
        account: 'Cards',
        occurredOn: '2026-07-03',
        amount: -8.5,
        description: 'GELATERIA ROSSI ROMA',
      });
      const report = await call('finance.reconcile', {});
      expect(report.receipts.matched).toBeGreaterThanOrEqual(1);
      expect(
        report.receipts.detail.matched.some(
          (m: any) => m.receiptId === receipt.receipt.id && m.transactionId === tx.id,
        ),
      ).toBe(true);
    });
  });

  describe('staged imports', () => {
    const rows = [
      { date: '2026-08-03', amount: -12.5, description: 'CAFE DU COIN', category: 'eating out' },
      { date: '2026-08-04', amount: -200, description: 'EDF ELECTRICITY', category: 'utilities' },
      { date: '2026-08-05', amount: 1800, description: 'SALARY AUGUST', category: 'income' },
    ];

    it('stages rows without writing them, and counts duplicates', async () => {
      // One of the three is already in the ledger.
      await call('finance.record_transaction', {
        account: 'Statements',
        occurredOn: '2026-08-04',
        amount: -200,
        description: 'EDF ELECTRICITY',
        category: 'utilities',
      });

      const staged = await call('finance.stage_import', {
        account: 'Statements',
        source: 'statement',
        artifactId: '11111111-1111-4111-8111-111111111111',
        rows,
      });
      expect(staged.summary).toMatchObject({
        rows: 3,
        newRows: 2,
        duplicates: 1,
        totalIn: 1800,
        totalOut: -12.5,
        dateRange: { from: '2026-08-03', to: '2026-08-05' },
      });
      expect(staged.summary.byCategoryTop5).toEqual([
        { category: 'income', total: 1800 },
        { category: 'eating out', total: -12.5 },
      ]);

      // Nothing written yet: only the row recorded by hand exists.
      const { rows: count } = await pool.query(
        `select count(*)::int as n from finance.transactions t
           join finance.accounts a on a.id = t.account_id
          where a.name = 'Statements'`,
      );
      expect(count[0].n).toBe(1);

      const committed = await call('finance.commit_import', { stagingId: staged.stagingId });
      expect(committed).toMatchObject({ inserted: 2, skipped: 1, source: 'statement' });

      const { rows: after } = await pool.query(
        `select description, source, status, artifact_id from finance.transactions t
           join finance.accounts a on a.id = t.account_id
          where a.name = 'Statements' order by occurred_on`,
      );
      expect(after).toHaveLength(3);
      const salary = after.find((r) => r.description === 'SALARY AUGUST');
      expect(salary).toMatchObject({
        source: 'statement',
        status: 'posted',
        artifact_id: '11111111-1111-4111-8111-111111111111',
      });
    });

    it('refuses to commit the same staging twice', async () => {
      const staged = await call('finance.stage_import', {
        account: 'Statements',
        source: 'statement',
        rows: [{ date: '2026-08-09', amount: -9.99, description: 'NETFLIX' }],
      });
      await call('finance.commit_import', { stagingId: staged.stagingId });
      const message = await refusal('finance.commit_import', { stagingId: staged.stagingId });
      expect(message).toMatch(/already committed/);
    });

    it('keeps a staged pending row pending, and reconciles on commit', async () => {
      const staged = await call('finance.stage_import', {
        account: 'Statements',
        source: 'statement',
        rows: [
          {
            date: '2026-08-20',
            amount: -55,
            description: 'POS CARD1234 FNAC PARIS',
            status: 'pending',
          },
          { date: '2026-08-21', amount: -31, description: 'BOULANGERIE', status: 'pending' },
          { date: '2026-08-22', amount: -55, description: 'FNAC PARIS 12' },
        ],
      });
      expect(staged.summary.pending).toBe(2);

      const committed = await call('finance.commit_import', { stagingId: staged.stagingId });
      expect(committed).toMatchObject({ inserted: 3, pending: 2 });
      expect(committed.reconciled.pendingMatched).toBe(1);

      const { rows: fnac } = await pool.query(
        `select status, superseded_by from finance.transactions
          where description = 'POS CARD1234 FNAC PARIS'`,
      );
      expect(fnac[0].status).toBe('pending');
      expect(fnac[0].superseded_by).not.toBeNull();

      // The unmatched pending row survives untouched.
      const { rows: bread } = await pool.query(
        `select status, superseded_by from finance.transactions where description = 'BOULANGERIE'`,
      );
      expect(bread[0]).toMatchObject({ status: 'pending', superseded_by: null });
    });

    it('reads a posted copy of a pending row as the charge posting, not a duplicate', async () => {
      // The pending authorisation, recorded from an earlier statement.
      await call('finance.record_transaction', {
        account: 'Posting',
        occurredOn: '2026-08-25',
        amount: -18.4,
        description: 'UBER TRIP',
        status: 'pending',
      });
      // A pending row already settled by its posted twin, which is in the ledger.
      await call('finance.record_transaction', {
        account: 'Posting', occurredOn: '2026-08-26', amount: -7, description: 'NEWSSTAND', status: 'pending',
      });
      await call('finance.record_transaction', { account: 'Posting', occurredOn: '2026-08-27', amount: -7, description: 'NEWSSTAND 22' });
      await call('finance.reconcile', {});
      // A pending charge whose posted line reads differently and is dated a day earlier.
      await call('finance.record_transaction', {
        account: 'Posting', occurredOn: '2026-08-28', amount: -64, description: 'POS CARD1234 DECATHLON', status: 'pending',
      });

      const staged = await call('finance.stage_import', {
        account: 'Posting',
        source: 'statement',
        rows: [
          { date: '2026-08-25', amount: -18.4, description: 'UBER TRIP' }, // same line, now posted
          { date: '2026-08-26', amount: -7, description: 'NEWSSTAND' }, // superseded: its twin is in
          { date: '2026-08-27', amount: -64, description: 'DECATHLON' }, // posts the pending one
        ],
      });
      expect(staged.summary).toMatchObject({ rows: 3, newRows: 2, duplicates: 1, settlesPending: 2 });

      const committed = await call('finance.commit_import', { stagingId: staged.stagingId });
      expect(committed).toMatchObject({ inserted: 1, skipped: 1, settledPending: 1 });
      expect(committed.reconciled.pendingMatched).toBeGreaterThanOrEqual(1);

      const { rows: uber } = await pool.query(
        `select status, source, superseded_by from finance.transactions
          where description = 'UBER TRIP' order by status`,
      );
      // One line, settled in place: posted, from the statement.
      expect(uber).toEqual([{ status: 'posted', source: 'statement', superseded_by: null }]);
      const { rows: decathlon } = await pool.query(
        `select superseded_by from finance.transactions where description = 'POS CARD1234 DECATHLON'`,
      );
      expect(decathlon[0].superseded_by).not.toBeNull();
    });

    it('lets a deleted row be imported again', async () => {
      const first = await call('finance.record_transaction', {
        account: 'Posting', occurredOn: '2026-08-29', amount: -3, description: 'PARKING',
      });
      await pool.query(`delete from finance.transactions where id = $1`, [first.id]);
      const staged = await call('finance.stage_import', {
        account: 'Posting', source: 'statement', rows: [{ date: '2026-08-29', amount: -3, description: 'PARKING' }],
      });
      expect(staged.summary).toMatchObject({ newRows: 1, duplicates: 0 });
    });

    it('discards a staging, after which it cannot be committed', async () => {
      const staged = await call('finance.stage_import', {
        account: 'Statements',
        source: 'statement',
        rows: [{ date: '2026-08-11', amount: -17, description: 'BOOKSHOP' }],
      });
      const discarded = await call('finance.discard_import', { stagingId: staged.stagingId });
      expect(discarded).toMatchObject({ discarded: true, rows: 1 });

      const message = await refusal('finance.commit_import', { stagingId: staged.stagingId });
      expect(message).toMatch(/unknown staging/);

      const { rows: none } = await pool.query(
        `select count(*)::int as n from finance.transactions where description = 'BOOKSHOP'`,
      );
      expect(none[0].n).toBe(0);
    });

    it('refuses a staging that has expired', async () => {
      const staged = await call('finance.stage_import', {
        account: 'Statements',
        source: 'statement',
        rows: [{ date: '2026-08-12', amount: -5, description: 'KIOSK' }],
      });
      await pool.query(
        `update finance.import_stagings set expires_at = now() - interval '1 minute' where id = $1`,
        [staged.stagingId],
      );
      const message = await refusal('finance.commit_import', { stagingId: staged.stagingId });
      expect(message).toMatch(/expired/);

      const { rows: none } = await pool.query(
        `select count(*)::int as n from finance.transactions where description = 'KIOSK'`,
      );
      expect(none[0].n).toBe(0);
    });

    describe('from a file', () => {
      const CSV_ID = '33333333-3333-4333-8333-333333333333';
      const JSON_ID = '44444444-4444-4444-8444-444444444444';
      const BAD_ID = '55555555-5555-4555-8555-555555555555';
      const files: Record<string, string> = {
        [CSV_ID]: [
          'Date,Amount,Description,Category,Balance,Reference',
          '2026-07-01,-3.20,"CAFE, THE CORNER",eating out,996.80,R1',
          '2026-07-02,-50,"SUPERMARKET ""BIO""",groceries,946.80,R2',
          '2026-07-03,1200,SALARY JULY,income,2146.80,R3',
        ].join('\r\n'),
        [JSON_ID]: JSON.stringify([
          { date: '2026-07-10', amount: -9.99, description: 'STREAMING', category: 'subscriptions' },
          { date: '2026-07-11', amount: -20, description: 'PHARMACY', status: 'pending' },
        ]),
        [BAD_ID]: 'date,amount,label\n2026-07-01,-3,CAFE\n',
      };
      const stage = (args: Record<string, unknown>) => {
        const host = createPluginHost(hostBindingOf(manifest), ctx);
        const read = async (id: string) => {
          const text = files[id];
          if (text === undefined) throw new Error(`There is no file ${id} that finance can read.`);
          return Buffer.from(text, 'utf8');
        };
        const input = stageImport.input!.parse({ account: 'File import', source: 'csv', ...args });
        return stageImport.execute(input, { ...ctx, buddi: { ...host, files: { ...host.files!, read } } } as any) as Promise<any>;
      };

      it('stages the rows of a CSV artifact, quoted commas included', async () => {
        const staged = await stage({ file: CSV_ID });
        expect(staged.summary).toMatchObject({ rows: 3, newRows: 3, totalIn: 1200, totalOut: -53.2 });
        const { rows } = await pool.query(
          `select rows, artifact_id from finance.import_stagings where id = $1`,
          [staged.stagingId],
        );
        expect(rows[0].artifact_id).toBe(CSV_ID);
        expect(rows[0].rows.map((r: any) => r.description)).toEqual([
          'CAFE, THE CORNER',
          'SUPERMARKET "BIO"',
          'SALARY JULY',
        ]);
      });

      it('stages the rows of a JSON artifact', async () => {
        const staged = await stage({ file: JSON_ID });
        expect(staged.summary).toMatchObject({ rows: 2, newRows: 2, pending: 1, totalOut: -29.99 });
      });

      it('refuses a file it cannot read, saying why and what header it saw', async () => {
        files[BAD_ID] = 'when,how much,what\nyesterday,lots,coffee\n';
        await expect(stage({ file: BAD_ID })).rejects.toThrow('could not read: no date column found in header: when,how much,what');
      });

      it('refuses a PDF handed in as a file, saying what to do instead', async () => {
        files[BAD_ID] = '%PDF-1.7\n%binary';
        await expect(stage({ file: BAD_ID })).rejects.toThrow(/could not read: this file is a PDF/);
      });

      it('stages what it can read and says what it left out', async () => {
        files[BAD_ID] = 'Date,Description,Amount\n09/02/2026,COFFEE,-3.50\nTotal,,-3.50\n09/03/2026,LUNCH,-12.00\n';
        const staged = await stage({ file: BAD_ID, account: 'Diagnostic' });
        expect(staged.summary).toMatchObject({ rows: 2, newRows: 2 });
        expect(staged.file).toMatchObject({ header: 'Date, Description, Amount', read: 2, rejected: 1 });
        expect(staged.file.reasons[0]).toMatch(/line 3: unparseable date "Total"/);
        expect(staged.note).toMatch(/1 line of the file could not be read/);
      });

      it('stages a PNC-style card export on the card, charges negative', async () => {
        await call('finance.set_liability', { name: 'PNC Mastercard', kind: 'credit_card', balance: 832.53, minimumPayment: 35, dueDay: 25 });
        files[BAD_ID] = readFileSync(new URL('../testing/fixtures/pnc-card.csv', import.meta.url), 'utf8');
        const staged = await stage({ file: BAD_ID, account: undefined, liability: 'PNC Mastercard' });
        expect(staged.liability).toBe('PNC Mastercard');
        expect(staged.summary).toMatchObject({ rows: 6, newRows: 6, totalIn: 523.45, totalOut: -1356.53 });
        expect(staged.file.notes.join(' ')).toMatch(/charges were positive in the file/);
      });

      it('stages a PNC-style checking export as the bank wrote it', async () => {
        files[BAD_ID] = readFileSync(new URL('../testing/fixtures/pnc-checking.csv', import.meta.url), 'utf8');
        const staged = await stage({ file: BAD_ID, account: 'PNC Spend' });
        expect(staged.summary).toMatchObject({ rows: 7, newRows: 7, totalIn: 3140.21, totalOut: -2322.52, dateRange: { from: '2026-09-02', to: '2026-09-30' } });
        expect(staged.file.rejected).toBe(0);
      });

      it('takes at most 200 rows inline, and rows or file but not both', () => {
        const row = { date: '2026-07-01', amount: -1, description: 'X' };
        const base = { account: 'A', source: 'manual' };
        expect(stageImport.input!.safeParse({ ...base, rows: Array(200).fill(row) }).success).toBe(true);
        expect(stageImport.input!.safeParse({ ...base, rows: Array(201).fill(row) }).success).toBe(false);
        expect(stageImport.input!.safeParse({ ...base, rows: [row], file: CSV_ID }).success).toBe(false);
        expect(stageImport.input!.safeParse(base).success).toBe(false);
      });
    });
  });
});
