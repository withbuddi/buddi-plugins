/**
 * The decisions every finance sentinel makes, as pure functions.
 *
 * Each sentinel is then two things and nothing else: a query that shapes rows,
 * and a call into here. That split is what makes the rules testable without a
 * database — and it keeps the judgement ("three days is urgent, thirty is
 * not") in one readable place instead of scattered through SQL.
 *
 * No clock and no timezone: `today` always comes in as a `YYYY-MM-DD` string
 * already rendered in the owner's zone.
 */
import {
  DEFAULT_UTILIZATION_TARGET,
  closingSentence,
  nextDayOfMonth,
  overviewCard,
} from '../credit.js';
import { daysBetween } from '../projection.js';
import type { Finding } from './types.js';

/** A breach inside this many days is urgent rather than informational. */
export const URGENT_BREACH_DAYS = 7;
/** A minimum payment falling inside this many days is urgent. */
export const URGENT_DUE_DAYS = 3;
/** A statement closing inside this many days is worth a nudge. */
export const STATEMENT_WINDOW_DAYS = 3;
/**
 * Utilization (percent) above which a closing statement is worth reporting,
 * when neither the card nor the installation says otherwise.
 */
export const STATEMENT_UTILIZATION = DEFAULT_UTILIZATION_TARGET;
/** A balance not confirmed for this many days is stale. */
export const STALE_BALANCE_DAYS = 14;
/** A receipt unmatched for this many days has stopped waiting for its charge. */
export const UNMATCHED_RECEIPT_DAYS = 7;
/** An artifact nothing referenced within this many hours was never processed. */
export const UNPROCESSED_ARTIFACT_HOURS = 24;

function money(amount: number, currency: string): string {
  return `${amount.toFixed(2)} ${currency}`;
}

/** Every money finding opens the Money page, where the figures behind it are. */
export const OPEN_MONEY = { kind: 'open', label: 'Open Money', page: 'money' } as const;

/** The brief's last sentence: the agent names the page when it reports. */
export const MONEY_PAGE_NOTE = ' The owner sees all of this on the Money page (#/p/finance/money): name it when you report.';

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

/** `2026-09-14` → `14 Sep`: how an owner line names a day. The brief keeps the ISO date. */
export function shortDay(iso: string): string {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(iso);
  if (!m) return iso;
  return `${Number(m[3])} ${MONTHS[Number(m[2]) - 1] ?? m[2]}`;
}

/* ------------------------------------------------------------------ *
 * floor-breach
 * ------------------------------------------------------------------ */

/**
 * Who speaks about a finding. Resolved from the roster by role at poll time;
 * `undefined` means "nobody holds the role", and the finding then names no
 * agent at all rather than naming one that may not exist.
 */
export interface Addressed {
  agentId?: string | undefined;
}

/** `agentId: x` when there is one, and no key at all when there is not. */
function addressed(agentId: string | undefined): { agentId?: string } {
  return agentId === undefined ? {} : { agentId };
}

export interface FloorBreachInput extends Addressed {
  /** From the projection: the first day the balance drops below the floor. */
  firstBreachDate: string | null;
  minBalance: number;
  minBalanceDate: string;
  safetyFloor: number;
  currency: string;
  /** The projection's first day, in the owner's zone. */
  startDate: string;
  horizonDays: number;
}

/**
 * One finding, or none. A breach inside a week is urgent: there is still time
 * to move something. A breach further out is information — the owner may well
 * fix it by living their month, and waking them at 3am for day 26 is noise.
 *
 * With no safety floor recorded the floor is zero, so "breach" means the
 * account actually goes negative; that is never not worth saying.
 */
export function floorBreachFinding(input: FloorBreachInput): Finding | null {
  const { firstBreachDate } = input;
  if (firstBreachDate === null) return null;
  const daysAway = daysBetween(input.startDate, firstBreachDate);
  if (daysAway < 0 || daysAway >= input.horizonDays) return null;
  const severity = daysAway <= URGENT_BREACH_DAYS ? 'urgent' : 'info';
  const floorPhrase =
    input.safetyFloor > 0
      ? `the ${money(input.safetyFloor, input.currency)} safety floor`
      : 'zero';
  return {
    key: `floor-breach:${firstBreachDate}`,
    severity,
    title:
      severity === 'urgent'
        ? `Cash drops below ${floorPhrase} on ${firstBreachDate}`
        : `Cash is projected below ${floorPhrase} on ${firstBreachDate}`,
    ownerLine:
      `Your cash is on course to drop below ${floorPhrase} on ${shortDay(firstBreachDate)}, ` +
      `${daysAway === 0 ? 'today' : `in ${daysAway} day${daysAway === 1 ? '' : 's'}`}: something needs moving before then.`,
    kind: 'floor-breach',
    actions: [OPEN_MONEY, { kind: 'ask' }],
    detail:
      `The projection crosses ${floorPhrase} on ${firstBreachDate}, ` +
      `${daysAway} day${daysAway === 1 ? '' : 's'} from ${input.startDate}. ` +
      `The low point is ${money(input.minBalance, input.currency)} on ${input.minBalanceDate}.` +
      MONEY_PAGE_NOTE,
    ...addressed(input.agentId),
    data: {
      firstBreachDate,
      daysAway,
      minBalance: input.minBalance,
      minBalanceDate: input.minBalanceDate,
      safetyFloor: input.safetyFloor,
      currency: input.currency,
      horizonDays: input.horizonDays,
    },
  };
}

/* ------------------------------------------------------------------ *
 * minimum-due
 * ------------------------------------------------------------------ */

export interface RecurringCharge {
  name: string;
  /** False for an item attached to an account the cash flow cannot see. */
  includedInCashflow: boolean;
}

export interface LiabilityDue {
  name: string;
  minimumPayment: number;
  dueDay: number;
  balance: number;
  /** True when a payment_events row already marks this due date paid. */
  paid: boolean;
}

/** Letters and digits only — 'Amex Gold *1234' and 'amex gold' meet here. */
export function normalizeName(name: string): string {
  return name.toLowerCase().replace(/[^a-z0-9]+/g, '');
}

/**
 * True when a recurring charge we actually model would pay this liability.
 *
 * The point is narrow: if the owner set up autopay AND told us about it as a
 * recurring item on an account the projection can see, the money is already
 * accounted for and nothing needs saying. An item on an excluded account (a
 * 401k, a brokerage) is not a payment the cash flow believes in, so it does
 * not silence the sentinel.
 */
export function autopayModeled(
  liabilityName: string,
  items: readonly RecurringCharge[],
): boolean {
  const target = normalizeName(liabilityName);
  if (target === '') return false;
  return items.some((item) => {
    if (!item.includedInCashflow) return false;
    const name = normalizeName(item.name);
    if (name === '') return false;
    return name.includes(target) || target.includes(name);
  });
}

export interface MinimumDueOptions extends Addressed {
  today: string;
  currency: string;
  items: readonly RecurringCharge[];
}

/**
 * A minimum payment due within three days that nothing has paid and nothing
 * will pay on its own. This is the one condition that outranks everything
 * else in the credit coach's priority order, so it is always urgent.
 */
export function minimumDueFindings(
  liabilities: readonly LiabilityDue[],
  opts: MinimumDueOptions,
): Finding[] {
  const out: Finding[] = [];
  for (const liability of liabilities) {
    if (!(liability.minimumPayment > 0)) continue;
    const dueDate = nextDayOfMonth(opts.today, liability.dueDay);
    const daysAway = daysBetween(opts.today, dueDate);
    if (daysAway > URGENT_DUE_DAYS) continue;
    if (liability.paid) continue;
    if (autopayModeled(liability.name, opts.items)) continue;
    out.push({
      key: `minimum-due:${liability.name}:${dueDate}`,
      severity: 'urgent',
      title: `${liability.name}: ${money(liability.minimumPayment, opts.currency)} minimum due ${dueDate}`,
      ownerLine:
        `The ${money(liability.minimumPayment, opts.currency)} minimum on ${liability.name} is due ` +
        `${daysAway === 0 ? 'today' : `in ${daysAway} day${daysAway === 1 ? '' : 's'}`}, and no payment is recorded.`,
      kind: 'minimum-due',
      subject: { id: liability.name, label: liability.name },
      group: { title: '{count} minimum payments are due in the next few days' },
      actions: [
        {
          kind: 'fill',
          label: 'I paid it',
          groupLabel: 'Record payments',
          title: 'Record payments',
          tool: 'finance.record_payment',
          args: { liability: liability.name, dueOn: dueDate, status: 'paid_on_time' },
          field: {
            name: 'amount',
            label: liability.name,
            type: 'number',
            value: liability.minimumPayment,
            hint: `minimum due ${shortDay(dueDate)}`,
          },
        },
        OPEN_MONEY,
        { kind: 'ask' },
      ],
      detail:
        `The minimum payment on ${liability.name} is due on ${dueDate} ` +
        `(${daysAway === 0 ? 'today' : `in ${daysAway} day${daysAway === 1 ? '' : 's'}`}). ` +
        'No payment is recorded for it and no modelled autopay covers it.' +
        MONEY_PAGE_NOTE,
      ...addressed(opts.agentId),
      data: {
        liability: liability.name,
        dueDate,
        daysAway,
        minimumPayment: liability.minimumPayment,
        balance: liability.balance,
        currency: opts.currency,
      },
    });
  }
  return out;
}

/* ------------------------------------------------------------------ *
 * statement-closing
 * ------------------------------------------------------------------ */

export interface ClosingCard {
  name: string;
  balance: number;
  creditLimit: number | null;
  statementDay: number | null;
  /** The day the snapshot reaches the bureaus. Null: the closing day. */
  reportsDay?: number | null;
  /** This card's own target, percent. Null falls back to the installation's. */
  utilizationTarget?: number | null;
  /**
   * What the card is on course to report on the closing day, when it can be
   * worked out: the balance today, plus the recurring charges billed to the
   * card that land before the close, less any payment scheduled before it.
   * Null falls back to the balance as it stands.
   */
  forecastBalance?: number | null;
}

/**
 * Cards closing within three days while still over the target they are held
 * to. Paying before the closing day is the only thing that changes what the
 * bureaus see for that cycle, which is what makes the window worth a nudge —
 * and only a nudge, so it is never urgent.
 *
 * One finding per card per cycle: the key carries the closing date, so the
 * twice-daily run reports each card's cycle once and the next cycle is a new
 * fact. The title is the whole recommendation, computed — the amount, the two
 * weekdays and the target all come out of the numbers, so a model reading it
 * has nothing left to work out and nothing left to get wrong.
 */
export function statementClosingFindings(
  cards: readonly ClosingCard[],
  opts: Addressed & {
    today: string;
    currency: string;
    defaultUtilizationTarget?: number;
  },
): Finding[] {
  const out: Finding[] = [];
  const fallback = opts.defaultUtilizationTarget ?? DEFAULT_UTILIZATION_TARGET;
  for (const card of cards) {
    if (card.statementDay === null) continue;
    const view = overviewCard(
      {
        name: card.name,
        balance: card.balance,
        creditLimit: card.creditLimit,
        statementClosesDay: card.statementDay,
        reportsDay: card.reportsDay ?? null,
        utilizationTarget: card.utilizationTarget ?? null,
        forecastBalance: card.forecastBalance ?? null,
      },
      { today: opts.today, defaultUtilizationTarget: fallback },
    );
    if (!view.overTarget) continue;
    if (view.daysUntilClosing === null || view.daysUntilClosing > STATEMENT_WINDOW_DAYS) continue;
    const sentence = closingSentence(view);
    // No sentence means no limit, so no target and nothing to recommend.
    if (sentence === null) continue;
    const closeDate = view.statementClosesOn as string;
    out.push({
      key: `statement:${card.name}:${closeDate}`,
      severity: 'info',
      title: sentence,
      ownerLine: `${sentence}.`,
      kind: 'statement',
      subject: { id: card.name, label: card.name },
      group: { title: '{count} cards close soon over their target' },
      actions: [OPEN_MONEY, { kind: 'ask' }],
      detail:
        `${card.name} closes on ${closeDate}, ` +
        `${view.daysUntilClosing === 0 ? 'today' : `in ${view.daysUntilClosing} day${view.daysUntilClosing === 1 ? '' : 's'}`}` +
        (view.reportsOn !== null && view.reportsOn !== closeDate
          ? `, and reaches the bureaus on ${view.reportsOn}. `
          : '. ') +
        (card.forecastBalance === null || card.forecastBalance === undefined
          ? `It is at ${money(view.reportedBalanceEstimate, opts.currency)} of a ${money(card.creditLimit as number, opts.currency)} limit. `
          : `It is on course to report ${money(view.reportedBalanceEstimate, opts.currency)} of a ${money(card.creditLimit as number, opts.currency)} limit once the charges billed to it have landed. `) +
        `Paying ${money(view.paymentToTarget as number, opts.currency)} on or before ${view.payBy} ` +
        `brings the reported figure to ${view.utilizationTarget}%. ` +
        'A payment made after the closing day changes nothing until the next cycle.' +
        MONEY_PAGE_NOTE,
      ...addressed(opts.agentId),
      data: {
        card: card.name,
        sentence,
        closeDate,
        reportsOn: view.reportsOn,
        daysAway: view.daysUntilClosing,
        utilization: view.reportedUtilizationEstimate,
        utilizationTarget: view.utilizationTarget,
        payment: view.paymentToTarget,
        payBy: view.payBy,
        balance: card.balance,
        /** Null when no forecast was available; then `balance` is what was scored. */
        forecastBalance: card.forecastBalance ?? null,
        creditLimit: card.creditLimit,
        currency: opts.currency,
      },
    });
  }
  return out;
}

/* ------------------------------------------------------------------ *
 * stale-balance
 * ------------------------------------------------------------------ */

export interface StaleAccount {
  name: string;
  balance: number;
  balanceAsOf: string;
}

/**
 * A projection is only as good as the balance it starts from. Two weeks
 * without a confirmation is the point where the start balance has quietly
 * become a guess, so the finding names the account and the date, one each —
 * asking about five accounts at once gets none of them answered.
 */
export function staleBalanceFindings(
  accounts: readonly StaleAccount[],
  opts: Addressed & { today: string; currency: string; maxAgeDays?: number },
): Finding[] {
  const maxAge = opts.maxAgeDays ?? STALE_BALANCE_DAYS;
  const out: Finding[] = [];
  for (const account of accounts) {
    const age = daysBetween(account.balanceAsOf, opts.today);
    if (age <= maxAge) continue;
    out.push({
      key: `stale:${account.name}:${account.balanceAsOf}`,
      severity: 'info',
      title: `${account.name} balance is ${age} days old`,
      ownerLine:
        `${account.name} hasn't been updated in ${age} days (last ${money(account.balance, opts.currency)}), ` +
        'so the cash forecast starts from a guess.',
      kind: 'stale-balance',
      subject: { id: account.name, label: account.name },
      group: {
        title: `{count} balances not updated in ${Math.floor(maxAge / 7)}+ weeks`,
        ownerLine: 'The cash forecast starts from these numbers. Type what each holds today.',
      },
      actions: [
        {
          kind: 'fill',
          label: 'Update',
          groupLabel: 'Update them',
          title: 'Update balances',
          tool: 'finance.set_balance',
          args: { account: account.name },
          field: {
            name: 'balance',
            label: account.name,
            type: 'number',
            value: account.balance,
            hint: `${money(account.balance, opts.currency)} on ${shortDay(account.balanceAsOf)}`,
          },
        },
        OPEN_MONEY,
        { kind: 'ask' },
      ],
      detail:
        `${account.name} was last confirmed at ${money(account.balance, opts.currency)} ` +
        `on ${account.balanceAsOf}, ${age} days ago. Every projection starts from that number.` +
        MONEY_PAGE_NOTE,
      ...addressed(opts.agentId),
      data: {
        account: account.name,
        balance: account.balance,
        balanceAsOf: account.balanceAsOf,
        ageDays: age,
        currency: opts.currency,
      },
    });
  }
  return out;
}

/* ------------------------------------------------------------------ *
 * unmatched-receipts
 * ------------------------------------------------------------------ */

export interface UnmatchedReceipt {
  id: string;
  merchant: string;
  occurredOn: string;
  total: number;
  currency: string;
}

/**
 * One finding for the whole set, never one per receipt: a receipt that never
 * found its charge is a bookkeeping loose end, and five separate nudges about
 * loose ends is how an owner learns to ignore the sentinel entirely.
 */
export function unmatchedReceiptsFinding(
  receipts: readonly UnmatchedReceipt[],
  opts: Addressed & { today: string; maxAgeDays?: number },
): Finding | null {
  const maxAge = opts.maxAgeDays ?? UNMATCHED_RECEIPT_DAYS;
  const stale = receipts
    .filter((r) => daysBetween(r.occurredOn, opts.today) > maxAge)
    .sort((a, b) => (a.occurredOn < b.occurredOn ? -1 : a.occurredOn > b.occurredOn ? 1 : 0));
  const oldest = stale[0];
  if (oldest === undefined) return null;
  const lines = stale.map(
    (r) => `- ${r.occurredOn} ${r.merchant} ${money(r.total, r.currency)}`,
  );
  return {
    key: `unmatched-receipts:${oldest.occurredOn}:${stale.length}`,
    severity: 'info',
    title: `${stale.length} receipt${stale.length === 1 ? '' : 's'} still unmatched after ${maxAge} days`,
    ownerLine:
      `${stale.length === 1 ? 'A receipt has' : `${stale.length} receipts have`} no matching charge after ${maxAge} days, ` +
      `the oldest from ${shortDay(oldest.occurredOn)}: the charge never posted, or the ledger is missing it.`,
    kind: 'unmatched-receipts',
    actions: [{ kind: 'ask', label: 'Match them' }, { kind: 'dismiss', label: 'Not needed' }],
    detail: [
      `These receipts have no transaction behind them, the oldest from ${oldest.occurredOn}:`,
      ...lines,
      'Either the charge never posted, or the ledger is missing it.',
    ].join('\n'),
    ...addressed(opts.agentId),
    data: { count: stale.length, maxAgeDays: maxAge, receipts: stale },
  };
}

/* ------------------------------------------------------------------ *
 * unprocessed-artifacts
 * ------------------------------------------------------------------ */

export interface UnprocessedArtifact {
  id: string;
  filename: string | null;
  kind: string;
  mime: string;
  /** `YYYY-MM-DD`, rendered in the owner's zone. */
  createdOn: string;
  ageHours: number;
}

/**
 * Documents the owner handed in that nothing ever read. A statement that was
 * sent, acknowledged and then never staged is the most expensive kind of
 * silence: the owner believes the ledger has it.
 */
export function unprocessedArtifactsFinding(
  artifacts: readonly UnprocessedArtifact[],
  opts: Addressed = {},
): Finding | null {
  if (artifacts.length === 0) return null;
  const sorted = [...artifacts].sort((a, b) => b.ageHours - a.ageHours);
  const oldest = sorted[0] as UnprocessedArtifact;
  const lines = sorted.map(
    (a) => `- ${a.createdOn} ${a.filename ?? `(${a.kind}, ${a.mime})`}`,
  );
  return {
    key: `unprocessed-artifacts:${oldest.createdOn}:${sorted.length}`,
    severity: 'info',
    title: `${sorted.length} file${sorted.length === 1 ? '' : 's'} handed in and never used`,
    ownerLine:
      `${sorted.length === 1 ? 'A file you handed in was' : `${sorted.length} files you handed in were`} never used, ` +
      `the oldest from ${shortDay(oldest.createdOn)}: the ledger may be missing what's in them.`,
    kind: 'unprocessed-artifacts',
    actions: [
      { kind: 'open', label: 'Review', place: 'files' },
      { kind: 'dismiss', label: 'Not needed' },
      { kind: 'ask' },
    ],
    detail: [
      `Nothing in the ledger references these, the oldest from ${oldest.createdOn}:`,
      ...lines,
      'They were received but no transaction, receipt or staged import came out of them.',
    ].join('\n'),
    ...addressed(opts.agentId),
    data: { count: sorted.length, artifacts: sorted },
  };
}
