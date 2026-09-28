/**
 * Credit arithmetic. Pure: no DB, no clock — every date comes in as a string.
 *
 * Two mechanics drive a score more than anything else the owner can move in a
 * month: the balance reported at statement close (utilization) and whether the
 * minimum landed on time (payment history). Everything here computes one of
 * those two; the model explains, it never computes.
 */
import { payoff, type PayoffResult } from './amortization.js';

/** Utilization thresholds the scoring models notice, as fractions. */
export const GOOD_UTILIZATION = 0.3;
export const EXCELLENT_UTILIZATION = 0.1;

/** Days before the statement closes that a payment should already be posted. */
export const PAY_BEFORE_DAYS = 3;

export function round2(n: number): number {
  return Math.round((n + Number.EPSILON) * 100) / 100;
}

export interface CreditCard {
  name: string;
  balance: number;
  creditLimit: number | null;
  apr: number | null;
  minimumPayment: number;
  statementDay: number | null;
}

export interface CardUtilization extends CreditCard {
  /** Percent, 0-100+. Null when no limit is recorded. */
  utilization: number | null;
  /** Amount to PAY now so the balance lands at 30% / 10% of the limit. */
  paymentFor30: number | null;
  paymentFor10: number | null;
  /** The balance that remains once that payment is made. */
  targetBalanceFor30: number | null;
  targetBalanceFor10: number | null;
}

/** Percent used of the limit; null when the limit is unknown. */
export function utilizationPercent(balance: number, creditLimit: number | null): number | null {
  if (creditLimit === null || !(creditLimit > 0)) return null;
  return round2((balance / creditLimit) * 100);
}

/** The amount to PAY to bring the balance down to `target` of the limit. */
export function payDownTo(
  balance: number,
  creditLimit: number | null,
  target: number,
): number | null {
  if (creditLimit === null || !(creditLimit > 0)) return null;
  return round2(Math.max(0, balance - creditLimit * target));
}

/** The balance left once `payDownTo` has been paid; null when the limit is unknown. */
export function targetBalanceAt(
  balance: number,
  creditLimit: number | null,
  target: number,
): number | null {
  const payment = payDownTo(balance, creditLimit, target);
  return payment === null ? null : round2(balance - payment);
}

/**
 * APR descending, cards without an APR last, ties broken by utilization then
 * name — so the order is total and the same input always plans the same way.
 */
export function byAprDesc(a: CreditCard, b: CreditCard): number {
  const aprA = a.apr ?? -1;
  const aprB = b.apr ?? -1;
  if (aprA !== aprB) return aprB - aprA;
  const uA = utilizationPercent(a.balance, a.creditLimit) ?? -1;
  const uB = utilizationPercent(b.balance, b.creditLimit) ?? -1;
  if (uA !== uB) return uB - uA;
  return a.name.localeCompare(b.name);
}

export interface UtilizationReport {
  cards: CardUtilization[];
  /** Summed across cards that have a limit. */
  totalBalance: number;
  totalLimit: number;
  overallUtilization: number | null;
  /** What it would take to put EVERY card under the threshold. */
  totalToReach30: number;
  totalToReach10: number;
}

export function utilizationReport(cards: readonly CreditCard[]): UtilizationReport {
  const sorted = [...cards].sort(byAprDesc);
  const detailed: CardUtilization[] = sorted.map((c) => ({
    ...c,
    utilization: utilizationPercent(c.balance, c.creditLimit),
    paymentFor30: payDownTo(c.balance, c.creditLimit, GOOD_UTILIZATION),
    paymentFor10: payDownTo(c.balance, c.creditLimit, EXCELLENT_UTILIZATION),
    targetBalanceFor30: targetBalanceAt(c.balance, c.creditLimit, GOOD_UTILIZATION),
    targetBalanceFor10: targetBalanceAt(c.balance, c.creditLimit, EXCELLENT_UTILIZATION),
  }));
  const withLimit = detailed.filter((c) => c.creditLimit !== null && c.creditLimit > 0);
  const totalBalance = round2(withLimit.reduce((s, c) => s + c.balance, 0));
  const totalLimit = round2(withLimit.reduce((s, c) => s + (c.creditLimit as number), 0));
  return {
    cards: detailed,
    totalBalance,
    totalLimit,
    overallUtilization: totalLimit > 0 ? round2((totalBalance / totalLimit) * 100) : null,
    totalToReach30: round2(withLimit.reduce((s, c) => s + (c.paymentFor30 ?? 0), 0)),
    totalToReach10: round2(withLimit.reduce((s, c) => s + (c.paymentFor10 ?? 0), 0)),
  };
}

export interface PlanAllocation {
  name: string;
  apr: number | null;
  balance: number;
  creditLimit: number | null;
  /** Extra payment to make on top of the minimum. */
  payment: number;
  /** The balance once that payment is made. */
  balanceAfter: number;
  utilizationBefore: number | null;
  utilizationAfter: number | null;
  /** Why this card got money: under-30 rescue, avalanche overflow, or both. */
  reason: 'under-30' | 'avalanche' | 'under-30+avalanche' | null;
}

export interface CreditPlan {
  monthlyBudget: number;
  allocations: PlanAllocation[];
  allocated: number;
  unallocated: number;
  /** True when the budget could not bring every card under 30%. */
  shortfall: number;
  allCardsUnder30: boolean;
  overallUtilizationBefore: number | null;
  overallUtilizationAfter: number | null;
  /** Highest-APR card, the one the overflow attacks. */
  focusCard: string | null;
  focusMonthlyPayment: number | null;
  focusPayoff: PayoffResult | null;
}

/**
 * Deterministic allocation of one month of extra payment across cards.
 *
 * Two passes, in this order, because they are the two levers in priority order:
 *  1. bring every card under 30% utilization, highest APR first — utilization
 *     is the lever that moves a score inside one cycle;
 *  2. whatever is left goes to the highest-APR card (avalanche), because past
 *     that point the cheapest debt to kill is the dearest one.
 *
 * A budget smaller than pass 1 needs simply runs out mid-pass: the cards it
 * did reach are under 30, the rest are reported as a shortfall. Nothing is
 * ever allocated beyond a card's balance.
 */
export function creditPlan(cards: readonly CreditCard[], monthlyBudget: number): CreditPlan {
  const sorted = [...cards].sort(byAprDesc);
  const before = utilizationReport(sorted);
  const amounts = new Map<string, number>();
  const reasons = new Map<string, PlanAllocation['reason']>();
  const remainingBalance = new Map<string, number>();
  for (const c of sorted) {
    amounts.set(c.name, 0);
    reasons.set(c.name, null);
    remainingBalance.set(c.name, c.balance);
  }

  let budget = Math.max(0, round2(monthlyBudget));
  let shortfall = 0;

  // Pass 1 — every card under 30%, dearest APR first.
  for (const card of sorted) {
    const need = payDownTo(card.balance, card.creditLimit, GOOD_UTILIZATION);
    if (need === null || need <= 0) continue;
    const capped = Math.min(need, card.balance);
    const give = round2(Math.min(capped, budget));
    if (give > 0) {
      amounts.set(card.name, give);
      reasons.set(card.name, 'under-30');
      remainingBalance.set(card.name, round2(card.balance - give));
      budget = round2(budget - give);
    }
    if (give < capped) shortfall = round2(shortfall + (capped - give));
  }

  // Pass 2 — avalanche: the rest onto the dearest card that still owes.
  const focus = sorted.find((c) => (remainingBalance.get(c.name) as number) > 0) ?? null;
  if (focus && budget > 0) {
    const left = remainingBalance.get(focus.name) as number;
    const give = round2(Math.min(left, budget));
    if (give > 0) {
      const already = amounts.get(focus.name) as number;
      amounts.set(focus.name, round2(already + give));
      reasons.set(focus.name, already > 0 ? 'under-30+avalanche' : 'avalanche');
      remainingBalance.set(focus.name, round2(left - give));
      budget = round2(budget - give);
    }
  }

  const allocations: PlanAllocation[] = sorted.map((c) => {
    const payment = amounts.get(c.name) as number;
    const balanceAfter = remainingBalance.get(c.name) as number;
    return {
      name: c.name,
      apr: c.apr,
      balance: c.balance,
      creditLimit: c.creditLimit,
      payment,
      balanceAfter,
      utilizationBefore: utilizationPercent(c.balance, c.creditLimit),
      utilizationAfter: utilizationPercent(balanceAfter, c.creditLimit),
      reason: reasons.get(c.name) ?? null,
    };
  });

  const after = utilizationReport(
    sorted.map((c) => ({ ...c, balance: remainingBalance.get(c.name) as number })),
  );
  const allocated = round2(allocations.reduce((s, a) => s + a.payment, 0));

  // Months to clear the focus card paying its minimum plus this month's extra.
  const focusMonthlyPayment =
    focus === null ? null : round2(focus.minimumPayment + (amounts.get(focus.name) as number));
  const focusPayoff =
    focus === null || focus.apr === null || focusMonthlyPayment === null
      ? null
      : payoff(focus.balance, focus.apr, focusMonthlyPayment);

  return {
    monthlyBudget: round2(monthlyBudget),
    allocations,
    allocated,
    unallocated: round2(Math.max(0, budget)),
    shortfall,
    allCardsUnder30: allocations.every(
      (a) => a.utilizationAfter === null || a.utilizationAfter <= 30.0001,
    ),
    overallUtilizationBefore: before.overallUtilization,
    overallUtilizationAfter: after.overallUtilization,
    focusCard: focus?.name ?? null,
    focusMonthlyPayment,
    focusPayoff,
  };
}

function daysInMonth(year: number, monthIndex: number): number {
  return new Date(Date.UTC(year, monthIndex + 1, 0)).getUTCDate();
}

/**
 * The next occurrence of `dayOfMonth` on or after `from`, clamped to the end of
 * short months (31 → Feb 28/29). UTC throughout.
 */
export function nextDayOfMonth(from: string, dayOfMonth: number): string {
  const start = new Date(`${from}T00:00:00Z`);
  for (let i = 0; i < 3; i += 1) {
    const year = start.getUTCFullYear();
    const month = start.getUTCMonth() + i;
    const y = year + Math.floor(month / 12);
    const m = ((month % 12) + 12) % 12;
    const day = Math.min(dayOfMonth, daysInMonth(y, m));
    const candidate = new Date(Date.UTC(y, m, day)).toISOString().slice(0, 10);
    if (candidate >= from) return candidate;
  }
  return from;
}

/** `date` shifted by `days`, UTC. */
export function shiftDays(date: string, days: number): string {
  const d = new Date(`${date}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
}

export interface UpcomingStatement extends CardUtilization {
  statementDate: string;
  daysUntil: number;
  /** Pay by here for the payment to post before the statement snapshot. */
  payBefore: string;
}

/**
 * Cards whose statement closes within `days` of `from`, soonest first, each
 * with what to pay before the snapshot to land at 30% and at 10%.
 */
export function upcomingStatements(
  cards: readonly CreditCard[],
  from: string,
  days: number,
): UpcomingStatement[] {
  const horizon = shiftDays(from, days);
  const out: UpcomingStatement[] = [];
  for (const card of cards) {
    if (card.statementDay === null) continue;
    const statementDate = nextDayOfMonth(from, card.statementDay);
    if (statementDate > horizon) continue;
    const payBeforeRaw = shiftDays(statementDate, -PAY_BEFORE_DAYS);
    out.push({
      ...card,
      utilization: utilizationPercent(card.balance, card.creditLimit),
      paymentFor30: payDownTo(card.balance, card.creditLimit, GOOD_UTILIZATION),
      paymentFor10: payDownTo(card.balance, card.creditLimit, EXCELLENT_UTILIZATION),
      targetBalanceFor30: targetBalanceAt(card.balance, card.creditLimit, GOOD_UTILIZATION),
      targetBalanceFor10: targetBalanceAt(card.balance, card.creditLimit, EXCELLENT_UTILIZATION),
      statementDate,
      daysUntil: Math.round(
        (Date.parse(`${statementDate}T00:00:00Z`) - Date.parse(`${from}T00:00:00Z`)) / 86_400_000,
      ),
      payBefore: payBeforeRaw < from ? from : payBeforeRaw,
    });
  }
  return out.sort((a, b) =>
    a.statementDate === b.statementDate
      ? byAprDesc(a, b)
      : a.statementDate < b.statementDate
        ? -1
        : 1,
  );
}

/* ------------------------------------------------------------------ *
 * Credit terms: the target, the cycle, and the one sentence
 * ------------------------------------------------------------------ */

/** The utilization an installation aims at when nobody has said otherwise. */
export const DEFAULT_UTILIZATION_TARGET = 30;

/**
 * The last day a payment can be made and still change what this cycle reports.
 *
 * One day, not three: the owner is told to pay *by* this date, and a date that
 * has already passed is not advice. The three-day figure in `PAY_BEFORE_DAYS`
 * is the comfortable one used when the window is still wide; this is the edge.
 */
export const PAY_BY_DAYS_BEFORE_CLOSE = 1;

const WEEKDAYS = [
  'Sunday',
  'Monday',
  'Tuesday',
  'Wednesday',
  'Thursday',
  'Friday',
  'Saturday',
] as const;

/** 'Thursday' for a `YYYY-MM-DD`, read in UTC — the string carries no zone. */
export function weekdayName(date: string): string {
  const d = new Date(`${date}T00:00:00Z`);
  return WEEKDAYS[d.getUTCDay()] as string;
}

/** Whole days from `from` to `to`, negative when `to` is behind. */
export function daysUntil(from: string, to: string): number {
  return Math.round(
    (Date.parse(`${to}T00:00:00Z`) - Date.parse(`${from}T00:00:00Z`)) / 86_400_000,
  );
}

/** '42' for 42, '42.4' for 42.42 — a percentage nobody reads to two decimals. */
export function formatPercent(value: number): string {
  const rounded = Math.round(value * 10) / 10;
  return Number.isInteger(rounded) ? String(rounded) : rounded.toFixed(1);
}

/**
 * The amount to pay so the card reports at or under `targetPercent`.
 *
 * Rounded UP to a whole unit of currency: an owner who pays the exact cent
 * lands exactly on the line, and a cent of interest posting after them puts
 * them back over it. Null when the limit is unknown — then there is no target.
 */
export function paymentToTarget(
  reportedBalance: number,
  creditLimit: number | null,
  targetPercent: number,
): number | null {
  if (creditLimit === null || !(creditLimit > 0)) return null;
  const allowed = (creditLimit * targetPercent) / 100;
  return Math.ceil(Math.max(0, reportedBalance - allowed));
}

/** A card as the credit domain knows it: balance, limit, cycle and target. */
export interface CardTerms {
  name: string;
  balance: number;
  creditLimit: number | null;
  /** The day the statement CLOSES — the snapshot the bureaus are sent. */
  statementClosesDay: number | null;
  /** The day that snapshot reaches the bureaus. Null: assume the closing day. */
  reportsDay: number | null;
  /** This card's own target, in percent. Null falls back to the default. */
  utilizationTarget: number | null;
  /**
   * What the card is on course to report once the charges billed to it land.
   * Null falls back to the balance as it stands.
   */
  forecastBalance?: number | null;
}

export interface CreditOverviewCard {
  name: string;
  balance: number;
  creditLimit: number | null;
  /** Off the balance today. */
  utilization: number | null;
  /** The target in force for this card, per-card override or default. */
  utilizationTarget: number;
  /** True when this card carries its own target rather than the default. */
  targetIsPerCard: boolean;
  statementClosesDay: number | null;
  statementClosesOn: string | null;
  daysUntilClosing: number | null;
  reportsOn: string | null;
  /** The balance this cycle is on course to report — the forecast, or the balance. */
  reportedBalanceEstimate: number;
  /** Utilization off THAT figure. This is the number a score is scored on. */
  reportedUtilizationEstimate: number | null;
  overTarget: boolean;
  /** What to pay for the reported figure to land at the target. */
  paymentToTarget: number | null;
  /** The last day that payment still changes this cycle. */
  payBy: string | null;
  /** What the owner has never been asked for. Ask once, then set_card_terms. */
  missing: ('creditLimit' | 'statementClosesDay')[];
}

/**
 * Everything the coach needs about one card, computed — no clock, no DB.
 *
 * Utilization is given twice on purpose: `utilization` is where the card is
 * today, and `reportedUtilizationEstimate` is what the bureaus are on course to
 * see. They differ whenever a charge is still to post, and the second is the
 * one a score is scored on.
 */
export function overviewCard(
  card: CardTerms,
  opts: { today: string; defaultUtilizationTarget?: number },
): CreditOverviewCard {
  const target =
    card.utilizationTarget ?? opts.defaultUtilizationTarget ?? DEFAULT_UTILIZATION_TARGET;
  const forecast = card.forecastBalance ?? null;
  const reported = Math.max(0, forecast === null ? card.balance : forecast);
  const reportedUtilization = utilizationPercent(reported, card.creditLimit);
  const closesOn =
    card.statementClosesDay === null
      ? null
      : nextDayOfMonth(opts.today, card.statementClosesDay);
  const reportsOn =
    closesOn === null
      ? null
      : card.reportsDay === null
        ? closesOn
        : nextDayOfMonth(closesOn, card.reportsDay);
  const payByRaw = closesOn === null ? null : shiftDays(closesOn, -PAY_BY_DAYS_BEFORE_CLOSE);
  const missing: CreditOverviewCard['missing'] = [];
  if (card.creditLimit === null || !(card.creditLimit > 0)) missing.push('creditLimit');
  if (card.statementClosesDay === null) missing.push('statementClosesDay');
  const overTarget = reportedUtilization !== null && reportedUtilization > target;
  return {
    name: card.name,
    balance: round2(card.balance),
    creditLimit: card.creditLimit,
    utilization: utilizationPercent(card.balance, card.creditLimit),
    utilizationTarget: target,
    targetIsPerCard: card.utilizationTarget !== null,
    statementClosesDay: card.statementClosesDay,
    statementClosesOn: closesOn,
    daysUntilClosing: closesOn === null ? null : daysUntil(opts.today, closesOn),
    reportsOn,
    reportedBalanceEstimate: round2(reported),
    reportedUtilizationEstimate: reportedUtilization,
    overTarget,
    paymentToTarget: overTarget
      ? paymentToTarget(reported, card.creditLimit, target)
      : card.creditLimit === null
        ? null
        : 0,
    payBy: payByRaw === null ? null : payByRaw < opts.today ? opts.today : payByRaw,
    missing,
  };
}

export interface CreditOverview {
  asOf: string;
  cards: CreditOverviewCard[];
  /** Summed across cards that have a limit — balances today. */
  totalBalance: number;
  totalLimit: number;
  overallUtilization: number | null;
  /** The same sum over what the cards are on course to REPORT. */
  totalReportedEstimate: number;
  overallReportedUtilization: number | null;
  defaultUtilizationTarget: number;
  /** Cards over their target, soonest closing first. */
  overTarget: string[];
  /** Card → what has never been asked for. Ask once, record with set_card_terms. */
  missing: { card: string; fields: CreditOverviewCard['missing'] }[];
}

/** Sorted by the closing date, soonest first; cards with no closing day last. */
export function creditOverview(
  cards: readonly CardTerms[],
  opts: { today: string; defaultUtilizationTarget?: number },
): CreditOverview {
  const detailed = cards
    .map((c) => overviewCard(c, opts))
    .sort((a, b) => {
      if (a.statementClosesOn === b.statementClosesOn) return a.name.localeCompare(b.name);
      if (a.statementClosesOn === null) return 1;
      if (b.statementClosesOn === null) return -1;
      return a.statementClosesOn < b.statementClosesOn ? -1 : 1;
    });
  const withLimit = detailed.filter((c) => c.creditLimit !== null && c.creditLimit > 0);
  const totalBalance = round2(withLimit.reduce((s, c) => s + c.balance, 0));
  const totalLimit = round2(withLimit.reduce((s, c) => s + (c.creditLimit as number), 0));
  const totalReported = round2(withLimit.reduce((s, c) => s + c.reportedBalanceEstimate, 0));
  return {
    asOf: opts.today,
    cards: detailed,
    totalBalance,
    totalLimit,
    overallUtilization: totalLimit > 0 ? round2((totalBalance / totalLimit) * 100) : null,
    totalReportedEstimate: totalReported,
    overallReportedUtilization:
      totalLimit > 0 ? round2((totalReported / totalLimit) * 100) : null,
    defaultUtilizationTarget: opts.defaultUtilizationTarget ?? DEFAULT_UTILIZATION_TARGET,
    overTarget: detailed.filter((c) => c.overTarget).map((c) => c.name),
    missing: detailed
      .filter((c) => c.missing.length > 0)
      .map((c) => ({ card: c.name, fields: c.missing })),
  };
}

/**
 * The finding's whole sentence, built from the numbers:
 *
 *   "Amex closes Thursday at 42%; paying 400 by Wednesday brings it under 30%"
 *
 * Nothing in it is a judgement — the weekday comes from the closing date, the
 * percentage from the balance the card is on course to report, and the amount
 * from the limit and the target. A model reading it has nothing left to compute
 * and nothing left to get wrong.
 */
export function closingSentence(card: CreditOverviewCard): string | null {
  if (card.statementClosesOn === null) return null;
  if (card.reportedUtilizationEstimate === null) return null;
  if (card.paymentToTarget === null || card.paymentToTarget <= 0) return null;
  const closes = weekdayName(card.statementClosesOn);
  const payBy = weekdayName(card.payBy ?? card.statementClosesOn);
  return (
    `${card.name} closes ${closes} at ${formatPercent(card.reportedUtilizationEstimate)}%; ` +
    `paying ${card.paymentToTarget} by ${payBy} brings it under ` +
    `${formatPercent(card.utilizationTarget)}%`
  );
}

/* --------------------------------------------------------------- the score */

export interface ScorePoint {
  /** Experian, Equifax, TransUnion — what the score is ABOUT. */
  bureau: string;
  score: number;
  observedOn: string;
  /** Where the owner read it. Not what it is about. */
  source?: string | null;
  model?: string | null;
}

export interface BureauTrend {
  bureau: string;
  latest: ScorePoint;
  previous: ScorePoint | null;
  change: number | null;
  direction: 'up' | 'down' | 'flat' | null;
  spanDays: number | null;
}

export interface ScoreTrend {
  latest: ScorePoint | null;
  perBureau: BureauTrend[];
  /** Across every bureau's latest reading. Null with nothing recorded. */
  averageLatest: number | null;
  count: number;
}

/**
 * The trend, compared WITHIN a bureau and never across one.
 *
 * Two bureaus do not hold the same file and two models do not score the same
 * file the same way, so "up 12 points" only means something when the two
 * readings came from the same place. A single reading has no trend and says so
 * with nulls rather than a zero, which would read as "flat" — a different claim.
 */
export function scoreTrend(points: readonly ScorePoint[]): ScoreTrend {
  const sorted = [...points].sort((a, b) =>
    a.observedOn === b.observedOn
      ? a.bureau.localeCompare(b.bureau)
      : a.observedOn < b.observedOn
        ? -1
        : 1,
  );
  const byBureau = new Map<string, ScorePoint[]>();
  for (const p of sorted) {
    const key = p.bureau.trim().toLowerCase();
    byBureau.set(key, [...(byBureau.get(key) ?? []), p]);
  }
  const perBureau: BureauTrend[] = [];
  for (const series of byBureau.values()) {
    const latest = series[series.length - 1] as ScorePoint;
    const previous = series.length > 1 ? (series[series.length - 2] as ScorePoint) : null;
    const change = previous === null ? null : latest.score - previous.score;
    perBureau.push({
      bureau: latest.bureau,
      latest,
      previous,
      change,
      direction: change === null ? null : change > 0 ? 'up' : change < 0 ? 'down' : 'flat',
      spanDays: previous === null ? null : daysUntil(previous.observedOn, latest.observedOn),
    });
  }
  perBureau.sort((a, b) => a.bureau.localeCompare(b.bureau));
  const latestOverall = sorted[sorted.length - 1] ?? null;
  return {
    latest: latestOverall,
    perBureau,
    averageLatest:
      perBureau.length === 0
        ? null
        : Math.round(perBureau.reduce((s, b) => s + b.latest.score, 0) / perBureau.length),
    count: points.length,
  };
}
