/**
 * The numbers a goal can watch here.
 *
 * A metric is a Home stat without the words (`home.ts`): the same read, the
 * same currency, the same figure — handed back as a number, a unit and a
 * direction so core can compute a pace without ever learning what "debt" is.
 * So nothing below invents a query. Each one goes through the tool that
 * already answers the question — `finance.list_accounts` for the Money block's
 * "Cash" and "Debt", `finance.list_liabilities` for one card — which is what
 * keeps the goal card and the dashboard from ever disagreeing about the week.
 *
 * Two rules that are easy to get wrong and matter for years:
 *
 *  - **`asOf` is the date the number is true of, not now.** A balance here is
 *    a *reading* the owner recorded, and a stale one is the ordinary case:
 *    `asOf` is the newest statement or balance date the figure rests on, so a
 *    goal that stops moving because nobody has synced since Friday says "not
 *    measured since Friday" instead of drawing a flat line as if it were news.
 *  - **Nothing recorded is `null`, not zero.** No spendable account, no
 *    liability: there is no number, and zero would be a claim. A card named
 *    that does not exist is a *throw*, because that one is a mistake somebody
 *    can fix and the message reaches them as the check's note.
 */
import type { MetricDefinition, ToolContext } from '@buddi/core/plugin';
import { z } from 'zod';
import { listAccounts } from './tools/accounts.js';
import { listLiabilities } from './tools/liabilities.js';

/** What `finance.list_accounts` answers, in the fields a metric reads. */
interface AccountsAnswer {
  accounts: Array<{ name: string; balanceAsOf: string; includeInCashflow: boolean }>;
  cashTotal: number;
  totalLiabilities: number;
  currency: string;
}

/** What `finance.list_liabilities` answers, in the fields a metric reads. */
interface LiabilitiesAnswer {
  liabilities: Array<{
    id: string;
    name: string;
    kind: string;
    balance: number;
    asOf: string;
    active: boolean;
  }>;
  currency: string;
}

/**
 * A `YYYY-MM-DD` the plugin stored, as the instant a reading is true of.
 *
 * Midnight UTC, deliberately: the date is what was recorded, and inventing a
 * local time for it would make the same statement land on two different days
 * depending on where the installation is.
 */
export function asOfInstant(day: string): Date {
  return new Date(`${day}T00:00:00.000Z`);
}

/** The latest of a set of `YYYY-MM-DD` days — they sort as strings. */
function newest(days: readonly string[]): string | undefined {
  return [...days].sort().at(-1);
}

async function readAccounts(ctx: ToolContext): Promise<AccountsAnswer> {
  return (await listAccounts.execute({}, ctx)) as AccountsAnswer;
}

async function readLiabilities(ctx: ToolContext): Promise<LiabilitiesAnswer> {
  // The default is active-only, which is what a goal watches: a deactivated
  // card is history, and folding it in would move the number on the day
  // somebody tidied the list.
  return (await listLiabilities.execute({}, ctx)) as LiabilitiesAnswer;
}

/**
 * Everything owed — the figure the Money block labels "Debt".
 *
 * Same source (`finance.list_accounts`) and same currency (the preference), so
 * the goal and the dashboard quote one number. `asOf` is the newest `as_of` a
 * recorded debt carries, because that is the day the sum is true of.
 */
export const totalDebt: MetricDefinition = {
  id: 'finance.total_debt',
  description:
    'Everything you owe across the recorded cards and loans, in your currency — the figure the Money ' +
    'block calls "Debt". It is the sum of the stated balances, as of the newest of them; nothing is ' +
    'recorded, nothing is measured.',
  unit: 'currency',
  direction: 'down',
  params: z.object({}),
  async measure(_params, ctx) {
    const [accounts, debts] = await Promise.all([readAccounts(ctx), readLiabilities(ctx)]);
    const active = debts.liabilities.filter((l) => l.active);
    // Zero debt and no debts recorded look the same in a sum and are not the
    // same fact. Only the first is a number.
    if (active.length === 0) return null;
    const day = newest(active.map((l) => l.asOf));
    if (day === undefined) return null;
    return {
      value: accounts.totalLiabilities,
      currency: accounts.currency,
      asOf: asOfInstant(day),
      note: `across ${active.length} recorded debt${active.length === 1 ? '' : 's'}, newest balance stated ${day}`,
    };
  },
};

const CARD_ACCOUNT = z
  .string()
  .min(1)
  .describe(
    "The card, by the name it is recorded under ('Rewards Card 4242') or by its id — the " +
      'same way every other finance tool names one. Matched case-insensitively.',
  );

/**
 * What one card owes.
 *
 * The narrowing is `account` because that is the word a goal is set in ("get
 * the Amex down to 500"); what it names is a recorded liability of kind
 * `credit_card`, matched the way `finance.card_activity` and
 * `finance.statement_forecast` match one — by name, case-insensitively — or by
 * its id. A name that matches nothing throws, naming the **active** cards:
 * that is a mistake somebody can fix this afternoon, and the sentence reaches
 * them as the check's note rather than as six weeks of silence.
 *
 * **A card that was paid off and deactivated is `null`, not a throw.** That is
 * the happy ending of exactly the goal this metric exists for, and reporting
 * it as an outage — "no card here is Amex", on every check, forever — would be
 * the worst available answer to the best available news. The goal stops being
 * measurable and reads "not measured since …", which is true: there is no
 * balance to read any more. The sentence it would like to carry, "card Amex is
 * no longer active", cannot travel — a bare `null` has no note in core's
 * contract and a throw would make an ending into an error — so it is said
 * here, and the row is still in `finance.list_liabilities` with
 * `activeOnly: false` for whoever asks.
 */
export const cardBalance: MetricDefinition = {
  id: 'finance.card_balance',
  description:
    'What one credit card owes right now, in your currency: the balance recorded against that card, as of ' +
    'the day it was stated. Name the card the way the other finance tools do — its name or its id. A card ' +
    'that has been paid off and deactivated stops being measurable rather than failing.',
  unit: 'currency',
  direction: 'down',
  params: z.object({ account: CARD_ACCOUNT }),
  async measure(params, ctx) {
    const { account } = params as { account: string };
    // Every card, active or not: "this card is finished" and "this card was
    // never here" are two different answers and only one of them is a mistake.
    const debts = (await listLiabilities.execute({ activeOnly: false }, ctx)) as LiabilitiesAnswer;
    const all = debts.liabilities.filter((l) => l.kind === 'credit_card');
    const cards = all.filter((l) => l.active);
    const needle = account.trim().toLowerCase();
    const matches = (c: LiabilitiesAnswer['liabilities'][number]) =>
      c.id === account.trim() || c.name.toLowerCase() === needle;
    const card = cards.find(matches);
    if (card === undefined) {
      // Known, and over. Not measurable, and not an outage.
      if (all.some(matches)) return null;
      if (cards.length === 0) {
        throw new Error(
          'no active credit card is recorded here; record one with finance.set_liability before a goal can watch it.',
        );
      }
      throw new Error(
        `no active card here is "${account}"; the cards recorded in this installation are ${cards
          .map((c) => c.name)
          .join(', ')}.`,
      );
    }
    return {
      value: card.balance,
      currency: debts.currency,
      asOf: asOfInstant(card.asOf),
      note: `${card.name}, balance stated ${card.asOf}`,
    };
  },
};

/**
 * The money that can actually be spent — the Money block's "Cash".
 *
 * `cashTotal`: every account marked `includeInCashflow`, which is what
 * `home.ts` labels "Cash" with the note "spendable accounts". Retirement,
 * brokerage and HSA money is real and counted in net worth, and it is not
 * available, so it is not here. `asOf` is the newest balance date among the
 * accounts the sum is made of.
 */
export const cashAvailable: MetricDefinition = {
  id: 'finance.cash_available',
  description:
    'The money that can actually be spent: the balances of every spendable account added up — the figure ' +
    'the Money block calls "Cash". Retirement, brokerage and HSA money is counted in net worth and never ' +
    'here. As of the newest balance it rests on, which may not be today.',
  unit: 'currency',
  direction: 'up',
  params: z.object({}),
  async measure(_params, ctx) {
    const accounts = await readAccounts(ctx);
    const spendable = accounts.accounts.filter((a) => a.includeInCashflow);
    if (spendable.length === 0) return null;
    const day = newest(spendable.map((a) => a.balanceAsOf));
    if (day === undefined) return null;
    return {
      value: accounts.cashTotal,
      currency: accounts.currency,
      asOf: asOfInstant(day),
      note: `across ${spendable.length} spendable account${spendable.length === 1 ? '' : 's'}, newest balance recorded ${day}`,
    };
  },
};

export const financeMetrics: MetricDefinition[] = [totalDebt, cardBalance, cashAvailable];
