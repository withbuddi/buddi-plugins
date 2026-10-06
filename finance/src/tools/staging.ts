/**
 * Two-phase import: stage, show, commit.
 *
 * A statement is read by the model, not by a parser — the rows arrive already
 * extracted. That makes the risk different from a CSV: the model can misread a
 * column, double a row, or invent one. So nothing a statement produces enters
 * the ledger on the strength of the extraction alone. `stage_import` validates
 * the rows, works out which are genuinely new, and stores the proposal with a
 * summary the owner is shown verbatim; only `commit_import` writes. An
 * uncommitted staging expires after two hours, so a confirmation the owner
 * never gave cannot be applied later by accident.
 */
import { ToolRefusal, type DbArea, type ToolDefinition } from '@buddi/core/plugin';
import { z } from 'zod';
import { dedupHash, loadPreferences, occurrenceIndexes, recordCurrency, resolveLedger, type Ledger } from './shared.js';
import { insertTransaction, type TransactionSource } from './transactions.js';
import { runReconcile } from './reconcile.js';
import { rowsFromFile, type FileDiagnostic } from './staging-file.js';
import { bestMatch, normalizeMerchant, SUPERSESSION_WINDOW } from '../merchant.js';

const DATE = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'expected a YYYY-MM-DD date');
const UUID = z.string().uuid();

/** Rows one call may carry inline. More than this, and the call is cut off before it is written. */
export const MAX_INLINE_ROWS = 200;

/** How long an unconfirmed staging stays usable. */
export const STAGING_TTL_HOURS = 2;

const stagedRow = z.object({
  date: DATE.describe('Transaction date as printed on the statement, YYYY-MM-DD.'),
  amount: z
    .number()
    .describe('Signed: negative for money out, positive for money in. Never an absolute value.'),
  description: z.string().min(1).describe('The line as printed.'),
  category: z.string().min(1).optional().describe('Category, if the statement gives one.'),
  status: z
    .enum(['pending', 'posted'])
    .optional()
    .describe("Default 'posted'. Use 'pending' for a line the statement marks as unsettled."),
});

type StagedRow = z.infer<typeof stagedRow>;

interface StoredRow extends StagedRow {
  /** Position among identical (date, amount, description) rows in this batch. */
  occurrence: number;
  dedupHash: string;
  /** False when this exact row is already in the ledger. */
  isNew: boolean;
  /** A posted row that settles a pending one already recorded. */
  settlesPending?: boolean;
}

const stageInput = z
  .object({
    account: z
      .string()
      .min(1)
      .optional()
      .describe(
        'Cash account these rows belong to. Created if unknown. Exactly one of account or liability.',
      ),
    liability: z
      .string()
      .min(1)
      .optional()
      .describe(
        'The card or loan these rows belong to, for a credit-card statement. It must already exist (finance.set_liability). On a card, negative is a charge and positive a payment or credit. Exactly one of account or liability.',
      ),
    source: z
      .enum(['statement', 'csv', 'manual'])
      .describe(
        "Where the rows came from: 'statement' for a PDF/image the owner sent, 'csv' for a file, 'manual' for rows dictated to you.",
      ),
    artifactId: UUID.optional().describe('The stored document the rows were read from. Defaults to file when file is given.'),
    rows: z
      .array(stagedRow)
      .min(1)
      .max(MAX_INLINE_ROWS)
      .optional()
      .describe(
        'The extracted rows, in statement order. For more than a couple of hundred rows, do not type them: pass `file` with the artifact id of the CSV, or write the rows to an artifact and pass its id.',
      ),
    file: UUID.optional().describe(
      "Artifact id of a file holding the rows, instead of rows: the bank's or card's CSV export exactly as the owner dropped it — any common layout (Date/Description/Amount, Withdrawals/Deposits, a Debit/Credit column, $ and parentheses, month-first dates, a summary above the header, no header at all) — or a JSON array of rows. Never rewrite or clean the file first: pass it as it is. On a card, charges the export writes positive are flipped for you. The result's `file` says what was read, what was decided (`notes`) and how many lines were left out and why. A path in a workspace is not accepted: return the file from host.exec as an output to get its artifact id. Exactly one of rows or file.",
    ),
  })
  .refine((v) => Boolean(v.account) !== Boolean(v.liability), {
    message: 'provide exactly one of account (cash) or liability (card, loan)',
  })
  .refine((v) => (v.rows === undefined) !== (v.file === undefined), {
    message: 'provide exactly one of rows or file',
  });

function round2(n: number): number {
  return Math.round((n + Number.EPSILON) * 100) / 100;
}

export const stageImport: ToolDefinition<z.infer<typeof stageInput>, unknown> = {
  name: 'finance.stage_import',
  description:
    "Stage rows read off a statement WITHOUT writing them to the ledger. It validates them, works out which are already recorded, and returns a summary — row count, how many are new, how many are duplicates, the date range, money in, money out, and the five biggest categories. Show that summary to the owner in plain words and ask whether to commit; write it with finance.commit_import only after an explicit yes, or drop it with finance.discard_import. Pass `liability` instead of `account` for a credit-card statement: the rows then live on the card, where a negative amount is a charge and a positive one a payment. The staging expires in two hours. Extract the rows from the document yourself — never invent a row, and if part of the document is unreadable, stage what is legible and say which part you could not read. A CSV or PDF statement the owner hands you goes in by `file` with its artifact id — the CSV exactly as exported, never retyped, cleaned or split; type `rows` only for what you read off a PDF, a screenshot or the owner's words, and never more than about thirty of them by hand. If a file cannot be read the refusal says why: tell the owner what the file looks like and what is missing instead of rewriting it.",
  tier: 'auto',
  input: stageInput,
  async execute(input, ctx) {
    await recordCurrency(ctx.buddi!.db, ctx.buddi!.owner);
    let rowsIn: StagedRow[] = input.rows ?? [];
    let diagnostic: FileDiagnostic | undefined;
    if (input.file !== undefined) {
      const bytes = await ctx.buddi!.files!.read(input.file);
      const { currency } = await loadPreferences(ctx.buddi!.db, ctx.buddi!.owner);
      try {
        ({ rows: rowsIn, diagnostic } = rowsFromFile(bytes, stagedRow, {
          ledger: input.liability ? 'liability' : 'account',
          // 03/04/2026 is the 4th of March to a dollar owner, the 3rd of April to everyone else.
          dateOrder: currency === 'USD' ? 'mdy' : 'dmy',
        }));
      } catch (error) {
        throw new ToolRefusal(error instanceof Error ? error.message : String(error));
      }
    }
    const artifactId = input.artifactId ?? input.file;
    const ledger = await resolveLedger(ctx.buddi!.db, input);

    // Identical rows inside one batch are distinct transactions, numbered by
    // their position, exactly as a CSV import numbers them — so staging the
    // same statement twice produces the same hashes and reads as duplicates.
    const occurrences = occurrenceIndexes(
      rowsIn.map((r) => ({ date: r.date, amount: r.amount, description: r.description })),
    );
    const hashes = rowsIn.map((row, i) =>
      dedupHash(ledger.name, row.date, row.amount, row.description, occurrences[i] ?? 0),
    );
    // What counts as already recorded: a row with the same hash, unless that
    // row is a pending one still waiting to settle and this copy is posted —
    // then this is the charge posting, not a repeat (commit settles it in
    // place). A pending row already superseded has its posted twin in the
    // ledger, so it still counts. A deleted row is gone and counts for nothing.
    const { rows: existingRows } = await ctx.buddi!.db.query(
      `select dedup_hash, (status = 'pending' and superseded_by is null) as waiting
         from finance.transactions where dedup_hash = any($1::text[])`,
      [hashes],
    );
    const existing = new Map(existingRows.map((r) => [r.dedup_hash as string, r.waiting === true]));

    const stored: StoredRow[] = rowsIn.map((row, i) => {
      const hash = hashes[i] as string;
      const posted = row.status !== 'pending';
      const waiting = existing.get(hash);
      const settles = posted && waiting === true;
      return {
        ...row,
        occurrence: occurrences[i] ?? 0,
        dedupHash: hash,
        isNew: waiting === undefined || settles,
        ...(settles ? { settlesPending: true } : {}),
      };
    });

    // A posted row that is not the same line may still be a pending charge
    // posting: same ledger, same amount, the same merchant, dated from two
    // days before the pending one to five after (what reconcile matches).
    const { rows: waitingRows } = await ctx.buddi!.db.query(
      `select id, occurred_on::text as occurred_on, amount::float8 as amount, coalesce(merchant_norm, '') as merchant_norm
         from finance.transactions
        where status = 'pending' and superseded_by is null
          and account_id is not distinct from $1::uuid and liability_id is not distinct from $2::uuid
          and dedup_hash <> all($3::text[])`,
      [ledger.accountId, ledger.liabilityId, hashes],
    );
    const candidates = stored
      .map((r, index) => ({ id: String(index), occurredOn: r.date, amount: r.amount, merchantNorm: normalizeMerchant(r.description) }))
      .filter((c) => {
        const r = stored[Number(c.id)] as StoredRow;
        return r.isNew && r.status !== 'pending' && !r.settlesPending;
      });
    const claimed = new Set<string>();
    for (const p of waitingRows) {
      const match = bestMatch(
        { occurredOn: String(p.occurred_on), amount: Number(p.amount), merchantNorm: String(p.merchant_norm) },
        candidates.filter((c) => !claimed.has(c.id)),
        SUPERSESSION_WINDOW,
      );
      if (!match) continue;
      claimed.add(match.candidate.id);
      (stored[Number(match.candidate.id)] as StoredRow).settlesPending = true;
    }

    const fresh = stored.filter((r) => r.isNew);
    const dates = stored.map((r) => r.date).sort();
    let totalIn = 0;
    let totalOut = 0;
    const byCategory = new Map<string, number>();
    for (const row of fresh) {
      if (row.amount >= 0) totalIn += row.amount;
      else totalOut += row.amount;
      const key = row.category ?? 'uncategorized';
      byCategory.set(key, round2((byCategory.get(key) ?? 0) + row.amount));
    }

    const summary = {
      rows: stored.length,
      newRows: fresh.length,
      duplicates: stored.length - fresh.length,
      pending: fresh.filter((r) => r.status === 'pending').length,
      /** New posted rows that settle a pending charge already in the ledger. */
      settlesPending: fresh.filter((r) => r.settlesPending === true).length,
      dateRange:
        dates.length > 0 ? { from: dates[0], to: dates[dates.length - 1] } : null,
      /** Totals and categories describe the NEW rows — what committing would add. */
      totalIn: round2(totalIn),
      totalOut: round2(totalOut),
      byCategoryTop5: [...byCategory.entries()]
        .map(([category, total]) => ({ category, total }))
        .sort((a, b) => Math.abs(b.total) - Math.abs(a.total))
        .slice(0, 5),
    };

    const { rows } = await ctx.buddi!.db.query(
      `insert into finance.import_stagings
         (account_id, liability_id, source, artifact_id, rows, summary, expires_at)
       values ($1, $7, $2, $3, $4, $5, now() + make_interval(hours => $6::int))
       returning id, expires_at`,
      [
        ledger.accountId,
        input.source,
        artifactId ?? null,
        JSON.stringify(stored),
        JSON.stringify(summary),
        STAGING_TTL_HOURS,
        ledger.liabilityId,
      ],
    );

    return {
      stagingId: rows[0].id as string,
      ledger: ledger.kind,
      account: ledger.kind === 'account' ? ledger.name : null,
      liability: ledger.kind === 'liability' ? ledger.name : null,
      source: input.source,
      expiresAt: (rows[0].expires_at as Date).toISOString(),
      summary,
      ...(diagnostic ? { file: diagnostic } : {}),
      note:
        diagnostic && diagnostic.rejected > 0
          ? `Nothing has been written yet. ${diagnostic.rejected} line${diagnostic.rejected === 1 ? '' : 's'} of the file could not be read (${diagnostic.reasons.join('; ')}): tell the owner which, show the summary and ask before committing.`
          : 'Nothing has been written yet. Show this to the owner and ask before committing.',
    };
  },
};

interface StagingRecord {
  id: string;
  /** The ledger the rows belong to: a cash account, or a card/loan. */
  ledger: Ledger;
  source: TransactionSource;
  artifactId: string | null;
  rows: StoredRow[];
  summary: Record<string, unknown>;
  committedAt: Date | null;
  expired: boolean;
  expiresAt: Date;
}

async function loadStaging(db: DbArea, id: string): Promise<StagingRecord> {
  const { rows } = await db.query(
    `select s.id, s.account_id, s.liability_id, a.name as account_name, l.name as liability_name,
            s.source, s.artifact_id,
            s.rows, s.summary, s.committed_at, s.expires_at, (s.expires_at <= now()) as expired
       from finance.import_stagings s
       left join finance.accounts a on a.id = s.account_id
       left join finance.liabilities l on l.id = s.liability_id
      where s.id = $1`,
    [id],
  );
  const row = rows[0];
  if (!row) throw new Error(`unknown staging: ${id}`);
  const liabilityId = (row.liability_id as string | null) ?? null;
  const ledger: Ledger = liabilityId
    ? {
        kind: 'liability',
        id: liabilityId,
        name: row.liability_name as string,
        accountId: null,
        liabilityId,
      }
    : {
        kind: 'account',
        id: row.account_id as string,
        name: row.account_name as string,
        accountId: row.account_id as string,
        liabilityId: null,
      };
  return {
    id: row.id as string,
    ledger,
    source: row.source as TransactionSource,
    artifactId: (row.artifact_id as string | null) ?? null,
    rows: row.rows as StoredRow[],
    summary: row.summary as Record<string, unknown>,
    committedAt: (row.committed_at as Date | null) ?? null,
    expired: row.expired === true,
    expiresAt: row.expires_at as Date,
  };
}

const commitInput = z.object({
  stagingId: UUID.describe('The stagingId returned by finance.stage_import.'),
});

export const commitImport: ToolDefinition<z.infer<typeof commitInput>, unknown> = {
  name: 'finance.commit_import',
  description:
    'Write a staged import into the ledger. Only call this after the owner has seen the summary and said yes — never on your own initiative and never "to save a step". Rows already in the ledger are skipped — except a posted row whose pending twin is recorded, which settles it (a deleted row never counts) — a row staged as pending is written as pending, and the import ends by reconciling, so a pending line whose posted twin is in the same statement settles at once. Refuses a staging that was already committed or that has expired; stage it again in that case. Every row written carries the document\'s artifactId, so a wrong import can be undone with finance.delete_transactions and that artifactId. The owner approves the batch on a card naming the count and the ledger.',
  // Writes to the ledger, so the owner approves the batch on a card: the
  // count and the ledger. "This conversation" on the card covers the next
  // statements of the same session, when the owner allows remembering.
  tier: 'gated',
  reusableApproval: true,
  input: commitInput,
  async describe(input, ctx) {
    const staging = await committable(ctx.buddi!.db, input.stagingId, (m) => new ToolRefusal(m));
    const summary = staging.summary as {
      rows?: number;
      newRows?: number;
      duplicates?: number;
      dateRange?: { from: string; to: string } | null;
    };
    const rows = summary.rows ?? staging.rows.length;
    const fresh = summary.newRows ?? staging.rows.filter((r) => r.isNew).length;
    const duplicates = summary.duplicates ?? rows - fresh;
    const where = staging.ledger.kind === 'liability' ? `the card ${staging.ledger.name}` : `the account ${staging.ledger.name}`;
    const range = summary.dateRange ? `, ${summary.dateRange.from} to ${summary.dateRange.to}` : '';
    return {
      envelope: {
        tool: 'finance.commit_import',
        stagingId: staging.id,
        ledger: { kind: staging.ledger.kind, name: staging.ledger.name },
        source: staging.source,
        artifactId: staging.artifactId,
        rows,
        newRows: fresh,
        duplicates,
        dateRange: summary.dateRange ?? null,
      },
      preview:
        `Add ${plural(fresh, 'transaction')} to ${where}${range}.` +
        (duplicates > 0 ? ` ${plural(duplicates, 'row')} already recorded ${duplicates === 1 ? 'is' : 'are'} skipped.` : ''),
    };
  },
  async execute(input, ctx) {
    const staging = await committable(ctx.buddi!.db, input.stagingId, (m) => new Error(m));

    let inserted = 0;
    let skipped = 0;
    let pending = 0;
    let settledPending = 0;
    for (const row of staging.rows) {
      // A statement is settled money unless the statement itself said
      // otherwise; a row staged as pending stays pending.
      const status = row.status === 'pending' ? 'pending' : 'posted';
      const result = await insertTransaction(ctx.buddi!.db, {
        accountId: staging.ledger.accountId,
        liabilityId: staging.ledger.liabilityId,
        ledgerName: staging.ledger.name,
        occurredOn: row.date,
        amount: row.amount,
        description: row.description,
        category: row.category ?? null,
        source: staging.source,
        occurrence: row.occurrence,
        status,
        artifactId: staging.artifactId,
      });
      if (result.inserted) {
        inserted += 1;
        if (status === 'pending') pending += 1;
      } else if (result.posted) settledPending += 1;
      else skipped += 1;
    }

    const reconciled = await runReconcile(ctx.buddi!.db);
    await ctx.buddi!.db.query(
      `update finance.import_stagings set committed_at = now() where id = $1`,
      [staging.id],
    );

    return {
      stagingId: staging.id,
      ledger: staging.ledger.kind,
      account: staging.ledger.kind === 'account' ? staging.ledger.name : null,
      liability: staging.ledger.kind === 'liability' ? staging.ledger.name : null,
      source: staging.source,
      inserted,
      skipped,
      pending,
      settledPending,
      artifactId: staging.artifactId,
      reconciled: {
        pendingMatched: reconciled.pending.matched.length,
        pendingOutstanding: reconciled.pending.unmatched.length,
        receiptsMatched: reconciled.receipts.matched.length,
      },
    };
  },
};

/** A staging that can still be written, or the sentence saying why not. */
async function committable(db: DbArea, id: string, refuse: (message: string) => Error): Promise<StagingRecord> {
  const staging = await loadStaging(db, id);
  if (staging.committedAt) {
    throw refuse(`staging ${staging.id} was already committed at ${staging.committedAt.toISOString()}`);
  }
  if (staging.expired) {
    throw refuse(
      `staging ${staging.id} expired at ${staging.expiresAt.toISOString()}; stage the rows again and re-confirm with the owner`,
    );
  }
  return staging;
}

function plural(n: number, word: string): string {
  return `${n} ${word}${n === 1 ? '' : 's'}`;
}

const discardInput = z.object({
  stagingId: UUID.describe('The staging to drop.'),
});

export const discardImport: ToolDefinition<z.infer<typeof discardInput>, unknown> = {
  name: 'finance.discard_import',
  description:
    'Drop a staged import the owner declined, or one you staged from a document you then read better. Nothing had been written to the ledger, so nothing is lost. A staging that was already committed cannot be discarded — the rows are in the ledger by then.',
  tier: 'auto',
  input: discardInput,
  async execute(input, ctx) {
    const staging = await loadStaging(ctx.buddi!.db, input.stagingId);
    if (staging.committedAt) {
      throw new Error(
        `staging ${staging.id} was already committed at ${staging.committedAt.toISOString()}; it cannot be discarded`,
      );
    }
    await ctx.buddi!.db.query(`delete from finance.import_stagings where id = $1`, [staging.id]);
    return {
      discarded: true,
      stagingId: staging.id,
      ledger: staging.ledger.kind,
      account: staging.ledger.kind === 'account' ? staging.ledger.name : null,
      liability: staging.ledger.kind === 'liability' ? staging.ledger.name : null,
      rows: staging.rows.length,
    };
  },
};

/** Exported for tests: the shape a staged row takes in storage. */
export type { StoredRow };
