import type { DbArea, ToolDefinition } from '@buddi/core/plugin';
import { z } from 'zod';
import type { AccountKind } from '../accounts.js';
import { daysBetween } from '../projection.js';
import { ACCOUNT_KINDS, BALANCE_FRESH_DAYS, balanceIsStale, defaultIncludeInCashflow, splitTotals } from '../accounts.js';
import type { AccountRow } from './shared.js';
import {
  ACCOUNT_COLUMNS,
  ensureAccount,
  findAccount,
  loadPreferences,
  mapAccountRow,
  num,
  today,
  toDateString,
} from './shared.js';

const DATE = z
  .string()
  .regex(/^\d{4}-\d{2}-\d{2}$/, 'expected a YYYY-MM-DD date');

const KIND = z
  .enum(ACCOUNT_KINDS)
  .describe(
    "What the account is. 'cash' for a current/checking account, 'savings' for a savings, reserve or emergency pot (still spendable, so it stays in the cash flow), 'retirement' for a 401k, IRA or pension, 'investment' for a brokerage, 'hsa' for a health savings account, 'other' for anything else. retirement/investment/hsa are counted in net worth but left OUT of the cash flow, so they never make a purchase look affordable.",
  );

const INCLUDE_IN_CASHFLOW = z
  .boolean()
  .describe(
    'Whether this account is spendable money the projection and the spending baseline may use. Defaults to true, except for retirement/investment/hsa which default to false. Only set it true for one of those if the owner has actually said they spend from it.',
  );

const INSTITUTION = z
  .string()
  .min(1)
  .describe("Bank or provider holding the account, e.g. 'Fidelity' or 'Example Bank'.");

const NOTES = z
  .string()
  .min(1)
  .describe(
    "A short durable note about the account, e.g. 'employer matches 4%' or 'vests 2027'.",
  );

/**
 * Which `include_in_cashflow` a write should land on.
 *
 * An explicit value always wins. Otherwise the stored value is preserved —
 * except when the kind is being *changed*, where the new kind's own default
 * applies: relabelling an account as a 401k without also taking it out of the
 * cash flow would leave retirement money looking spendable.
 */
export function resolveIncludeInCashflow(args: {
  given?: boolean;
  kind?: AccountKind;
  current?: { kind: AccountKind; includeInCashflow: boolean };
}): boolean {
  if (args.given !== undefined) return args.given;
  if (!args.current) return defaultIncludeInCashflow(args.kind ?? 'cash');
  if (args.kind !== undefined && args.kind !== args.current.kind) {
    return defaultIncludeInCashflow(args.kind);
  }
  return args.current.includeInCashflow;
}

const setBalanceInput = z.object({
  account: z
    .string()
    .min(1)
    .describe("Account name, e.g. 'Checking'. Created if it does not exist yet."),
  balance: z.number().describe('Current balance of the account, in the reporting currency.'),
  asOf: DATE.optional().describe(
    'Date the balance was observed (YYYY-MM-DD). Defaults to today.',
  ),
  kind: KIND.optional(),
  includeInCashflow: INCLUDE_IN_CASHFLOW.optional(),
  institution: INSTITUTION.optional(),
  notes: NOTES.optional(),
});

export const setBalance: ToolDefinition<z.infer<typeof setBalanceInput>, unknown> = {
  name: 'finance.set_balance',
  description:
    "Record the current balance of an account as of a date. Creates the account if it does not exist. This is the starting point every cashflow projection builds on, so keep it fresh. RECORD WHAT YOU OBSERVE: whenever you read a balance from a live source — a bank page in the browser, a statement or screenshot, or the owner telling you what an account holds — call this FIRST, with that amount, that account and `asOf` set to the date the source itself is from, and then say in your answer that you recorded it. A balance you merely worked out — a projection, a sum, what will be left after Friday's rent — is NEVER recorded here; set_balance holds observations only, so that a later projection can trust every number it starts from. Pass `kind` when the account is not a plain current account — a 401k, IRA or pension is 'retirement', a brokerage is 'investment', an HSA is 'hsa': those are counted in net worth but excluded from the cash flow, so their balance can never make a purchase look affordable. `institution` and `notes` are optional and, like `kind`, are preserved when a later call omits them.",
  tier: 'auto',
  input: setBalanceInput,
  async execute(input, ctx) {
    const asOf = input.asOf ?? today(ctx);
    const existing = await findAccount(ctx.buddi!.db, input.account);
    const account =
      existing ??
      (await ensureAccount(ctx.buddi!.db, input.account, {
        kind: input.kind,
        includeInCashflow: input.includeInCashflow,
      }));
    const kind = input.kind ?? account.kind;
    const includeInCashflow = resolveIncludeInCashflow({
      given: input.includeInCashflow,
      kind: input.kind,
      current: existing ? { kind: existing.kind, includeInCashflow: existing.includeInCashflow } : undefined,
    });
    const { rows } = await ctx.buddi!.db.query(
      `update finance.accounts
          set balance = $2,
              balance_as_of = $3,
              kind = $4,
              include_in_cashflow = $5,
              institution = coalesce($6, institution),
              notes = coalesce($7, notes)
        where id = $1
       returning ${ACCOUNT_COLUMNS}`,
      [
        account.id,
        input.balance,
        asOf,
        kind,
        includeInCashflow,
        input.institution ?? null,
        input.notes ?? null,
      ],
    );
    const row = mapAccountRow(rows[0]);
    return {
      id: row.id,
      name: row.name,
      balance: row.balance,
      balanceAsOf: row.balanceAsOf,
      kind: row.kind,
      includeInCashflow: row.includeInCashflow,
      institution: row.institution,
      notes: row.notes,
    };
  },
};

const updateAccountInput = z.object({
  account: z.string().min(1).describe('Name of the account to change. Must already exist.'),
  kind: KIND.optional(),
  includeInCashflow: INCLUDE_IN_CASHFLOW.optional(),
  institution: INSTITUTION.optional(),
  notes: NOTES.optional(),
  rename: z
    .string()
    .min(1)
    .optional()
    .describe('New name for the account. Its balance, transactions and recurring items follow it.'),
});

export const updateAccount: ToolDefinition<z.infer<typeof updateAccountInput>, unknown> = {
  name: 'finance.update_account',
  description:
    "Change what an account IS without touching its balance: its kind, whether it counts as spendable cash, the institution holding it, a note, or its name. Use this to reclassify an account the owner already has — 'that Growth Account one is actually my brokerage' — or to record an employer match as a note. Everything omitted is left as it was; use finance.set_balance to change the balance.",
  tier: 'auto',
  input: updateAccountInput,
  async execute(input, ctx) {
    const account = await findAccount(ctx.buddi!.db, input.account);
    if (!account) throw new Error(`unknown account: ${input.account}`);
    const includeInCashflow = resolveIncludeInCashflow({
      given: input.includeInCashflow,
      kind: input.kind,
      current: { kind: account.kind, includeInCashflow: account.includeInCashflow },
    });
    const { rows } = await ctx.buddi!.db.query(
      `update finance.accounts
          set name = coalesce($2, name),
              kind = $3,
              include_in_cashflow = $4,
              institution = coalesce($5, institution),
              notes = coalesce($6, notes)
        where id = $1
       returning ${ACCOUNT_COLUMNS}`,
      [
        account.id,
        input.rename ?? null,
        input.kind ?? account.kind,
        includeInCashflow,
        input.institution ?? null,
        input.notes ?? null,
      ],
    );
    const row = mapAccountRow(rows[0]);
    return {
      id: row.id,
      name: row.name,
      previousName: account.name,
      renamed: row.name !== account.name,
      balance: row.balance,
      balanceAsOf: row.balanceAsOf,
      kind: row.kind,
      includeInCashflow: row.includeInCashflow,
      institution: row.institution,
      notes: row.notes,
    };
  },
};

const listAccountsInput = z.object({});

export const listAccounts: ToolDefinition<z.infer<typeof listAccountsInput>, unknown> = {
  name: 'finance.list_accounts',
  description:
    "List every known account with its last recorded balance, the date that balance was recorded, its `kind` and whether it is spendable (`includeInCashflow`). Totals are split on purpose: `cashTotal` is the money that can actually be spent (every account with includeInCashflow), `excludedTotal` is retirement/investment/HSA money — real, counted, but never available for a purchase — broken down per kind in `excludedByKind`, and `netWorth` is cashTotal + excludedTotal minus the recorded debts (finance.list_liabilities). `total` is kept as an alias of `cashTotal` for older callers and is NOT the whole balance sheet. An account whose balance was recorded more than " +
    BALANCE_FRESH_DAYS +
    " days ago carries `stale: true`, with its age in `balanceAgeDays`: say so when you quote it, and prefer reading the live balance and recording it with finance.set_balance over answering from a cold number. Never quote excluded money as though it were cash, and never answer an affordability question from it.",
  tier: 'auto',
  input: listAccountsInput,
  async execute(_input, ctx) {
    const { rows } = await ctx.buddi!.db.query(
      `select ${ACCOUNT_COLUMNS} from finance.accounts order by name`,
    );
    const prefs = await loadPreferences(ctx.buddi!.db);
    const day = today(ctx);
    // A balance is a *reading*, and a reading has an age. The flag is on the
    // row rather than in a note at the end, because the model quotes rows.
    const accounts = rows.map(mapAccountRow).map((r) => ({
      id: r.id,
      name: r.name,
      balance: r.balance,
      balanceAsOf: r.balanceAsOf,
      balanceAgeDays: daysBetween(r.balanceAsOf, day),
      ...(balanceIsStale(r.balanceAsOf, day) ? { stale: true as const } : {}),
      kind: r.kind,
      includeInCashflow: r.includeInCashflow,
      institution: r.institution,
      notes: r.notes,
    }));
    // Debts live in their own table and are never folded into a balance; net
    // worth is reported alongside the split so the three are never confused.
    const { rows: debtRows } = await ctx.buddi!.db.query(
      `select coalesce(sum(balance), 0) as total, count(*)::int as n
         from finance.liabilities where active`,
    );
    const totalLiabilities = num(debtRows[0]?.total);
    const split = splitTotals(accounts, totalLiabilities);
    return {
      accounts,
      cashTotal: split.cashTotal,
      /** @deprecated Alias of `cashTotal`: spendable cash only, never the balance sheet. */
      total: split.cashTotal,
      excludedTotal: split.excludedTotal,
      excludedByKind: split.excludedByKind,
      currency: prefs.currency,
      totalLiabilities,
      liabilityCount: debtRows[0]?.n ?? 0,
      netWorth: split.netWorth,
    };
  },
};

/* -------------------------------------------------------------- merging */

/**
 * A pool or a client inside a transaction: the merge does its reads on the
 * same connection that holds the locks.
 */
type Queryable = Pick<DbArea, 'query'>;

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * An account named the way the other tools accept one: by name, or by the id
 * `list_accounts` hands back. The id path exists because the one moment a
 * caller reaches for these tools is when two accounts share a confusing name.
 */
async function resolveAccount(
  db: Queryable,
  ref: string,
): Promise<AccountRow | undefined> {
  if (UUID.test(ref.trim())) {
    const { rows } = await db.query(
      `select ${ACCOUNT_COLUMNS} from finance.accounts where id = $1`,
      [ref.trim()],
    );
    if (rows[0]) return mapAccountRow(rows[0]);
  }
  return findAccount(db as DbArea, ref);
}

/** A column somewhere in the schema that points at `finance.accounts (id)`. */
export interface AccountReference {
  /** Qualified table, e.g. `finance.transactions`. */
  table: string;
  column: string;
  /** What the owner is told it is, e.g. `recurring`. */
  label: string;
}

/**
 * What a reference is called in an answer. Discovery is by foreign key rather
 * than by a hand-written list, so a table added by a later migration —
 * statements, a balance history — is moved by a merge on the day it exists
 * instead of being silently left pointing at a deleted account. This map only
 * gives the ones we have better words for a better word.
 */
const REFERENCE_LABELS: Record<string, string> = {
  'finance.transactions.account_id': 'transactions',
  'finance.recurring_items.account_id': 'recurring',
  'finance.liabilities.paid_from_account_id': 'liabilities',
  'finance.import_stagings.account_id': 'stagings',
};

function defaultLabel(table: string, column: string): string {
  const bare = table.includes('.') ? table.slice(table.indexOf('.') + 1) : table;
  const camel = bare.replace(/_([a-z])/g, (_m, c: string) => c.toUpperCase());
  return column === 'account_id' ? camel : `${camel}.${column}`;
}

export async function accountReferences(db: Queryable): Promise<AccountReference[]> {
  const { rows } = await db.query<{ table: string; column: string }>(
    `select format('%I.%I', child_ns.nspname, child.relname) as table,
            att.attname as column
       from pg_constraint c
       join pg_class parent on parent.oid = c.confrelid
       join pg_namespace parent_ns on parent_ns.oid = parent.relnamespace
       join pg_class child on child.oid = c.conrelid
       join pg_namespace child_ns on child_ns.oid = child.relnamespace
       join lateral unnest(c.conkey) as k(attnum) on true
       join pg_attribute att on att.attrelid = c.conrelid and att.attnum = k.attnum
      where c.contype = 'f'
        and parent_ns.nspname = 'finance'
        and parent.relname = 'accounts'
      order by 1, 2`,
  );
  return rows.map((r) => ({
    table: r.table,
    column: r.column,
    label: REFERENCE_LABELS[`${r.table}.${r.column}`] ?? defaultLabel(r.table, r.column),
  }));
}

/** How many rows each reference holds for one account, by label. */
export async function countReferences(
  db: Queryable,
  accountId: string,
): Promise<{ counts: Record<string, number>; total: number }> {
  const refs = await accountReferences(db);
  const counts: Record<string, number> = {};
  let total = 0;
  for (const ref of refs) {
    const { rows } = await db.query<{ n: string }>(
      `select count(*)::int as n from ${ref.table} where ${ref.column} = $1`,
      [accountId],
    );
    const n = Number(rows[0]?.n ?? 0);
    counts[ref.label] = (counts[ref.label] ?? 0) + n;
    total += n;
  }
  return { counts, total };
}

/** `{ transactions: 4, recurring: 1 }` -> `4 transactions, 1 recurring`. */
function phrase(counts: Record<string, number>): string {
  const parts = Object.entries(counts)
    .filter(([, n]) => n > 0)
    // Biggest first: what the owner is really being asked about is the ledger,
    // and a line that opens with "2 transactions" says that faster.
    .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
    .map(([label, n]) => `${n} ${label}`);
  return parts.length ? parts.join(', ') : 'nothing';
}

/**
 * The two accounts a merge is about, refused if the merge must not happen.
 *
 * Shared by `describe` and `execute` so the card the owner approves and the
 * work that runs are decided by the same rules: a refusal reaches the owner as
 * a refusal, never as an approval card for something that then fails.
 */
async function planMerge(
  db: Queryable,
  input: { from: string; into: string },
): Promise<{
  from: AccountRow;
  into: AccountRow;
  counts: Record<string, number>;
  total: number;
  balanceKept: 'into' | 'from';
}> {
  const from = await resolveAccount(db, input.from);
  if (!from) throw new Error(`unknown account: ${input.from}`);
  const into = await resolveAccount(db, input.into);
  if (!into) throw new Error(`unknown account: ${input.into}`);
  if (from.id === into.id) {
    throw new Error(
      `${from.name} and ${into.name} are the same account: there is nothing to merge`,
    );
  }
  // Spendable money must not disappear from the cash flow behind a merge: the
  // projection would simply stop seeing it, and a purchase would look
  // unaffordable for no stated reason.
  if (!into.includeInCashflow && from.includeInCashflow) {
    throw new Error(
      `${from.name} is spendable cash and ${into.name} is excluded from the cash flow, so merging would quietly take that money out of every projection. Merge the other way round, or first include ${into.name} in the cash flow with finance.update_account.`,
    );
  }
  const { counts, total } = await countReferences(db, from.id);
  const balanceKept: 'into' | 'from' = from.balanceAsOf > into.balanceAsOf ? 'from' : 'into';
  return { from, into, counts, total, balanceKept };
}

const mergeAccountsInput = z.object({
  from: z
    .string()
    .min(1)
    .describe('The duplicate account to fold in and delete. Its name or its id.'),
  into: z
    .string()
    .min(1)
    .describe('The account to keep. Its name or its id. Everything ends up here.'),
});

export const mergeAccounts: ToolDefinition<z.infer<typeof mergeAccountsInput>, unknown> = {
  name: 'finance.merge_accounts',
  description:
    "Fold one account into another and delete it: every transaction, recurring item, liability and staged import that pointed at `from` is repointed at `into`, and `from` is then removed. This is what you do with a DUPLICATE — the same real account recorded twice under two names ('Checking' and 'Main Checking') — never with two genuinely different accounts, and never as a way of hiding an account from the cash flow (that is finance.update_account with includeInCashflow). `into` keeps its own balance unless `from`'s reading is NEWER, in which case the newer balance and its as-of date are carried over and the result says so. Refused when the two are the same account, when either is unknown, or when `from` is spendable cash and `into` is excluded from the cash flow.",
  tier: 'gated',
  input: mergeAccountsInput,
  async describe(input, ctx) {
    const plan = await planMerge(ctx.buddi!.db, input);
    const balance =
      plan.balanceKept === 'from'
        ? `${plan.into.name} takes ${plan.from.name}'s newer balance ${plan.from.balance} as of ${plan.from.balanceAsOf} (its own is from ${plan.into.balanceAsOf})`
        : `${plan.into.name} keeps its balance ${plan.into.balance} as of ${plan.into.balanceAsOf}`;
    return {
      envelope: {
        tool: 'finance.merge_accounts',
        from: { id: plan.from.id, name: plan.from.name, balance: plan.from.balance, balanceAsOf: plan.from.balanceAsOf },
        into: { id: plan.into.id, name: plan.into.name, balance: plan.into.balance, balanceAsOf: plan.into.balanceAsOf },
        moving: plan.counts,
        balanceKept: plan.balanceKept,
        deleting: { id: plan.from.id, name: plan.from.name },
      },
      preview: `Move ${phrase(plan.counts)} from ${plan.from.name} to ${plan.into.name}, then delete ${plan.from.name}. ${balance}.`,
    };
  },
  async execute(input, ctx) {
    const { plan, moved, rows } = await ctx.buddi!.db.transaction(async (client) => {
      const plan = await planMerge(client, input);
      // Both rows are locked for the whole move, so a concurrent set_balance
      // cannot land on the account that is about to disappear.
      await client.query('select id from finance.accounts where id = any($1) for update', [
        [plan.from.id, plan.into.id],
      ]);
      const refs = await accountReferences(client);
      const moved: Record<string, number> = {};
      for (const ref of refs) {
        const result = await client.query(
          `update ${ref.table} set ${ref.column} = $2 where ${ref.column} = $1`,
          [plan.from.id, plan.into.id],
        );
        moved[ref.label] = (moved[ref.label] ?? 0) + (result.rowCount ?? 0);
      }
      if (plan.balanceKept === 'from') {
        await client.query(
          `update finance.accounts set balance = $2, balance_as_of = $3 where id = $1`,
          [plan.into.id, plan.from.balance, plan.from.balanceAsOf],
        );
      }
      await client.query('delete from finance.accounts where id = $1', [plan.from.id]);
      const { rows } = await client.query(
        `select ${ACCOUNT_COLUMNS} from finance.accounts where id = $1`,
        [plan.into.id],
      );
      return { plan, moved, rows };
    });
    const into = mapAccountRow(rows[0]);
    return {
      merged: true,
      into: {
        id: into.id,
        name: into.name,
        balance: into.balance,
        balanceAsOf: into.balanceAsOf,
        kind: into.kind,
        includeInCashflow: into.includeInCashflow,
      },
      moved,
      balanceKept: plan.balanceKept,
      deleted: { id: plan.from.id, name: plan.from.name },
      ...(plan.balanceKept === 'from'
        ? {
            note: `${plan.from.name}'s balance was the newer reading (${plan.from.balanceAsOf}), so ${into.name} now carries it.`,
          }
        : {}),
    };
  },
};

const removeAccountInput = z.object({
  account: z
    .string()
    .min(1)
    .describe('The account to delete. Its name or its id. It must have nothing pointing at it.'),
});

export const removeAccount: ToolDefinition<z.infer<typeof removeAccountInput>, unknown> = {
  name: 'finance.remove_account',
  description:
    "Delete an account that was recorded by mistake and holds nothing: no transactions, no recurring items, no liability paid from it, no staged import. Refused as soon as anything points at it, naming what does — an account with history is never deleted, because deleting it would take its ledger with it. When the account is a duplicate of one that is being kept, use finance.merge_accounts instead: that moves the history across and then removes the duplicate.",
  tier: 'gated',
  input: removeAccountInput,
  async describe(input, ctx) {
    const account = await resolveAccount(ctx.buddi!.db, input.account);
    if (!account) throw new Error(`unknown account: ${input.account}`);
    const { counts, total } = await countReferences(ctx.buddi!.db, account.id);
    if (total > 0) {
      throw new Error(
        `${account.name} still has ${phrase(counts)} pointing at it, so it cannot be deleted. Use finance.merge_accounts to fold it into the account you are keeping.`,
      );
    }
    return {
      envelope: {
        tool: 'finance.remove_account',
        account: { id: account.id, name: account.name, balance: account.balance, balanceAsOf: account.balanceAsOf },
        references: counts,
      },
      preview: `Delete the account ${account.name} (balance ${account.balance} as of ${account.balanceAsOf}). Nothing points at it.`,
    };
  },
  async execute(input, ctx) {
    const account = await resolveAccount(ctx.buddi!.db, input.account);
    if (!account) throw new Error(`unknown account: ${input.account}`);
    const { counts, total } = await countReferences(ctx.buddi!.db, account.id);
    if (total > 0) {
      throw new Error(
        `${account.name} still has ${phrase(counts)} pointing at it, so it cannot be deleted. Use finance.merge_accounts to fold it into the account you are keeping.`,
      );
    }
    await ctx.buddi!.db.query('delete from finance.accounts where id = $1', [account.id]);
    return { removed: true, id: account.id, name: account.name };
  },
};
