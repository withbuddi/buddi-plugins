import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { parseAmount, parseBankCsv, parseCsvDate } from './csv.js';

const FRENCH = [
  'Date;Libellé;Montant',
  '13/09/2026;VIREMENT SALAIRE;3 200,00',
  '15/09/2026;"PRELEVEMENT EDF, CONTRAT 42";-89,90',
  '01/10/2026;LOYER;-1.200,50',
].join('\r\n');

const US = [
  'Date,Description,Amount',
  '2026-09-13,"ACME PAYROLL, INC",3200.00',
  '2026-09-15,Coffee Shop,-4.75',
  '09/20/2026,"Laptop, refurbished","-1,199.99"',
].join('\n');

const SPLIT = [
  'Booking date;Description;Debit;Credit',
  '13.09.2026;Salary;;3200,00',
  '15.09.2026;Rent;1200,00;',
  '16.09.2026;Refund;;12,30',
].join('\n');

describe('parseAmount', () => {
  it('handles both decimal conventions and grouping', () => {
    expect(parseAmount('1.234,56')).toBe(1234.56);
    expect(parseAmount('1,234.56')).toBe(1234.56);
    expect(parseAmount('-45,50')).toBe(-45.5);
    expect(parseAmount('3 200,00')).toBe(3200);
    expect(parseAmount('1,234')).toBe(1234);
    expect(parseAmount('12,3')).toBe(12.3);
    expect(parseAmount('(120.00)')).toBe(-120);
    expect(parseAmount('89,90 EUR')).toBe(89.9);
    expect(parseAmount('')).toBeUndefined();
    expect(parseAmount('n/a')).toBeUndefined();
  });
});

describe('parseCsvDate', () => {
  it('accepts ISO, slash and dot formats', () => {
    expect(parseCsvDate('2026-09-13')).toBe('2026-09-13');
    expect(parseCsvDate('13/09/2026')).toBe('2026-09-13');
    expect(parseCsvDate('13.09.2026')).toBe('2026-09-13');
    expect(parseCsvDate('09/20/2026')).toBe('2026-09-20'); // only MM/DD is possible
    expect(parseCsvDate('32/01/2026')).toBeUndefined();
    expect(parseCsvDate('not a date')).toBeUndefined();
  });
});

describe('parseBankCsv', () => {
  it('parses a French-style ; file with decimal commas', () => {
    const { rows, warnings } = parseBankCsv(FRENCH);
    expect(warnings).toEqual([]);
    expect(rows).toEqual([
      { date: '2026-09-13', amount: 3200, description: 'VIREMENT SALAIRE' },
      { date: '2026-09-15', amount: -89.9, description: 'PRELEVEMENT EDF, CONTRAT 42' },
      { date: '2026-10-01', amount: -1200.5, description: 'LOYER' },
    ]);
  });

  it('parses a US-style comma file with quoted fields', () => {
    const { rows, warnings } = parseBankCsv(US);
    expect(warnings).toEqual([]);
    expect(rows).toEqual([
      { date: '2026-09-13', amount: 3200, description: 'ACME PAYROLL, INC' },
      { date: '2026-09-15', amount: -4.75, description: 'Coffee Shop' },
      { date: '2026-09-20', amount: -1199.99, description: 'Laptop, refurbished' },
    ]);
  });

  it('parses a debit/credit split file into signed amounts', () => {
    const { rows, warnings } = parseBankCsv(SPLIT);
    expect(warnings).toEqual([]);
    expect(rows).toEqual([
      { date: '2026-09-13', amount: 3200, description: 'Salary' },
      { date: '2026-09-15', amount: -1200, description: 'Rent' },
      { date: '2026-09-16', amount: 12.3, description: 'Refund' },
    ]);
  });

  it('warns about unparseable rows instead of throwing', () => {
    const { rows, warnings } = parseBankCsv(
      ['Date;Libellé;Montant', 'nope;BAD DATE;10,00', '13/09/2026;NO AMOUNT;', '14/09/2026;OK;5,00'].join(
        '\n',
      ),
    );
    expect(rows).toEqual([{ date: '2026-09-14', amount: 5, description: 'OK' }]);
    expect(warnings).toHaveLength(2);
    expect(warnings[0]).toMatch(/line 2: unparseable date/);
    expect(warnings[1]).toMatch(/line 3: unparseable amount/);
  });

  it('reports a missing column set rather than inventing data', () => {
    const { rows, warnings } = parseBankCsv('foo;bar\n1;2');
    expect(rows).toEqual([]);
    expect(warnings[0]).toMatch(/no date column/);
  });

  it('tolerates a BOM, CRLF line endings and blank lines', () => {
    const { rows, warnings } = parseBankCsv(
      '﻿Date,Description,Amount\r\n2026-09-13,Salary,10.00\r\n\r\n',
    );
    expect(warnings).toEqual([]);
    expect(rows).toEqual([{ date: '2026-09-13', amount: 10, description: 'Salary' }]);
  });

  it("carries the bank's own category column through", () => {
    const { rows, warnings } = parseBankCsv(
      [
        'date,amount,description,category',
        '2026-09-11,-20.56,Amazon Marketplace,General Merchandise',
        '2026-09-10,1000.00,Transfer from Zelle,Transfers',
        '2026-09-09,-4.25,Corner shop,',
      ].join('\n'),
    );
    expect(warnings).toEqual([]);
    expect(rows).toEqual([
      {
        date: '2026-09-11',
        amount: -20.56,
        description: 'Amazon Marketplace',
        category: 'General Merchandise',
      },
      {
        date: '2026-09-10',
        amount: 1000,
        description: 'Transfer from Zelle',
        category: 'Transfers',
      },
      { date: '2026-09-09', amount: -4.25, description: 'Corner shop' },
    ]);
  });

  it('does not mistake the category column for the description', () => {
    const { rows } = parseBankCsv('Date,Category,Amount,Memo\n2026-09-13,Groceries,-9.99,Bakery');
    expect(rows).toEqual([
      { date: '2026-09-13', amount: -9.99, description: 'Bakery', category: 'Groceries' },
    ]);
  });

  it('keeps identical rows instead of collapsing them', () => {
    const { rows } = parseBankCsv(
      [
        'date,amount,description',
        '2026-08-31,1000.00,Transfer from Zelle',
        '2026-08-31,1000.00,Transfer from Zelle',
        '2026-08-31,1000.00,Transfer from Zelle',
      ].join('\n'),
    );
    expect(rows).toHaveLength(3);
  });
});

describe('pending markers', () => {
  it('reads a status column that says pending', () => {
    const { rows } = parseBankCsv(
      [
        'Date,Description,Amount,Status',
        '2026-09-12,LIDL,-42.50,Pending',
        '2026-09-10,MONOPRIX,-20.00,Posted',
      ].join('\n'),
    );
    expect(rows[0]).toMatchObject({ description: 'LIDL', status: 'pending' });
    expect(rows[1]?.status).toBeUndefined();
  });

  it('reads a PENDING marker written into the date column', () => {
    const { rows } = parseBankCsv(
      ['date,amount,description', '2026-09-12 PENDING,-42.50,LIDL'].join('\n'),
    );
    expect(rows).toEqual([
      { date: '2026-09-12', amount: -42.5, description: 'LIDL', status: 'pending' },
    ]);
  });

  it('recognises the other wordings banks use', () => {
    const { rows } = parseBankCsv(
      [
        'Date,Libelle,Montant,Statut',
        '12/09/2026,LIDL,-42.50,En attente',
        '11/09/2026,FNAC,-55.00,Autorisation',
        '10/09/2026,SPAR,-5.00,Comptabilise',
      ].join('\n'),
    );
    expect(rows.map((r) => r.status)).toEqual(['pending', 'pending', undefined]);
  });

  it('does not read the status column as the description', () => {
    const { rows } = parseBankCsv(
      ['Date,Status,Amount,Memo', '2026-09-13,Pending,-9.99,Bakery'].join('\n'),
    );
    expect(rows[0]).toMatchObject({ description: 'Bakery', status: 'pending' });
  });
});

describe('US bank and card exports (PNC-style, synthetic)', () => {
  const fixture = (name: string): string => readFileSync(new URL(`./testing/fixtures/${name}`, import.meta.url), 'utf8');

  it('reads a checking export: summary line above the header, Withdrawals/Deposits, $ amounts, month-first dates', () => {
    const { rows, warnings, header, notes } = parseBankCsv(fixture('pnc-checking.csv'));
    expect(warnings).toEqual([]);
    expect(header).toEqual(['Date', 'Description', 'Withdrawals', 'Deposits', 'Category', 'Balance']);
    expect(notes).toContain('skipped 1 line above the header');
    expect(notes).toContain('dates read as month/day/year');
    expect(rows).toHaveLength(7);
    expect(rows[0]).toEqual({ date: '2026-09-02', amount: -54.12, description: "DEBIT CARD PURCHASE XXXXX1234 TRADER JOE'S #552 PITTSBURGH PA", category: 'Groceries' });
    expect(rows[1]).toMatchObject({ date: '2026-09-03', amount: 3100 });
    expect(rows[5]).toMatchObject({ date: '2026-09-15', amount: -1650, description: 'CHECK 1042' });
    expect(rows[6]).toMatchObject({ date: '2026-09-30', amount: 0.21 });
  });

  it('reads a card export into the card ledger: positive charges flipped, parenthesised payments positive', () => {
    const { rows, warnings, notes } = parseBankCsv(fixture('pnc-card.csv'), { ledger: 'liability' });
    expect(warnings).toEqual([]);
    expect(notes.join(' ')).toMatch(/charges were positive in the file/);
    expect(rows.map((r) => [r.date, r.amount])).toEqual([
      ['2026-09-01', -23.45],
      ['2026-09-04', -87.1],
      ['2026-09-05', 500],
      ['2026-09-09', -41.88],
      ['2026-09-18', -1204.1],
      ['2026-09-20', 23.45],
    ]);
    expect(rows[2]?.description).toBe('ONLINE PAYMENT - THANK YOU');
  });

  it('leaves a card file already signed the ledger way alone', () => {
    const { rows, notes } = parseBankCsv('date,amount,description\n2026-09-01,-20.00,SHOP\n2026-09-02,-5.00,CAFE\n2026-09-05,300.00,PAYMENT THANK YOU', { ledger: 'liability' });
    expect(rows.map((r) => r.amount)).toEqual([-20, -5, 300]);
    expect(notes.join(' ')).not.toMatch(/flipped/);
  });

  it('never flips a cash account', () => {
    const { rows } = parseBankCsv(fixture('pnc-card.csv'));
    expect(rows[0]?.amount).toBe(23.45);
  });

  it('reads a card export with Debit and Credit columns: a charge is negative', () => {
    const { rows } = parseBankCsv('Transaction Date,Description,Debit,Credit\n10/01/2026,NETFLIX,15.49,\n10/03/2026,PAYMENT,,200.00', { ledger: 'liability' });
    expect(rows.map((r) => r.amount)).toEqual([-15.49, 200]);
  });

  it('reads a headerless export with a DEBIT/CREDIT column by what the columns hold', () => {
    const { rows, notes } = parseBankCsv(
      ['2026/09/03,45.67,"POS PURCHASE GIANT EAGLE",,REF1001,DEBIT', '2026/09/04,1200.00,"DIRECT DEPOSIT ACME",,REF1002,CREDIT'].join('\n'),
    );
    expect(notes).toContain('no header row: columns found by what they hold');
    expect(rows).toEqual([
      { date: '2026-09-03', amount: -45.67, description: 'POS PURCHASE GIANT EAGLE' },
      { date: '2026-09-04', amount: 1200, description: 'DIRECT DEPOSIT ACME' },
    ]);
  });

  it('takes a Debit/Credit indicator column for the sign only when the amounts carry none', () => {
    const { rows } = parseBankCsv('Date,Description,Amount,Debit/Credit\n09/03/2026,GROCER,45.67,Debit\n09/04/2026,SALARY,1200.00,Credit');
    expect(rows.map((r) => r.amount)).toEqual([-45.67, 1200]);
  });

  it('reads an ambiguous date the owner’s way, and the file’s way once one date settles it', () => {
    expect(parseBankCsv('Date,Description,Amount\n03/04/2026,X,-1', { dateOrder: 'mdy' }).rows[0]?.date).toBe('2026-03-04');
    expect(parseBankCsv('Date,Description,Amount\n03/04/2026,X,-1', { dateOrder: 'dmy' }).rows[0]?.date).toBe('2026-04-03');
    expect(parseBankCsv('Date,Description,Amount\n03/04/2026,X,-1\n03/25/2026,Y,-2', { dateOrder: 'dmy' }).rows[0]?.date).toBe('2026-03-04');
    // A dollar sign is a month-first hint when nothing else says.
    expect(parseBankCsv('Date,Description,Amount\n03/04/2026,X,$-1.00').rows[0]?.date).toBe('2026-03-04');
  });

  it('counts the rows it leaves out, with the header it saw', () => {
    const out = parseBankCsv('Date,Description,Amount\n09/02/2026,OK,$1.00\nTotal,,$1.00\n09/03/2026,BAD,n/a');
    expect(out.rows).toHaveLength(1);
    expect(out.rejected).toBe(2);
    expect(out.header).toEqual(['Date', 'Description', 'Amount']);
    expect(out.warnings[0]).toMatch(/line 3: unparseable date "Total"/);
  });
});

describe('parseAmount, US styles', () => {
  it('reads dollar signs, parentheses on either side of the sign, and CR/DR', () => {
    expect(parseAmount('$1,234.56')).toBe(1234.56);
    expect(parseAmount('-$45.00')).toBe(-45);
    expect(parseAmount('$-45.00')).toBe(-45);
    expect(parseAmount('($500.00)')).toBe(-500);
    expect(parseAmount('$(500.00)')).toBe(-500);
    expect(parseAmount('45.00 CR')).toBe(45);
    expect(parseAmount('12.00 DR')).toBe(-12);
    expect(parseAmount('USD 9.99')).toBe(9.99);
  });

  it('reads named-month dates', () => {
    expect(parseCsvDate('Sep 3, 2026')).toBe('2026-09-03');
    expect(parseCsvDate('3 Sep 2026')).toBe('2026-09-03');
    expect(parseCsvDate('2026/09/03')).toBe('2026-09-03');
  });
});
