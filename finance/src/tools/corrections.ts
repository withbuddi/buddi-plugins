/**
 * Correcting the ledger: find rows, change them, delete them.
 *
 * An import the model misread — charges flipped into payments, day and month
 * swapped — used to be permanent. These three tools make it fixable. Finding is
 * a read and runs at once; changing and deleting are gated, because they
 * rewrite the owner's history, and the approval card lists the rows.
 *
 * Account and card balances are stated figures, never sums of these rows, so a
 * correction leaves them alone. What does read the rows — the monthly summary,
 * typical spending, the card activity — reads them live, so it follows at once.
 * The one derived state is reconciliation (a pending row superseded by its
 * posted twin, a receipt linked to its charge), and every write here ends with
 * `runReconcile`, as a commit does.
 */
import type { DbArea, ToolDefinition } from '@buddi/core/plugin';
import { z } from 'zod';
import { normalizeMerchant } from '../merchant.js';
import { runReconcile, type ReconcileReport } from './reconcile.js';
import {
  dedupHash,
  findAccount,
  findLiability,
  loadPreferences,
  num,
  toDateString,
} from './shared.js';

type Queryable = Pick<DbArea, 'query'>;

const DATE = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'expected a YYYY-MM-DD date');
const UUID = z.string().uuid();

/** Rows a find returns when no limit is given, and the most it ever returns. */
export const FIND_DEFAULT_LIMIT = 50;
export const FIND_MAX_LIMIT = 500;
export const MAX_UPDATES = 200;
export const MAX_DELETE_IDS = 500;
/** Rows a delete preview names before it says how many more there are. */
export const PREVIEW_ROWS = 5;

/* ------------------------------------------------------------------ rows */

interface TxRow {
  id: string;
  date: string;
  amount: number;
  description: string;
  category: string | null;
  source: string;
  status: string;
  superseded: boolean;
  artifactId: string | null;
  createdAt: string;
  accountId: string | null;
  liabilityId: string | null;
  /** The account's or the liability's name. */
  ledger: string;
}

const ROW_SELECT = `
  select t.id, t.occurred_on, t.amount, t.description, t.category, t.source, t.status,
         t.superseded_by, t.artifact_id, t.created_at, t.account_id, t.liability_id,
         coalesce(a.name, l.name) as ledger_name
    from finance.transactions t
    left join finance.accounts a on a.id = t.account_id
    left join finance.liabilities l on l.id = t.liability_id`;

function mapRow(r: Record<string, unknown>): TxRow {
  return {
    id: r.id as string,
    date: toDateString(r.occurred_on),
    amount: num(r.amount),
    description: r.description as string,
    category: (r.category as string | null) ?? null,
    source: r.source as string,
    status: r.status as string,
    superseded: r.superseded_by !== null && r.superseded_by !== undefined,
    artifactId: (r.artifact_id as string | null) ?? null,
    createdAt:
      r.created_at instanceof Date ? r.created_at.toISOString() : String(r.created_at),
    accountId: (r.account_id as string | null) ?? null,
    liabilityId: (r.liability_id as string | null) ?? null,
    ledger: (r.ledger_name as string | null) ?? '',
  };
}

function round2(n: number): number {
  return Math.round((n + Number.EPSILON) * 100) / 100;
}

/** `+$40.00` / `−$40.00`, in the owner's currency. The minus is a real one. */
export function formatMoney(amount: number, currency: string): string {
  const sign = amount < 0 ? '−' : '+';
  const abs = Math.abs(amount);
  try {
    return (
      sign +
      new Intl.NumberFormat('en-US', { style: 'currency', currency }).format(abs)
    );
  } catch {
    return `${sign}${abs.toFixed(2)} ${currency}`;
  }
}

function plural(n: number, word: string): string {
  return `${n} ${word}${n === 1 ? '' : 's'}`;
}

/** A name to a ledger, never created: a correction does not invent accounts. */
async function ledgerByName(
  db: Queryable,
  ref: { account?: string | undefined; liability?: string | undefined },
): Promise<{ kind: 'account' | 'liability'; id: string; name: string } | undefined> {
  if (ref.account && ref.liability) {
    throw new Error('Pass either account or liability, never both: a row lives on one ledger.');
  }
  if (ref.account) {
    const account = await findAccount(db as DbArea, ref.account);
    if (!account) throw new Error(`There is no account called ${ref.account}.`);
    return { kind: 'account', id: account.id, name: account.name };
  }
  if (ref.liability) {
    const liability = await findLiability(db as DbArea, ref.liability);
    if (!liability) throw new Error(`There is no card or loan called ${ref.liability}.`);
    return { kind: 'liability', id: liability.id, name: liability.name };
  }
  return undefined;
}

function reconciledSummary(report: ReconcileReport) {
  return {
    pendingMatched: report.pending.matched.length,
    pendingOutstanding: report.pending.unmatched.length,
    receiptsMatched: report.receipts.matched.length,
  };
}

const BALANCES_NOTE =
  'Account and card balances are stated figures, not sums of these rows, so they did not change. Summaries and typical spending read the rows, so they already reflect this.';

/* ------------------------------------------------------------------ find */

const findInput = z
  .object({
    account: z.string().min(1).optional().describe('Only rows on this cash account.'),
    liability: z.string().min(1).optional().describe('Only rows on this card or loan.'),
    from: DATE.optional().describe('Earliest date, YYYY-MM-DD, inclusive.'),
    to: DATE.optional().describe('Latest date, YYYY-MM-DD, inclusive.'),
    minAmount: z
      .number()
      .optional()
      .describe('Smallest signed amount, inclusive. Money out is negative.'),
    maxAmount: z
      .number()
      .optional()
      .describe('Largest signed amount, inclusive. Money out is negative.'),
    text: z
      .string()
      .min(1)
      .optional()
      .describe('Part of the description, any case.'),
    category: z.string().min(1).optional().describe('Exact category, any case.'),
    artifactId: UUID.optional().describe('Only rows read from this document.'),
    source: z.enum(['manual', 'csv', 'statement']).optional().describe('Only rows from this source.'),
    limit: z
      .number()
      .int()
      .min(1)
      .max(FIND_MAX_LIMIT)
      .optional()
      .describe(`Rows to return. Default ${FIND_DEFAULT_LIMIT}, at most ${FIND_MAX_LIMIT}.`),
    offset: z.number().int().min(0).optional().describe('Rows to skip, for the next page.'),
  })
  .refine((v) => !(v.account && v.liability), {
    message: 'pass either account or liability, never both',
  });

export const findTransactions: ToolDefinition<z.infer<typeof findInput>, unknown> = {
  name: 'finance.find_transactions',
  description:
    'Find recorded transactions by ledger, date range, signed amount, description text, category, source, or the document they came from (artifactId). Returns the total that match and one page of rows, newest first, each with its id. This is how you find the exact rows before finance.update_transactions or finance.delete_transactions: quote the ids from here, never guess them. Superseded pending rows are included and marked.',
  tier: 'auto',
  input: findInput,
  async execute(input, ctx) {
    const db = ctx.buddi!.db;
    const ledger = await ledgerByName(db, input);
    const where: string[] = [];
    const params: unknown[] = [];
    const add = (clause: (p: string) => string, value: unknown) => {
      params.push(value);
      where.push(clause(`$${params.length}`));
    };
    if (ledger?.kind === 'account') add((p) => `t.account_id = ${p}`, ledger.id);
    if (ledger?.kind === 'liability') add((p) => `t.liability_id = ${p}`, ledger.id);
    if (input.from) add((p) => `t.occurred_on >= ${p}::date`, input.from);
    if (input.to) add((p) => `t.occurred_on <= ${p}::date`, input.to);
    if (input.minAmount !== undefined) add((p) => `t.amount >= ${p}`, input.minAmount);
    if (input.maxAmount !== undefined) add((p) => `t.amount <= ${p}`, input.maxAmount);
    if (input.text) add((p) => `strpos(lower(t.description), lower(${p})) > 0`, input.text);
    if (input.category) add((p) => `lower(t.category) = lower(${p})`, input.category);
    if (input.artifactId) add((p) => `t.artifact_id = ${p}::uuid`, input.artifactId);
    if (input.source) add((p) => `t.source = ${p}`, input.source);
    const limit = input.limit ?? FIND_DEFAULT_LIMIT;
    const offset = input.offset ?? 0;
    const filter = where.length ? `where ${where.join(' and ')}` : '';
    const { rows: countRows } = await db.query(
      `select count(*)::int as n from finance.transactions t ${filter}`,
      params,
    );
    const { rows } = await db.query(
      `${ROW_SELECT} ${filter}
        order by t.occurred_on desc, t.created_at desc, t.id
        limit ${limit} offset ${offset}`,
      params,
    );
    const found = rows.map(mapRow);
    const { currency } = await loadPreferences(db);
    return {
      currency,
      total: Number(countRows[0]?.n ?? 0),
      offset,
      rows: found.map((r) => ({
        id: r.id,
        date: r.date,
        amount: r.amount,
        description: r.description,
        category: r.category,
        account: r.accountId ? r.ledger : null,
        liability: r.liabilityId ? r.ledger : null,
        status: r.status,
        ...(r.superseded ? { superseded: true as const } : {}),
        source: r.source,
        artifactId: r.artifactId,
        createdAt: r.createdAt,
      })),
    };
  },
};

/* ---------------------------------------------------------------- update */

const change = z
  .object({
    id: UUID.describe('The row, as finance.find_transactions returned it.'),
    date: DATE.optional().describe('New date, YYYY-MM-DD.'),
    amount: z
      .number()
      .optional()
      .describe('New signed amount. Negative is money out, or a charge on a card.'),
    description: z.string().min(1).optional().describe('New description.'),
    category: z.string().min(1).optional().describe('New category.'),
    account: z.string().min(1).optional().describe('Move the row to this cash account.'),
    liability: z.string().min(1).optional().describe('Move the row to this card or loan.'),
  })
  .refine(
    (c) =>
      c.date !== undefined ||
      c.amount !== undefined ||
      c.description !== undefined ||
      c.category !== undefined ||
      c.account !== undefined ||
      c.liability !== undefined,
    { message: 'each change needs at least one field to change' },
  )
  .refine((c) => !(c.account && c.liability), {
    message: 'move a row to an account or to a liability, not both',
  });

const updateInput = z
  .object({
    changes: z
      .array(change)
      .min(1)
      .max(MAX_UPDATES)
      .describe(`The rows to change, 1 to ${MAX_UPDATES}. Only the fields given change.`),
  })
  .refine((v) => new Set(v.changes.map((c) => c.id)).size === v.changes.length, {
    message: 'each id may appear only once',
  });

interface RowState {
  date: string;
  amount: number;
  description: string;
  category: string | null;
  ledger: string;
  accountId: string | null;
  liabilityId: string | null;
}

interface PlannedChange {
  id: string;
  before: RowState;
  after: RowState;
}

function stateOf(row: TxRow): RowState {
  return {
    date: row.date,
    amount: row.amount,
    description: row.description,
    category: row.category,
    ledger: row.ledger,
    accountId: row.accountId,
    liabilityId: row.liabilityId,
  };
}

/** Rows by id, refusing — in a sentence — when any of them is not in the ledger. */
async function loadRows(db: Queryable, ids: string[]): Promise<Map<string, TxRow>> {
  const { rows } = await db.query(`${ROW_SELECT} where t.id = any($1::uuid[])`, [ids]);
  const byId = new Map(rows.map((r) => [r.id as string, mapRow(r)]));
  const missing = ids.filter((id) => !byId.has(id));
  if (missing.length > 0) {
    throw new Error(
      `${missing.length === 1 ? 'This id is' : `These ${missing.length} ids are`} not in the ledger: ${missing.join(', ')}. Look the rows up with finance.find_transactions first.`,
    );
  }
  return byId;
}

async function planUpdate(
  db: Queryable,
  changes: z.infer<typeof change>[],
): Promise<PlannedChange[]> {
  const byId = await loadRows(
    db,
    changes.map((c) => c.id),
  );
  const planned: PlannedChange[] = [];
  for (const c of changes) {
    const row = byId.get(c.id)!;
    const before = stateOf(row);
    const target = await ledgerByName(db, c);
    planned.push({
      id: c.id,
      before,
      after: {
        date: c.date ?? before.date,
        amount: c.amount ?? before.amount,
        description: c.description ?? before.description,
        category: c.category ?? before.category,
        ledger: target?.name ?? before.ledger,
        accountId: target ? (target.kind === 'account' ? target.id : null) : before.accountId,
        liabilityId: target
          ? target.kind === 'liability' ? target.id : null
          : before.liabilityId,
      },
    });
  }
  return planned;
}

function ledgerMoved(p: PlannedChange): boolean {
  return (
    p.before.accountId !== p.after.accountId || p.before.liabilityId !== p.after.liabilityId
  );
}

/** "2026-09-12 +$40.00 Rahmas Poultry → 2026-12-09 −$40.00" — only what changes follows the arrow. */
export function changeLine(p: PlannedChange, currency: string): string {
  const { before: b, after: a } = p;
  const moved = ledgerMoved(p);
  const catChanged = a.category !== b.category;
  let left = `${b.date} ${formatMoney(b.amount, currency)} ${b.description}`;
  if (catChanged) left += ` (${b.category ?? 'no category'})`;
  if (moved) left += ` on ${b.ledger}`;
  const right: string[] = [];
  if (a.date !== b.date) right.push(a.date);
  if (a.amount !== b.amount) right.push(formatMoney(a.amount, currency));
  if (a.description !== b.description) right.push(a.description);
  if (catChanged) right.push(`(${a.category ?? 'no category'})`);
  if (moved) right.push(`on ${a.ledger}`);
  return `${left} → ${right.length ? right.join(' ') : 'no change'}`;
}

/** The lowest occurrence slot whose hash no other row holds, as an insert would pick. */
async function freeHash(db: Queryable, id: string, s: RowState): Promise<string> {
  for (let occurrence = 0; ; occurrence += 1) {
    const hash = dedupHash(s.ledger, s.date, s.amount, s.description, occurrence);
    const { rows } = await db.query(
      `select 1 from finance.transactions where dedup_hash = $1 and id <> $2`,
      [hash, id],
    );
    if (rows.length === 0) return hash;
  }
}

export const updateTransactions: ToolDefinition<z.infer<typeof updateInput>, unknown> = {
  name: 'finance.update_transactions',
  description:
    "Correct recorded transactions: date, amount, description, category, or the ledger a row sits on. Find the rows first with finance.find_transactions and pass their ids; only the fields you give change. The owner approves a preview listing every row before and after. Typical fixes: a charge imported as a payment (flip the sign), day and month swapped, a card purchase recorded on checking (move it with `liability`). The sign means the same on both ledgers: negative is the owner spending (money out of an account, a charge on a card), positive is money in or a payment to the card, so moving a row between an account and a card keeps its sign. Unknown ids are refused. Balances are stated figures and do not change; reconciliation runs afterwards.",
  tier: 'gated',
  reusableApproval: false,
  input: updateInput,
  async describe(input, ctx) {
    const db = ctx.buddi!.db;
    const planned = await planUpdate(db, input.changes);
    const { currency } = await loadPreferences(db);
    const lines = planned.map((p) => changeLine(p, currency));
    return {
      envelope: {
        tool: 'finance.update_transactions',
        count: planned.length,
        changes: planned.map((p) => ({ id: p.id, before: p.before, after: p.after })),
      },
      preview: [`Change ${plural(planned.length, 'transaction')}:`, ...lines].join('\n'),
    };
  },
  async execute(input, ctx) {
    const db = ctx.buddi!.db;
    const { planned, reconciled } = await db.transaction(async (tx) => {
      const planned = await planUpdate(tx, input.changes);
      for (const p of planned) {
        const { before: b, after: a } = p;
        const identityChanged =
          a.date !== b.date ||
          a.amount !== b.amount ||
          a.description !== b.description ||
          ledgerMoved(p);
        // The hash is the row's identity for dedup: it follows the corrected
        // values, so importing the right statement later reads as a duplicate.
        const hash = identityChanged ? await freeHash(tx, p.id, a) : null;
        await tx.query(
          `update finance.transactions
              set occurred_on = $2, amount = $3, description = $4, merchant_norm = $5,
                  category = $6, account_id = $7, liability_id = $8,
                  dedup_hash = coalesce($9, dedup_hash)
            where id = $1`,
          [
            p.id,
            a.date,
            a.amount,
            a.description,
            normalizeMerchant(a.description),
            a.category,
            a.accountId,
            a.liabilityId,
            hash,
          ],
        );
        if (identityChanged) {
          // A pending/posted pairing was made on the old values; let
          // reconciliation decide again on the new ones.
          await tx.query(
            `update finance.transactions set superseded_by = null
              where superseded_by = $1 or (id = $1 and superseded_by is not null)`,
            [p.id],
          );
        }
      }
      const reconciled = await runReconcile(tx);
      return { planned, reconciled };
    });
    return {
      updated: planned.length,
      rows: planned.map((p) => ({
        id: p.id,
        date: p.after.date,
        amount: p.after.amount,
        description: p.after.description,
        category: p.after.category,
        account: p.after.accountId ? p.after.ledger : null,
        liability: p.after.liabilityId ? p.after.ledger : null,
      })),
      reconciled: reconciledSummary(reconciled),
      note: BALANCES_NOTE,
    };
  },
};

/* ---------------------------------------------------------------- delete */

const deleteInput = z
  .object({
    ids: z
      .array(UUID)
      .min(1)
      .max(MAX_DELETE_IDS)
      .optional()
      .describe(`The rows to delete, 1 to ${MAX_DELETE_IDS} ids from finance.find_transactions.`),
    artifactId: UUID.optional().describe(
      'Delete every row read from this document: this undoes an import.',
    ),
    account: z.string().min(1).optional().describe('With from and to: a date range on this cash account.'),
    liability: z.string().min(1).optional().describe('With from and to: a date range on this card or loan.'),
    from: DATE.optional().describe('First day of the range, YYYY-MM-DD, inclusive.'),
    to: DATE.optional().describe('Last day of the range, YYYY-MM-DD, inclusive.'),
  })
  .superRefine((v, zctx) => {
    const range =
      v.account !== undefined ||
      v.liability !== undefined ||
      v.from !== undefined ||
      v.to !== undefined;
    const modes = [v.ids !== undefined, v.artifactId !== undefined, range].filter(Boolean).length;
    if (modes !== 1) {
      zctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: 'pass exactly one of ids, artifactId, or account/liability with from and to',
      });
      return;
    }
    if (range) {
      if (Boolean(v.account) === Boolean(v.liability)) {
        zctx.addIssue({
          code: z.ZodIssueCode.custom,
          message: 'a range needs exactly one of account or liability',
        });
      }
      if (!v.from || !v.to) {
        zctx.addIssue({ code: z.ZodIssueCode.custom, message: 'a range needs both from and to' });
      } else if (v.from > v.to) {
        zctx.addIssue({ code: z.ZodIssueCode.custom, message: 'from must not be after to' });
      }
    }
  });

type DeleteInput = z.infer<typeof deleteInput>;

interface DeletePlan {
  rows: TxRow[];
  ledgers: string[];
  from: string;
  to: string;
  moneyIn: number;
  moneyOut: number;
}

async function planDelete(db: Queryable, input: DeleteInput): Promise<DeletePlan> {
  let rows: TxRow[];
  let empty: string;
  if (input.ids) {
    const byId = await loadRows(db, input.ids);
    rows = [...byId.values()];
    empty = 'None of these ids is in the ledger.';
  } else if (input.artifactId) {
    const { rows: found } = await db.query(`${ROW_SELECT} where t.artifact_id = $1::uuid`, [
      input.artifactId,
    ]);
    rows = found.map(mapRow);
    empty = `No transaction came from document ${input.artifactId}, so there is nothing to undo.`;
  } else {
    const ledger = (await ledgerByName(db, input))!;
    const column = ledger.kind === 'account' ? 'account_id' : 'liability_id';
    const { rows: found } = await db.query(
      `${ROW_SELECT} where t.${column} = $1 and t.occurred_on between $2::date and $3::date`,
      [ledger.id, input.from, input.to],
    );
    rows = found.map(mapRow);
    empty = `${ledger.name} has no transactions from ${input.from} to ${input.to}, so there is nothing to delete.`;
  }
  if (rows.length === 0) throw new Error(empty);
  rows.sort(
    (a, b) =>
      a.date.localeCompare(b.date) || a.createdAt.localeCompare(b.createdAt) || a.id.localeCompare(b.id),
  );
  const ledgers = [...new Set(rows.map((r) => r.ledger))].sort();
  let moneyIn = 0;
  let moneyOut = 0;
  for (const r of rows) {
    if (r.amount >= 0) moneyIn += r.amount;
    else moneyOut += r.amount;
  }
  return {
    rows,
    ledgers,
    from: rows[0]!.date,
    to: rows[rows.length - 1]!.date,
    moneyIn: round2(moneyIn),
    moneyOut: round2(moneyOut),
  };
}

export function deletePreview(plan: DeletePlan, input: DeleteInput, currency: string): string {
  const n = plan.rows.length;
  const where = plan.ledgers.length === 1 ? ` on ${plan.ledgers[0]}` : ` on ${plan.ledgers.join(', ')}`;
  const range = plan.from === plan.to ? `, ${plan.from}` : `, ${plan.from} to ${plan.to}`;
  const origin = input.artifactId ? `, every row from document ${input.artifactId}` : '';
  const head = `Delete ${plural(n, 'transaction')}${where}${range}${origin}: ${formatMoney(plan.moneyIn, currency)} in, ${formatMoney(plan.moneyOut, currency)} out.`;
  const many = plan.ledgers.length > 1;
  const lines = plan.rows
    .slice(0, PREVIEW_ROWS)
    .map(
      (r) => `${r.date} ${formatMoney(r.amount, currency)} ${r.description}${many ? ` on ${r.ledger}` : ''}`,
    );
  const rest = n > PREVIEW_ROWS ? [`and ${n - PREVIEW_ROWS} more`] : [];
  return [head, ...lines, ...rest].join('\n');
}

export const deleteTransactions: ToolDefinition<DeleteInput, unknown> = {
  name: 'finance.delete_transactions',
  description:
    'Delete recorded transactions. Pass exactly one of: `ids` from finance.find_transactions; `artifactId`, which deletes every row read from that document; or `account` or `liability` with `from` and `to`, which deletes a date range on one ledger. To undo an import, pass the document\'s artifactId; finance.find_transactions with that artifactId shows what will go. Stage the document again once it is read correctly. The owner approves a preview with the count, the ledger, the dates, the money in and out, and the first rows. A selection that matches nothing is refused. Balances are stated figures and do not change; reconciliation runs afterwards.',
  tier: 'gated',
  reusableApproval: false,
  input: deleteInput,
  async describe(input, ctx) {
    const db = ctx.buddi!.db;
    const plan = await planDelete(db, input);
    const { currency } = await loadPreferences(db);
    return {
      envelope: {
        tool: 'finance.delete_transactions',
        selection: input.ids
          ? { ids: input.ids }
          : input.artifactId
            ? { artifactId: input.artifactId }
            : {
                ...(input.account ? { account: input.account } : { liability: input.liability }),
                from: input.from,
                to: input.to,
              },
        count: plan.rows.length,
        ledgers: plan.ledgers,
        from: plan.from,
        to: plan.to,
        moneyIn: plan.moneyIn,
        moneyOut: plan.moneyOut,
        ids: plan.rows.map((r) => r.id),
      },
      preview: deletePreview(plan, input, currency),
    };
  },
  async execute(input, ctx) {
    const db = ctx.buddi!.db;
    const { plan, deleted, reconciled } = await db.transaction(async (tx) => {
      const plan = await planDelete(tx, input);
      const result = await tx.query(`delete from finance.transactions where id = any($1::uuid[])`, [
        plan.rows.map((r) => r.id),
      ]);
      // A pending row whose posted twin just went reappears, and a receipt
      // whose charge went is unlinked (both by foreign key); reconcile gives
      // each the chance to match again.
      const reconciled = await runReconcile(tx);
      return { plan, deleted: result.rowCount ?? plan.rows.length, reconciled };
    });
    return {
      deleted,
      ledgers: plan.ledgers,
      from: plan.from,
      to: plan.to,
      moneyIn: plan.moneyIn,
      moneyOut: plan.moneyOut,
      ...(input.artifactId ? { artifactId: input.artifactId } : {}),
      reconciled: reconciledSummary(reconciled),
      note: BALANCES_NOTE,
    };
  },
};
