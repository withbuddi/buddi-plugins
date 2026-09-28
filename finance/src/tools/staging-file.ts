/**
 * Rows for `finance.stage_import`, read from a file instead of typed inline.
 *
 * A statement of a few hundred lines is too long to write out as tool
 * arguments: the reply hits the model's output limit part-way through the call.
 * So the rows can come from a file in the Files library — the CSV the owner
 * dropped, or rows the agent parsed and saved as a file.
 *
 * Deliberately strict. A CSV here has a header row naming `date`, `amount` and
 * `description`, dates already `YYYY-MM-DD` and amounts plain numbers. Nothing
 * is guessed: a file in another shape is refused with what was found, and the
 * agent converts it first. A JSON file is an array of row objects. Either way
 * every row goes through the same schema an inline row does.
 */
import type { z } from 'zod';

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

const REQUIRED = ['date', 'amount', 'description'] as const;
const OPTIONAL = ['category', 'status'] as const;
const PLAIN_NUMBER = /^[+-]?\d+(\.\d+)?$/;

/** CSV text to row objects, before the schema sees them. Throws a sentence. */
function csvRows(text: string): { row: Record<string, unknown>; label: string }[] {
  const records = parseCsvRecords(text);
  const header = records[0];
  if (!header) throw new Error('The file is empty: no header row.');
  const names = header.map((h) => h.trim().toLowerCase());
  const index = new Map<string, number>();
  names.forEach((name, i) => {
    if (!index.has(name)) index.set(name, i);
  });
  const missing = REQUIRED.filter((name) => !index.has(name));
  if (missing.length > 0) {
    throw new Error(
      `The file has no ${missing.join(', ')} column. The header row reads: ${header.join(', ')}. It needs date, amount and description, and may add category and status.`,
    );
  }
  const problems: string[] = [];
  const out: { row: Record<string, unknown>; label: string }[] = [];
  records.slice(1).forEach((cells, i) => {
    const label = `row ${i + 2}`;
    const cell = (name: string): string => {
      const at = index.get(name);
      return at === undefined ? '' : (cells[at] ?? '').trim();
    };
    const date = cell('date');
    if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) {
      problems.push(`${label}: date "${date}" is not YYYY-MM-DD`);
      return;
    }
    const amount = cell('amount');
    if (!PLAIN_NUMBER.test(amount)) {
      problems.push(`${label}: amount "${amount}" is not a plain number like -12.50`);
      return;
    }
    const row: Record<string, unknown> = {
      date,
      amount: Number(amount),
      description: cell('description'),
    };
    for (const name of OPTIONAL) {
      const value = cell(name);
      if (value !== '') row[name] = name === 'status' ? value.toLowerCase() : value;
    }
    out.push({ row, label });
  });
  if (problems.length > 0) throw new Error(refusal(problems));
  return out;
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
  return `The file has rows that cannot be staged: ${shown}${more}. Dates must be YYYY-MM-DD and amounts plain numbers; convert the file and try again.`;
}

/**
 * The rows a file holds, each checked by `schema`. CSV or a JSON array,
 * told apart by the first character. Throws a sentence the model can act on.
 */
export function rowsFromFile<T>(bytes: Buffer, schema: z.ZodType<T>): T[] {
  const text = bytes.toString('utf8').replace(/^﻿/, '');
  const raw = text.trimStart().startsWith('[') ? jsonRows(text) : csvRows(text);
  if (raw.length === 0) throw new Error('The file has a header row but no rows.');
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
  return rows;
}
