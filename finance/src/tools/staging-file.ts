/**
 * Rows for `finance.stage_import`, read from a file instead of typed inline.
 *
 * A statement of a few hundred lines is too long to write out as tool
 * arguments: the reply hits the model's output limit part-way through the call.
 * So the rows come from a file in the Files library — the CSV the owner
 * dropped, as the bank exported it, or rows the agent saved as a JSON array.
 *
 * A CSV goes through the same forgiving reader as every bank export
 * (`csv.ts`): headers in several languages or none, a summary above the
 * header, `$1,234.56` and `(500.00)`, debit/credit columns, month-first dates,
 * a card export's positive charges. What it decides is said back
 * (`FileDiagnostic.notes`), and every row it leaves out is counted with its
 * reason, so the owner hears what was read and what was not before anything
 * is committed. A file it cannot read at all is refused with why.
 */
import type { z } from 'zod';
import { parseBankCsv, type BankCsvOptions } from '../csv.js';

/** Rows one file may hold. Well past a year of statements for one account. */
export const MAX_FILE_ROWS = 5000;

/** How many bad rows a refusal names before it stops listing. */
const MAX_REPORTED = 5;

/**
 * Split CSV text into records. Handles quoted fields, commas and line breaks
 * inside quotes, and `""` as an escaped quote. Blank lines are dropped.
 */
export function parseCsvRecords(text: string): string[][] {
  const records: string[][] = [];
  let record: string[] = [];
  let field = '';
  let quoted = false;
  const src = text.replace(/^﻿/, '');
  const endRecord = (): void => {
    record.push(field);
    field = '';
    if (!(record.length === 1 && record[0]!.trim() === '')) records.push(record);
    record = [];
  };
  for (let i = 0; i < src.length; i += 1) {
    const ch = src[i];
    if (quoted) {
      if (ch === '"') {
        if (src[i + 1] === '"') {
          field += '"';
          i += 1;
        } else quoted = false;
      } else field += ch;
      continue;
    }
    if (ch === '"') quoted = true;
    else if (ch === ',') {
      record.push(field);
      field = '';
    } else if (ch === '\r') {
      if (src[i + 1] === '\n') i += 1;
      endRecord();
    } else if (ch === '\n') endRecord();
    else field += ch;
  }
  if (field !== '' || record.length > 0) endRecord();
  return records;
}

/** What reading a file decided, and what it left out. */
export interface FileDiagnostic {
  /** The header row as the file wrote it. */
  header: string;
  /** Rows read. */
  read: number;
  /** Rows left out. */
  rejected: number;
  /** The first three reasons. */
  reasons: string[];
  /** What the reader decided on the file's behalf: "dates read as month/day/year". */
  notes: string[];
}

/** CSV text to row objects, before the schema sees them. Throws "could not read: …". */
function csvRows(text: string, options: BankCsvOptions): { raw: { row: Record<string, unknown>; label: string }[]; diagnostic: FileDiagnostic } {
  const parsed = parseBankCsv(text, options);
  const header = parsed.header.join(', ');
  if (parsed.unreadable || parsed.rows.length === 0) {
    const why = parsed.unreadable
      ? parsed.warnings[0] ?? 'nothing in it looks like a statement'
      : parsed.warnings.length > 0
        ? `none of its ${parsed.warnings.length} rows could be read (${parsed.warnings.slice(0, 3).join('; ')})`
        : 'it has a header row but no rows';
    throw new Error(`could not read: ${why}.${header && !why.includes(header) ? ` The header row reads: ${header}.` : ''} It needs a date and an amount (or debit and credit columns) on every line.`);
  }
  return {
    raw: parsed.rows.map((row, i) => ({ row: { ...row }, label: `row ${i + 1}` })),
    diagnostic: { header, read: parsed.rows.length, rejected: parsed.rejected, reasons: parsed.warnings.slice(0, 3), notes: parsed.notes },
  };
}

/** JSON text to row objects, before the schema sees them. Throws a sentence. */
function jsonRows(text: string): { row: Record<string, unknown>; label: string }[] {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    throw new Error('The file starts like JSON but does not parse as JSON.');
  }
  if (!Array.isArray(parsed)) {
    throw new Error('A JSON file must be an array of rows, each with date, amount and description.');
  }
  return parsed.map((row, i) => ({ row: row as Record<string, unknown>, label: `item ${i + 1}` }));
}

function refusal(problems: string[]): string {
  const shown = problems.slice(0, MAX_REPORTED).join('; ');
  const more = problems.length > MAX_REPORTED ? `; and ${problems.length - MAX_REPORTED} more` : '';
  return `The file has rows that cannot be staged: ${shown}${more}. Each row needs a YYYY-MM-DD date, a signed amount and a description.`;
}

/**
 * The rows a file holds, each checked by `schema`. CSV or a JSON array,
 * told apart by the first character. A CSV comes back with what reading it
 * decided and left out; a JSON array is taken as written. Throws a sentence
 * the model can act on.
 */
export function rowsFromFile<T>(bytes: Buffer, schema: z.ZodType<T>, options: BankCsvOptions = {}): { rows: T[]; diagnostic?: FileDiagnostic } {
  if (bytes.subarray(0, 5).toString('latin1') === '%PDF-') {
    throw new Error(
      'could not read: this file is a PDF, not a CSV. Read its lines off the document yourself and stage them as rows, with artifactId set to this file (up to 200 rows a call); a bank\'s CSV export, when there is one, goes in by file instead.',
    );
  }
  if (bytes.subarray(0, 2).toString('latin1') === 'PK') {
    throw new Error('could not read: this file is a spreadsheet (.xlsx) or an archive, not a CSV. Ask the owner for the CSV export of the same statement; most banks offer one beside the spreadsheet.');
  }
  const text = bytes.toString('utf8').replace(/^\ufeff/, '');
  let raw: { row: Record<string, unknown>; label: string }[];
  let diagnostic: FileDiagnostic | undefined;
  if (text.trimStart().startsWith('[')) raw = jsonRows(text);
  else ({ raw, diagnostic } = csvRows(text, options));
  if (raw.length === 0) throw new Error('could not read: the file has a header row but no rows.');
  if (raw.length > MAX_FILE_ROWS) {
    throw new Error(`The file has ${raw.length} rows; one staging takes at most ${MAX_FILE_ROWS}. Split it by date.`);
  }
  const rows: T[] = [];
  const problems: string[] = [];
  for (const { row, label } of raw) {
    const checked = schema.safeParse(row);
    if (checked.success) rows.push(checked.data);
    else {
      const issue = checked.error.issues[0];
      const where = issue && issue.path.length > 0 ? `${issue.path.join('.')} ` : '';
      problems.push(`${label}: ${where}${issue?.message ?? 'invalid'}`);
    }
  }
  if (problems.length > 0) throw new Error(refusal(problems));
  return diagnostic ? { rows, diagnostic } : { rows };
}
