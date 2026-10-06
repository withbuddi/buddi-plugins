/**
 * The tools behind the Money page: Mark paid on a bill coming up, the page's
 * settings, and `finance.setup` — the first-run sheet "Which bank or account?"
 * that the host's first-run bank row opens, and that the page offers too.
 *
 * `finance.mark_paid` is an agent's tool as much as the owner's ("I paid the
 * rent"); the other two are the owner's alone (`ownerOnly`): a model never
 * sees them, so no agent turns amounts on for the lock screen or starts a run
 * of its own from a setup it was not asked to make.
 */
import { ToolRefusal, type DbArea, type ToolContext, type ToolDefinition } from '@buddi/core/plugin';
import { z } from 'zod';
import { ACCOUNT_KINDS, type AccountKind } from '../accounts.js';
import { addDays, occurrencesBetween, type Cadence } from '../projection.js';
import { ADVISOR_ROLES } from '../sentinels/roles.js';
import { setBalance } from './accounts.js';
import { setPreferences } from './preferences.js';
import { ensureAccount, findAccount, loadPreferences, num, recordCurrency, today, toDateString } from './shared.js';

const DATE = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'expected a YYYY-MM-DD date');

/**
 * A page sends `''` for an optional text or select field nobody touched (an
 * untouched number is left out): `''` is "nothing said", read as absent.
 */
const EMPTY = z.literal('');
const said = <T>(v: T | '' | undefined): T | undefined => (v === '' ? undefined : v);

/** The deep link every surface names: the Money page on the rail. */
export const MONEY_ROUTE = '#/p/finance/money';

/** The preference key behind "Show amounts on the lock screen". */
export const LOCK_AMOUNTS_KEY = 'lock_screen_amounts';

export async function lockScreenAmounts(db: DbArea): Promise<boolean> {
  const { rows } = await db.query<{ value: unknown }>(`select value from finance.preferences where key = $1`, [LOCK_AMOUNTS_KEY]);
  return rows[0]?.value === true;
}

/* ------------------------------------------------------------------ *
 * Mark paid
 * ------------------------------------------------------------------ */

const markPaidInput = z.object({
  id: z.string().uuid().describe('The recurring item, by id (finance.list_recurring).'),
  through: DATE.optional().describe(
    'The occurrence that was paid, YYYY-MM-DD: that one and every earlier one are done. Defaults to the next occurrence from today.',
  ),
  balance: z.number().optional().describe(
    "The balance of the item's account now, when the payment has already left it: recorded as today's balance, as finance.set_balance would.",
  ),
});

export const markPaid: ToolDefinition<z.infer<typeof markPaidInput>, unknown> = {
  name: 'finance.mark_paid',
  description:
    "Mark a recurring charge's occurrence as paid — the owner paid the rent early, or a bill went out before its date. That occurrence and every earlier one are left out of what is coming up, the cash-flow projection and a card's statement forecast, so the money is not spent twice. Pass `balance` when the owner says what the account holds now: it is recorded as today's balance. Without it, say that the projection still starts from the last recorded balance.",
  tier: 'auto',
  input: markPaidInput,
  async execute(input, ctx) {
    const db = ctx.buddi!.db;
    const { rows } = await db.query(
      `select r.id, r.name, r.kind, r.cadence, r.anchor_date, r.paid_through, r.active, a.name as account_name
         from finance.recurring_items r left join finance.accounts a on a.id = r.account_id
        where r.id = $1`,
      [input.id],
    );
    const item = rows[0];
    if (!item || item.active === false) throw new ToolRefusal('No active recurring item has that id.');
    const day = today(ctx);
    const through =
      input.through ??
      occurrencesBetween(
        {
          name: item.name as string,
          kind: item.kind as 'income' | 'charge',
          amount: 1,
          cadence: item.cadence as Cadence,
          anchorDate: toDateString(item.anchor_date),
          paidThrough: item.paid_through ? toDateString(item.paid_through) : null,
        },
        day,
        addDays(day, 400),
      )[0];
    if (!through) throw new ToolRefusal(`${item.name as string} has nothing left to pay.`);
    // Never moves backwards: marking an older one paid again changes nothing.
    await db.query(
      `update finance.recurring_items set paid_through = greatest(coalesce(paid_through, $2::date), $2::date) where id = $1`,
      [input.id, through],
    );
    let balance: unknown = null;
    const account = (item.account_name as string | null) ?? null;
    if (input.balance !== undefined && account) {
      balance = await setBalance.execute({ account, balance: input.balance }, ctx);
    }
    const words = `${item.name as string} is marked paid${account && input.balance !== undefined ? `, and ${account} holds ${input.balance} as of today` : ''}.`;
    return { id: item.id, name: item.name, paidThrough: through, account, balance, message: words };
  },
};

/* ------------------------------------------------------------------ *
 * The page's settings
 * ------------------------------------------------------------------ */

const settingsInput = z.object({
  amountsOnLockScreen: z.boolean().optional(),
  currency: z.union([z.string().trim().min(3).max(8), EMPTY]).optional(),
  safetyFloor: z.number().optional(),
});

export const setMoneySettings: ToolDefinition<z.infer<typeof settingsInput>, unknown> = {
  name: 'finance.set_money_settings',
  description: "The Money settings: the currency, the safety floor, and whether the lock screen's Coming up shows amounts. The owner's alone.",
  tier: 'auto',
  ownerOnly: true,
  input: settingsInput,
  async execute(input, ctx) {
    const db = ctx.buddi!.db;
    if (input.amountsOnLockScreen !== undefined) {
      await db.query(
        `insert into finance.preferences (key, value) values ($1, $2::jsonb)
         on conflict (key) do update set value = excluded.value`,
        [LOCK_AMOUNTS_KEY, JSON.stringify(input.amountsOnLockScreen)],
      );
    }
    const currency = said(input.currency);
    if (currency !== undefined || input.safetyFloor !== undefined) {
      await setPreferences.execute(
        {
          ...(currency !== undefined ? { currency: currency.toUpperCase() } : {}),
          ...(input.safetyFloor !== undefined ? { safetyFloor: input.safetyFloor } : {}),
        },
        ctx,
      );
    }
    return { ...(await moneySettings(ctx)), message: 'Saved.' };
  },
};

export async function moneySettings(ctx: ToolContext): Promise<{ currency: string; safetyFloor: number; amountsOnLockScreen: boolean }> {
  const prefs = await loadPreferences(ctx.buddi!.db, ctx.buddi!.owner);
  return { currency: prefs.currency, safetyFloor: prefs.safetyFloor, amountsOnLockScreen: await lockScreenAmounts(ctx.buddi!.db) };
}

/* ------------------------------------------------------------------ *
 * First run: "Which bank or account?"
 * ------------------------------------------------------------------ */

const setupInput = z
  .object({
    name: z.string().trim().min(1).max(80).describe("The account's name as the owner says it: 'Checking', 'Revolut'."),
    kind: z.union([z.enum(ACCOUNT_KINDS), EMPTY]).optional().describe("What it is; 'cash' (a current account) when left out."),
    balance: z.number().optional().describe('What it holds now. Required unless a statement is handed in.'),
    asOf: z.union([DATE, EMPTY]).optional().describe('The day that balance is from; today when left out.'),
    institution: z.union([z.string().trim().min(1).max(80), EMPTY]).optional().describe('The bank, when it is not in the name.'),
    currency: z.union([z.string().trim().regex(/^[A-Za-z]{3}$/, 'a three-letter currency code'), EMPTY]).optional().describe(
      "The currency the owner confirmed on the sheet: 'USD', 'EUR'. Left out, the one their time zone suggests is kept.",
    ),
    artifactId: z.union([z.string().uuid(), EMPTY]).optional().describe(
      'A statement already in the Files library: handed to the advisor, who reads it into this account and asks before anything is written.',
    ),
  })
  .refine((v) => v.balance !== undefined || said(v.artifactId) !== undefined, {
    message: 'say what the account holds, or hand in a statement',
    path: ['balance'],
  });

export type SetupInput = z.infer<typeof setupInput>;

export interface SetupResult {
  accountId: string;
  name: string;
  kind: AccountKind;
  balance: number | null;
  balanceAsOf: string | null;
  created: boolean;
  /** Present when a statement was handed in. */
  statement?: { artifactId: string; handedTo: string | null };
  /** The sentence the sheet shows. */
  message: string;
  /** Where the owner goes next. */
  link: string;
}

/** What the advisor is asked to do with a statement the setup sheet took. */
export function statementPrompt(account: string, artifactId: string, filename: string | null): string {
  return [
    `The owner just set up the account "${account}" and handed in a statement${filename ? ` (${filename})` : ''}, file ${artifactId} in the Files library.`,
    `Stage it with finance.stage_import (account "${account}", source "statement", artifactId "${artifactId}"): a CSV goes in as it is, with file "${artifactId}" — never retyped or cleaned first; a PDF you read yourself and stage as rows.`,
    'Record the closing balance the statement states with finance.set_balance, as of the statement\'s own date.',
    'Then show the owner the staged summary in plain words and ask before committing; never commit on your own.',
    `End by naming the Money page (${MONEY_ROUTE}) where the account now shows.`,
  ].join(' ');
}

export const setupTool: ToolDefinition<SetupInput, SetupResult> = {
  name: 'finance.setup',
  description:
    "First run's \"Which bank or account?\": an account by name, kind and balance — or a statement from the Files library, handed to the advisor to read into it. Answers { accountId }. The owner's alone.",
  tier: 'auto',
  ownerOnly: true,
  input: setupInput,
  async execute(raw, ctx) {
    const db = ctx.buddi!.db;
    const input = {
      name: raw.name,
      balance: raw.balance,
      kind: said(raw.kind),
      asOf: said(raw.asOf),
      institution: said(raw.institution),
      artifactId: said(raw.artifactId),
      currency: said(raw.currency),
    };
    // The sheet showed a currency: what the owner left there is what they confirmed.
    if (input.currency) await setPreferences.execute({ currency: input.currency.toUpperCase() }, ctx);
    else await recordCurrency(db, ctx.buddi!.owner);
    const existing = await findAccount(db, input.name);
    let account: { id: string; name: string; kind: AccountKind; balance: number | null; balanceAsOf: string | null };
    if (input.balance !== undefined) {
      const saved = (await setBalance.execute(
        {
          account: input.name,
          balance: input.balance,
          ...(input.asOf ? { asOf: input.asOf } : {}),
          ...(input.kind ? { kind: input.kind } : {}),
          ...(input.institution ? { institution: input.institution } : {}),
        },
        ctx,
      )) as { id: string; name: string; kind: AccountKind; balance: number; balanceAsOf: string };
      account = saved;
    } else {
      const row = await ensureAccount(db, input.name, input.kind ? { kind: input.kind } : {});
      if (input.institution) await db.query(`update finance.accounts set institution = $2 where id = $1`, [row.id, input.institution]);
      // A brand-new account with no balance yet holds no reading; the statement brings one.
      account = { id: row.id, name: row.name, kind: row.kind, balance: existing ? row.balance : null, balanceAsOf: existing ? row.balanceAsOf : null };
    }

    let statement: SetupResult['statement'];
    let sentence = existing ? `${account.name} is updated.` : `${account.name} is added.`;
    if (input.artifactId) {
      const file = await ctx.buddi!.files?.get(input.artifactId).catch(() => null);
      if (!file) throw new ToolRefusal('That statement is not in your Files library.');
      const advisor = ctx.buddi!.owner.agentForRole(ADVISOR_ROLES[0]) ?? null;
      // A buddi that starts no runs from here says so by refusing: the file stays in Files.
      const handed =
        advisor !== null &&
        ctx.buddi!.schedule !== undefined &&
        (await ctx.buddi!.schedule
          .enqueueRun({
            agentId: advisor,
            prompt: statementPrompt(account.name, input.artifactId, file.filename ?? null),
            dedupKey: `finance.setup:${input.artifactId}`,
          })
          .then(() => true, () => false));
      if (handed) {
        statement = { artifactId: input.artifactId, handedTo: advisor };
        sentence += ' Your CFO is reading the statement and will ask before anything is written.';
      } else {
        statement = { artifactId: input.artifactId, handedTo: null };
        sentence += ' The statement is kept in Files: add the CFO from the catalogue and hand it over in the chat.';
      }
    }
    return {
      accountId: account.id,
      name: account.name,
      kind: account.kind,
      balance: account.balance === null ? null : num(account.balance),
      balanceAsOf: account.balanceAsOf,
      created: !existing,
      ...(statement ? { statement } : {}),
      message: sentence,
      link: MONEY_ROUTE,
    };
  },
};

export const moneyTools = [markPaid, setMoneySettings, setupTool];
