/**
 * Bank CSV parsing. CSV drop is the primary v1 intake, so the parser is
 * deliberately forgiving: it sniffs the delimiter, matches columns by header
 * name across a few locales, carries the bank's own category column through
 * when there is one, accepts dot and comma decimals, and reports
 * unparseable rows as warnings instead of throwing away the whole file.
 */

export interface BankCsvRow {
  /** `YYYY-MM-DD`. */
  date: string;
  /** Signed: positive = money in, negative = money out. */
  amount: number;
  description: string;
  /** The bank's own category, when the export carries one. */
  category?: string;
  /**
   * 'pending' when the export marks the row as an unsettled authorisation —
   * either in its own status column or as a marker written into the date
   * column ('PENDING', '09/12/2026 PENDING'). Absent means posted.
   */
  status?: 'pending' | 'posted';
}

export interface BankCsvResult {
  rows: BankCsvRow[];
  /** One sentence per row left out, and the reason a whole file could not be read. */
  warnings: string[];
  /** The header row as the file wrote it; empty when there is none. */
  header: string[];
  /** How many data rows were left out. */
  rejected: number;
  /** What the parser decided on the file's behalf, in words: "dates read as month/day", "charges flipped". */
  notes: string[];
  /** True when the whole file is unreadable: no date column, no amount, nothing to go on. */
  unreadable?: true;
}

export interface BankCsvOptions {
  /**
   * The ledger the rows go to. On a card (`liability`) a charge is negative;
   * a card export that writes charges positive is flipped.
   */
  ledger?: 'account' | 'liability';
  /** How to read 03/04/2026 when no date in the file settles it: `mdy` for a US owner. */
  dateOrder?: 'dmy' | 'mdy';
}

const DELIMITERS = [';', ',', '\t', '|'] as const;

const DATE_HEADERS = [
  'date',
  'datum',
  'date_op',
  'dateop',
  'bookingdate',
  'booking date',
  'transactiondate',
  'transaction date',
  'valuedate',
  'value date',
  'dateoperation',
  "dated'operation",
  'dateofvaleur',
  'postingdate',
  'posted date',
];
const AMOUNT_HEADERS = ['amount', 'transaction amount', 'montant', 'betrag', 'value', 'sum', 'somme', 'importe'];
const DEBIT_HEADERS = ['debit', 'debits', 'withdrawal', 'withdrawals', 'charges', 'sortie', 'sorties', 'soll', 'paid out', 'money out'];
const CREDIT_HEADERS = ['credit', 'credits', 'deposit', 'deposits', 'payments', 'entree', 'entrees', 'haben', 'paid in', 'money in'];
/** A column saying which way a positive amount goes: DEBIT/CREDIT, DR/CR, Sale/Payment. */
const INDICATOR_HEADERS = ['debit/credit', 'credit/debit', 'dr/cr', 'cr/dr', 'debitcredit', 'creditdebit', 'transaction type', 'type', 'indicator'];
/** Columns that look like money but never are the line's amount. */
const BALANCE_HEADERS = ['balance', 'running balance', 'solde', 'saldo', 'kontostand'];
const CATEGORY_HEADERS = [
  'category',
  'categorie',
  'kategorie',
  'categoria',
  'rubrique',
  'classification',
];
const STATUS_HEADERS = [
  'status',
  'statut',
  'state',
  'etat',
  'transactionstatus',
  'transaction status',
  'postingstatus',
];
const DESCRIPTION_HEADERS = [
  'description',
  'libelle',
  'label',
  'memo',
  'details',
  'detail',
  'narrative',
  'payee',
  'wording',
  'verwendungszweck',
  'buchungstext',
  'reference',
  'nature',
  'merchant',
  'name',
  'transaction',
];

/**
 * How a bank says "this has not settled yet". Matched against the status
 * column and against the date cell, because plenty of exports write the marker
 * where the date belongs and leave the real date to a second column.
 */
const PENDING_RE =
  /(pending|en\s*attente|autoris|authoriz|unposted|not\s*posted|processing|on\s*hold)/i;

/** True when a cell carries a pending marker. */
export function isPendingMarker(raw: string): boolean {
  return PENDING_RE.test(raw);
}

/** Lowercase, strip accents/BOM/punctuation so 'Libellé' matches 'libelle'. */
function normalizeHeader(h: string): string {
  return h
    .replace(/^\ufeff/, '')
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .replace(/["']/g, '')
    .replace(/[_\-.]+/g, '')
    .trim();
}

function matchHeader(
  headers: string[],
  candidates: string[],
  exclude: ReadonlySet<number> = new Set(),
): number {
  const norm = headers.map(normalizeHeader);
  const wanted = candidates.map((c) => normalizeHeader(c));
  const ok = (i: number): boolean => i !== -1 && !exclude.has(i);
  for (const w of wanted) {
    const exact = norm.findIndex((h, i) => h === w && !exclude.has(i));
    if (ok(exact)) return exact;
  }
  for (const w of wanted) {
    const partial = norm.findIndex(
      (h, i) => h.length > 0 && !exclude.has(i) && (h.includes(w) || w.includes(h)),
    );
    if (ok(partial)) return partial;
  }
  return -1;
}

function countOutsideQuotes(line: string, delimiter: string): number {
  let count = 0;
  let quoted = false;
  for (let i = 0; i < line.length; i += 1) {
    const ch = line[i];
    if (ch === '"') quoted = !quoted;
    else if (!quoted && ch === delimiter) count += 1;
  }
  return count;
}

/** Words that say a positive amount is money out, or money in, in an indicator column. */
const OUT_WORDS = /^(debit|dr|d|sale|purchase|withdrawal|charge|fee|interest|debit card|pos)$/i;
const IN_WORDS = /^(credit|cr|c|payment|deposit|return|refund|adjustment|credit adjustment)$/i;
/** A card line that pays the card down, whatever sign the export gave it. */
const CARD_PAYMENT_RE = /\b(payment|pymt|thank\s*you|autopay|auto\s*pay|refund|return|credit)\b/i;

/**
 * Parse an amount written in any of the common bank styles:
 * `1.234,56`, `1,234.56`, `-45,50`, `(120.00)`, `1 234,56 EUR`, `+ 90`,
 * `$1,234.56`, `-$45.00`, `$(500.00)`, `45.00 CR`, `12.00 DR`.
 */
export function parseAmount(raw: string): number | undefined {
  let s = raw.trim();
  if (s === '') return undefined;
  let negative = false;
  // A trailing CR / DR says the direction outright: credit in, debit out.
  const marker = /\s*\b(CR|DR)\.?$/i.exec(s);
  let forced: 'in' | 'out' | undefined;
  if (marker) {
    forced = marker[1]!.toUpperCase() === 'CR' ? 'in' : 'out';
    s = s.slice(0, marker.index).trim();
  }
  // Drop currency symbols/codes and grouping spaces (incl. NBSP/narrow NBSP), keep parentheses.
  s = s.replace(/\s/g, '').replace(/[^\d.,+\-()]/g, '');
  if (s.startsWith('-')) {
    negative = !negative;
    s = s.slice(1);
  } else if (s.startsWith('+')) s = s.slice(1);
  if (/^\(.*\)$/.test(s)) {
    negative = !negative;
    s = s.slice(1, -1);
  }
  if (s.startsWith('-')) {
    negative = !negative;
    s = s.slice(1);
  }
  if (s.endsWith('-')) {
    negative = !negative;
    s = s.slice(0, -1);
  }
  if (s === '' || /[^\d.,]/.test(s) || !/\d/.test(s)) return undefined;

  const lastComma = s.lastIndexOf(',');
  const lastDot = s.lastIndexOf('.');
  if (lastComma !== -1 && lastDot !== -1) {
    // Whichever comes last is the decimal separator.
    if (lastComma > lastDot) s = s.replace(/\./g, '').replace(',', '.');
    else s = s.replace(/,/g, '');
  } else if (lastComma !== -1) {
    const decimals = s.length - lastComma - 1;
    // "1,234" is grouping; "45,5" and "45,50" are decimals.
    s = decimals === 3 && s.indexOf(',') === lastComma && lastComma > 0 && /^\d{1,3}$/.test(s.slice(0, lastComma))
      ? s.replace(/,/g, '')
      : s.replace(/,/g, '.');
  }
  if (s.split('.').length > 2) s = s.replace(/\.(?=.*\.)/g, '');

  const n = Number(s);
  if (!Number.isFinite(n)) return undefined;
  if (forced === 'in') return Math.abs(n);
  if (forced === 'out') return -Math.abs(n);
  return negative ? -n : n;
}

const MONTH_NAMES = ['jan', 'feb', 'mar', 'apr', 'may', 'jun', 'jul', 'aug', 'sep', 'oct', 'nov', 'dec'];

/**
 * Parse `YYYY-MM-DD` (or `YYYY/MM/DD`), `DD/MM/YYYY`, `DD.MM.YYYY`, `MM/DD/YYYY`,
 * `Sep 3, 2026` and `3 Sep 2026`. A slash date both ways could read is taken
 * in `order` (day first unless told otherwise); one only one way can read is
 * read that way.
 */
export function parseCsvDate(raw: string, order: 'dmy' | 'mdy' = 'dmy'): string | undefined {
  const s = raw.trim();
  if (s === '') return undefined;

  const iso = /^(\d{4})[-/.](\d{1,2})[-/.](\d{1,2})/.exec(s);
  if (iso) return build(Number(iso[1]), Number(iso[2]), Number(iso[3]));

  const parts = /^(\d{1,2})[/.\-](\d{1,2})[/.\-](\d{2,4})(?:\s+\d{1,2}:\d{2}(?::\d{2})?(?:\s*[AP]M)?)?$/i.exec(s);
  if (parts) {
    const a = Number(parts[1]);
    const b = Number(parts[2]);
    let year = Number(parts[3]);
    if (year < 100) year += year >= 70 ? 1900 : 2000;
    if (a > 12 && b <= 12) return build(year, b, a);
    if (b > 12 && a <= 12) return build(year, a, b);
    return order === 'mdy' ? build(year, a, b) : build(year, b, a);
  }

  const named = /^(?:(\d{1,2})\s+([A-Za-z]{3,})\.?|([A-Za-z]{3,})\.?\s+(\d{1,2}),?)\s+(\d{4})$/.exec(s);
  if (named) {
    const month = MONTH_NAMES.indexOf((named[2] ?? named[3] ?? '').slice(0, 3).toLowerCase());
    if (month === -1) return undefined;
    return build(Number(named[5]), month + 1, Number(named[1] ?? named[4]));
  }
  return undefined;

  function build(y: number, m: number, d: number): string | undefined {
    if (m < 1 || m > 12 || d < 1 || d > 31) return undefined;
    const dt = new Date(Date.UTC(y, m - 1, d));
    if (dt.getUTCFullYear() !== y || dt.getUTCMonth() !== m - 1 || dt.getUTCDate() !== d) {
      return undefined;
    }
    return dt.toISOString().slice(0, 10);
  }
}

/**
 * Which way the file's slash dates read: `dmy` once one date can only be
 * day-first, `mdy` once one can only be month-first; undefined when none
 * settles it (or the file contradicts itself).
 */
export function sniffDateOrder(cells: readonly string[]): 'dmy' | 'mdy' | undefined {
  let dmy = false;
  let mdy = false;
  for (const cell of cells) {
    const parts = /^(\d{1,2})[/.\-](\d{1,2})[/.\-]\d{2,4}/.exec(cell.trim());
    if (!parts) continue;
    const a = Number(parts[1]);
    const b = Number(parts[2]);
    if (a > 12 && b <= 12) dmy = true;
    if (b > 12 && a <= 12) mdy = true;
  }
  if (dmy === mdy) return undefined;
  return dmy ? 'dmy' : 'mdy';
}

/** Split text into records on `delimiter`, honouring "" quoting and line breaks inside quotes. */
function splitRecords(text: string, delimiter: string): string[][] {
  const records: string[][] = [];
  let record: string[] = [];
  let field = '';
  let quoted = false;
  const end = (): void => {
    record.push(field.trim());
    field = '';
    if (!(record.length === 1 && record[0] === '')) records.push(record);
    record = [];
  };
  for (let i = 0; i < text.length; i += 1) {
    const ch = text[i];
    if (quoted) {
      if (ch === '"') {
        if (text[i + 1] === '"') {
          field += '"';
          i += 1;
        } else quoted = false;
      } else field += ch;
      continue;
    }
    if (ch === '"') quoted = true;
    else if (ch === delimiter) {
      record.push(field.trim());
      field = '';
    } else if (ch === '\r') {
      if (text[i + 1] === '\n') i += 1;
      end();
    } else if (ch === '\n') end();
    else field += ch;
  }
  if (field !== '' || record.length > 0) end();
  return records;
}

/** The delimiter the first lines agree on most. */
function detectDelimiterIn(lines: readonly string[]): string {
  let best: string = ',';
  let bestCount = 0;
  for (const d of DELIMITERS) {
    const c = lines.reduce((sum, line) => sum + countOutsideQuotes(line, d), 0);
    if (c > bestCount) {
      best = d;
      bestCount = c;
    }
  }
  return best;
}

/** How many leading lines a header may sit under: an account summary, a title, a blank. */
const HEADER_SEARCH = 15;

interface Columns {
  date: number;
  amount: number;
  debit: number;
  credit: number;
  indicator: number;
  category: number;
  status: number;
  description: number;
}

function columnsFrom(headers: string[]): Columns {
  const taken = new Set<number>();
  const take = (candidates: string[]): number => {
    const i = matchHeader(headers, candidates, taken);
    if (i !== -1) taken.add(i);
    return i;
  };
  const date = take(DATE_HEADERS);
  // Running balances are set aside first: a "Balance" column is never the line's amount.
  take(BALANCE_HEADERS);
  // An indicator ("Debit/Credit") before the split, so it is not read as a debit column.
  const indicator = (() => {
    const norm = headers.map(normalizeHeader);
    const i = norm.findIndex((h, at) => !taken.has(at) && INDICATOR_HEADERS.map(normalizeHeader).includes(h));
    if (i !== -1) taken.add(i);
    return i;
  })();
  const amount = take(AMOUNT_HEADERS);
  const debit = take(DEBIT_HEADERS);
  const credit = take(CREDIT_HEADERS);
  // Category and status before description, so neither is read as the free text.
  const category = take(CATEGORY_HEADERS);
  const status = take(STATUS_HEADERS);
  const description = take(DESCRIPTION_HEADERS);
  return { date, amount, debit, credit, indicator, category, status, description };
}

/** A file with no header at all (PNC's older download): find the columns by what they hold. */
function columnsByContent(records: string[][]): Columns | undefined {
  const width = Math.max(...records.map((r) => r.length));
  const share = (col: number, test: (cell: string) => boolean): number => {
    const cells = records.map((r) => r[col] ?? '').filter((c) => c !== '');
    return cells.length === 0 ? 0 : cells.filter(test).length / records.length;
  };
  let date = -1;
  for (let c = 0; c < width && date === -1; c += 1) if (share(c, (x) => parseCsvDate(x, 'mdy') !== undefined) >= 0.8) date = c;
  if (date === -1) return undefined;
  let amount = -1;
  for (let c = 0; c < width && amount === -1; c += 1) {
    if (c !== date && share(c, (x) => /\d/.test(x) && parseAmount(x) !== undefined && parseCsvDate(x, 'mdy') === undefined) >= 0.8) amount = c;
  }
  if (amount === -1) return undefined;
  let indicator = -1;
  for (let c = 0; c < width && indicator === -1; c += 1) {
    if (c !== date && c !== amount && share(c, (x) => OUT_WORDS.test(x) || IN_WORDS.test(x)) >= 0.8) indicator = c;
  }
  let description = -1;
  let longest = 0;
  for (let c = 0; c < width; c += 1) {
    if (c === date || c === amount || c === indicator) continue;
    const length = records.reduce((sum, r) => sum + (/[A-Za-z]/.test(r[c] ?? '') ? (r[c] ?? '').length : 0), 0);
    if (length > longest) {
      longest = length;
      description = c;
    }
  }
  return { date, amount, debit: -1, credit: -1, indicator, category: -1, status: -1, description };
}

function result(partial: Partial<BankCsvResult> & Pick<BankCsvResult, 'rows' | 'warnings'>): BankCsvResult {
  return { header: [], rejected: 0, notes: [], ...partial };
}

export function parseBankCsv(text: string, options: BankCsvOptions = {}): BankCsvResult {
  const clean = text.replace(/^﻿/, '');
  const firstLines = clean.split(/\r\n|\n|\r/).filter((l) => l.trim() !== '').slice(0, HEADER_SEARCH);
  if (firstLines.length === 0) {
    return result({ rows: [], warnings: ['empty file: no header row'], unreadable: true });
  }
  const delimiter = detectDelimiterIn(firstLines);
  const records = splitRecords(clean, delimiter).filter((r) => r.some((c) => c !== ''));
  const notes: string[] = [];

  // The header is the first of the leading lines naming a date and an amount
  // (or a debit/credit pair): lines above it are an account summary or a title.
  let headerAt = -1;
  let cols: Columns | undefined;
  for (let i = 0; i < Math.min(records.length, HEADER_SEARCH); i += 1) {
    const found = columnsFrom(records[i]!);
    if (found.date !== -1 && (found.amount !== -1 || found.debit !== -1 || found.credit !== -1)) {
      headerAt = i;
      cols = found;
      break;
    }
  }
  let header: string[] = [];
  let data: string[][];
  if (cols) {
    header = records[headerAt]!;
    data = records.slice(headerAt + 1);
    if (headerAt > 0) notes.push(`skipped ${headerAt} line${headerAt === 1 ? '' : 's'} above the header`);
  } else {
    const first = records[0] ?? [];
    const byContent = columnsByContent(records);
    if (!byContent) {
      const named = columnsFrom(first);
      const why = named.date === -1
        ? `no date column found in header: ${first.join(delimiter)}`
        : `no amount (or debit/credit) column found in header: ${first.join(delimiter)}`;
      return result({ rows: [], warnings: [why], header: first, unreadable: true });
    }
    cols = byContent;
    data = records;
    notes.push('no header row: columns found by what they hold');
  }
  const c = cols;
  const at = (fields: string[], idx: number): string => (idx >= 0 ? fields[idx] ?? '' : '');
  const lineNo = (i: number): number => i + (header.length > 0 ? headerAt + 2 : 1);

  // Which way the slash dates read, settled once for the whole file.
  const dateCells = data.map((f) => at(f, c.date));
  const sniffed = sniffDateOrder(dateCells);
  const order = sniffed ?? options.dateOrder ?? (data.some((f) => /\$/.test(at(f, c.amount) + at(f, c.debit) + at(f, c.credit))) ? 'mdy' : 'dmy');
  if (dateCells.some((d) => /^\d{1,2}[/.\-]\d{1,2}[/.\-]\d{2,4}/.test(d.trim()))) {
    notes.push(order === 'mdy' ? 'dates read as month/day/year' : 'dates read as day/month/year');
  }

  const warnings: string[] = [];
  const parsed: Array<BankCsvRow & { indicator?: string }> = [];
  const hasSplit = c.debit !== -1 || c.credit !== -1;
  data.forEach((fields, i) => {
    const rawDate = at(fields, c.date);
    const pending = isPendingMarker(rawDate) || isPendingMarker(at(fields, c.status));
    const dateCell = isPendingMarker(rawDate)
      ? rawDate.replace(PENDING_RE, ' ').replace(/[()[\]]/g, ' ').trim()
      : rawDate;
    const date = parseCsvDate(dateCell, order);
    if (date === undefined) {
      warnings.push(`line ${lineNo(i)}: unparseable date ${JSON.stringify(rawDate)} — skipped`);
      return;
    }
    let amount: number | undefined;
    if (c.amount !== -1 && at(fields, c.amount) !== '') {
      amount = parseAmount(at(fields, c.amount));
    } else if (hasSplit) {
      const debit = parseAmount(at(fields, c.debit)) ?? 0;
      const credit = parseAmount(at(fields, c.credit)) ?? 0;
      if (at(fields, c.debit) === '' && at(fields, c.credit) === '') amount = undefined;
      else amount = Math.abs(credit) - Math.abs(debit);
    }
    if (amount === undefined || !Number.isFinite(amount)) {
      warnings.push(`line ${lineNo(i)}: unparseable amount in ${JSON.stringify(fields.join(delimiter))} — skipped`);
      return;
    }
    const category = at(fields, c.category);
    const indicator = at(fields, c.indicator);
    parsed.push({
      date,
      amount: Math.round(amount * 100) / 100,
      description: at(fields, c.description) || '(no description)',
      ...(category === '' ? {} : { category }),
      ...(pending ? { status: 'pending' as const } : {}),
      ...(indicator === '' ? {} : { indicator }),
    });
  });

  // An indicator column gives the direction only where the amounts carry none.
  const signed = !hasSplit && parsed.some((r) => r.amount < 0);
  if (c.indicator !== -1 && !hasSplit && !signed && parsed.some((r) => r.indicator && (OUT_WORDS.test(r.indicator) || IN_WORDS.test(r.indicator)))) {
    for (const r of parsed) {
      if (r.indicator && OUT_WORDS.test(r.indicator)) r.amount = -Math.abs(r.amount);
      else if (r.indicator && IN_WORDS.test(r.indicator)) r.amount = Math.abs(r.amount);
    }
    notes.push(`signs taken from the ${header[c.indicator] ? `"${header[c.indicator]}"` : 'debit/credit'} column`);
  } else if (options.ledger === 'liability' && !hasSplit && parsed.length > 0 && chargesPositive(parsed)) {
    // A card export writes a charge as a positive amount; on the card a charge is negative.
    for (const r of parsed) r.amount = r.amount === 0 ? 0 : -r.amount;
    notes.push('charges were positive in the file, as card exports write them: flipped so a charge is negative on the card');
  }

  const rows: BankCsvRow[] = parsed.map(({ indicator: _drop, ...row }) => row);
  return { rows, warnings, header, rejected: warnings.length, notes };
}

/**
 * Does this card export write charges as positive amounts? Its payments say:
 * a payment written negative means charges are positive. With no payment in
 * the file, most lines positive means the same.
 */
function chargesPositive(rows: readonly BankCsvRow[]): boolean {
  const payments = rows.filter((r) => CARD_PAYMENT_RE.test(r.description));
  if (payments.length > 0) return payments.filter((r) => r.amount < 0).length > payments.length / 2;
  return rows.filter((r) => r.amount > 0).length > rows.length / 2;
}
