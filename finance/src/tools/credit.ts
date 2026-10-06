/**
 * Credit tools: the score over time, what the cards report at statement close,
 * and whether the minimums landed. Reads and pure computation only — tier auto.
 */
import type { DbArea, ToolDefinition } from '@buddi/core/plugin';
import { z } from 'zod';
import {
  closingSentence,
  creditOverview,
  creditPlan,
  overviewCard,
  round2,
  scoreTrend,
  upcomingStatements,
  utilizationReport,
  type CardTerms,
  type CreditCard,
  type ScorePoint,
} from '../credit.js';
import type { StatementForecast } from '../cards.js';
import { loadStatementForecast } from './cards.js';
import { findLiability, loadPreferences, num, today, toDateString } from './shared.js';

const DATE = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'expected a YYYY-MM-DD date');

/** Active credit cards, shaped for the pure helpers. */
async function loadCards(db: DbArea): Promise<(CreditCard & { id: string })[]> {
  const { rows } = await db.query(
    `select id, name, balance, credit_limit, apr, minimum_payment, statement_day,
            reported_balance, reported_on, due_day
       from finance.liabilities
      where active and kind = 'credit_card'`,
  );
  return rows.map((r) => ({
    id: r.id as string,
    name: r.name as string,
    balance: num(r.balance),
    creditLimit: r.credit_limit === null || r.credit_limit === undefined ? null : num(r.credit_limit),
    apr: r.apr === null || r.apr === undefined ? null : num(r.apr),
    minimumPayment: num(r.minimum_payment),
    statementDay: (r.statement_day as number | null) ?? null,
  }));
}

/**
 * The expected statement balance per card, by card name.
 *
 * A card's balance today is not what it will report: the recurring charges
 * billed to it between now and the closing day still have to land, and a
 * scheduled payment may still land first. Where that forecast exists it is
 * offered alongside the current figure — never instead of it, so the answer can
 * say both ("you are at 62% today; it closes at 48% if nothing changes").
 */
async function loadForecasts(
  db: DbArea,
  cards: readonly (CreditCard & { id: string })[],
  asOf: string,
): Promise<Map<string, StatementForecast>> {
  const out = new Map<string, StatementForecast>();
  for (const card of cards) {
    if (card.statementDay === null) continue;
    out.set(card.name, await loadStatementForecast(db, { ...card }, asOf));
  }
  return out;
}

/* ------------------------------------------------------------------ scores */

const recordScoreInput = z.object({
  bureau: z
    .string()
    .min(1)
    .describe(
      "Which bureau the score is ABOUT — 'Experian', 'Equifax', 'TransUnion'. If the owner only said a number, ask which bureau it is for; scores from different bureaus are not comparable and a trend across them is meaningless.",
    ),
  score: z.number().int().min(250).max(900).describe('The score itself.'),
  observedOn: DATE.optional().describe('Date the score was seen. Defaults to today.'),
  source: z
    .string()
    .min(1)
    .optional()
    .describe(
      "Where the owner READ it — 'Credit Karma', 'the Amex app', 'the bureau directly'. Not the same thing as the bureau.",
    ),
  model: z
    .string()
    .min(1)
    .optional()
    .describe("Scoring model, when known: 'FICO 8', 'VantageScore 3'. Scores from different models are not comparable."),
  note: z.string().min(1).optional().describe('Anything that explains a move.'),
});

export const recordCreditScore: ToolDefinition<z.infer<typeof recordScoreInput>, unknown> = {
  name: 'finance.record_credit_score',
  description:
    'Store a credit score the owner reports: the bureau it is about, the score, the date it was observed, and optionally where they read it and which scoring model. Scores are kept as a history and never overwritten, so the trend stays readable. Record the score the moment the owner says it — a number mentioned in passing and not written down is gone with the conversation. If the bureau was not named, ask once and record it with the answer.',
  tier: 'auto',
  input: recordScoreInput,
  async execute(input, ctx) {
    const observedOn = input.observedOn ?? today(ctx);
    const { rows } = await ctx.buddi!.db.query(
      `insert into finance.credit_scores
         (bureau, source, bureau_or_source, score, model, observed_on, note)
       values ($1, $2, $1, $3, $4, $5, $6)
       returning id, bureau, source, score, model, observed_on, note`,
      [input.bureau, input.source ?? null, input.score, input.model ?? null, observedOn, input.note ?? null],
    );
    const row = rows[0];
    // The previous reading from the SAME bureau — the only comparison that means
    // anything. A first reading returns nulls, not a zero delta.
    const { rows: prev } = await ctx.buddi!.db.query(
      `select score, observed_on from finance.credit_scores
        where lower(coalesce(bureau, bureau_or_source)) = lower($1) and id <> $2
        order by observed_on desc, created_at desc limit 1`,
      [input.bureau, row.id],
    );
    const previous = prev[0];
    return {
      id: row.id,
      bureau: row.bureau,
      source: row.source,
      score: row.score,
      model: row.model,
      observedOn: toDateString(row.observed_on),
      note: row.note,
      previousScore: previous ? previous.score : null,
      previousObservedOn: previous ? toDateString(previous.observed_on) : null,
      delta: previous ? (row.score as number) - (previous.score as number) : null,
    };
  },
};

const historyInput = z.object({
  limit: z.number().int().min(1).max(100).optional().describe('How many entries. Default 12.'),
});

export const creditScoreHistory: ToolDefinition<z.infer<typeof historyInput>, unknown> = {
  name: 'finance.credit_score_history',
  description:
    'The recorded credit scores, newest first, each with the change against the previous score from the same bureau. Says plainly when nothing has been recorded yet. This is the only source of truth for the score trend — never estimate a score.',
  tier: 'auto',
  input: historyInput,
  async execute(input, ctx) {
    const limit = input.limit ?? 12;
    const { rows } = await ctx.buddi!.db.query(
      `select id, coalesce(bureau, bureau_or_source) as bureau, source, score,
              model, observed_on, note
         from finance.credit_scores
        order by observed_on desc, created_at desc
        limit $1`,
      [limit],
    );
    // Delta against the previous entry from the same source, in date order.
    const bySource = new Map<string, { score: number; observedOn: string }[]>();
    const ordered = [...rows].reverse();
    const deltas = new Map<string, number | null>();
    for (const r of ordered) {
      const key = String(r.bureau).toLowerCase();
      const seen = bySource.get(key) ?? [];
      const last = seen[seen.length - 1];
      deltas.set(String(r.id), last ? (r.score as number) - last.score : null);
      seen.push({ score: r.score as number, observedOn: toDateString(r.observed_on) });
      bySource.set(key, seen);
    }
    const scores = rows.map((r) => ({
      id: r.id,
      bureau: r.bureau,
      source: r.source,
      score: r.score,
      model: r.model,
      observedOn: toDateString(r.observed_on),
      note: r.note,
      delta: deltas.get(String(r.id)) ?? null,
    }));
    return {
      scores,
      count: scores.length,
      latest: scores[0] ?? null,
      message:
        scores.length === 0
          ? 'no credit score has been recorded yet; ask the owner once for their latest score and which bureau it is for, then record it with finance.record_credit_score'
          : null,
    };
  },
};

/* ---------------------------------------------------------------- payments */

const recordPaymentInput = z.object({
  liability: z.string().min(1).describe('Name of the debt, from finance.list_liabilities.'),
  dueOn: DATE.describe('Date the payment was due.'),
  paidOn: DATE.optional().describe('Date it was actually paid, when it was.'),
  amount: z.number().min(0).optional().describe('Amount paid.'),
  status: z
    .enum(['scheduled', 'paid_on_time', 'paid_late', 'missed'])
    .describe("'scheduled' for one still ahead; otherwise how it went."),
});

export const recordPayment: ToolDefinition<z.infer<typeof recordPaymentInput>, unknown> = {
  name: 'finance.record_payment',
  description:
    'Record one payment against a debt — due date, when it was paid, how much, and whether it was on time, late or missed. Payment history is the single heaviest factor in a credit score, so every minimum matters; a duplicate (same debt, same due date) is updated rather than added twice.',
  tier: 'auto',
  input: recordPaymentInput,
  async execute(input, ctx) {
    const { rows: liab } = await ctx.buddi!.db.query(
      `select id, name from finance.liabilities where lower(name) = lower($1)`,
      [input.liability],
    );
    const target = liab[0];
    if (!target) {
      return {
        status: 'unknown-liability',
        message: `no liability named '${input.liability}'; list them with finance.list_liabilities`,
      };
    }
    const { rows: existing } = await ctx.buddi!.db.query(
      `select id from finance.payment_events where liability_id = $1 and due_on = $2`,
      [target.id, input.dueOn],
    );
    const current = existing[0];
    // One row per (debt, due date): a correction updates it rather than adding
    // a second event, so the on-time rate is never double-counted.
    const { rows } = current
      ? await ctx.buddi!.db.query(
          `update finance.payment_events
              set paid_on = $2, amount = $3, status = $4
            where id = $1
            returning id, due_on, paid_on, amount, status`,
          [current.id, input.paidOn ?? null, input.amount ?? null, input.status],
        )
      : await ctx.buddi!.db.query(
          `insert into finance.payment_events (liability_id, due_on, paid_on, amount, status)
           values ($1, $2, $3, $4, $5)
           returning id, due_on, paid_on, amount, status`,
          [target.id, input.dueOn, input.paidOn ?? null, input.amount ?? null, input.status],
        );
    const row = rows[0];
    return {
      status: 'ok',
      updated: Boolean(current),
      id: row.id,
      liability: target.name,
      dueOn: toDateString(row.due_on),
      paidOn: row.paid_on === null ? null : toDateString(row.paid_on),
      amount: row.amount === null ? null : num(row.amount),
      paymentStatus: row.status,
    };
  },
};

const paymentHistoryInput = z.object({
  liability: z.string().min(1).optional().describe('Limit to one debt. Default: all of them.'),
  months: z.number().int().min(1).max(120).optional().describe('How far back to look. Default 12.'),
});

export const paymentHistory: ToolDefinition<z.infer<typeof paymentHistoryInput>, unknown> = {
  name: 'finance.payment_history',
  description:
    'The recorded payments over the last months, with the on-time rate, the count of late and missed payments, and anything still scheduled. This is the only source of truth for the on-time rate — never compute it yourself.',
  tier: 'auto',
  input: paymentHistoryInput,
  async execute(input, ctx) {
    const months = input.months ?? 12;
    const prefs = await loadPreferences(ctx.buddi!.db, ctx.buddi!.owner);
    const { rows } = await ctx.buddi!.db.query(
      `select p.id, p.due_on, p.paid_on, p.amount, p.status, l.name as liability
         from finance.payment_events p
         join finance.liabilities l on l.id = p.liability_id
        where p.due_on >= ($1::date - make_interval(months => $2::int))
          and ($3::text is null or lower(l.name) = lower($3))
        order by p.due_on desc`,
      [today(ctx), months, input.liability ?? null],
    );
    const payments = rows.map((r) => ({
      id: r.id,
      liability: r.liability,
      dueOn: toDateString(r.due_on),
      paidOn: r.paid_on === null ? null : toDateString(r.paid_on),
      amount: r.amount === null ? null : num(r.amount),
      status: r.status,
    }));
    const settled = payments.filter((p) => p.status !== 'scheduled');
    const onTime = settled.filter((p) => p.status === 'paid_on_time').length;
    const late = settled.filter((p) => p.status === 'paid_late').length;
    const missed = settled.filter((p) => p.status === 'missed').length;
    return {
      payments,
      count: payments.length,
      months,
      settled: settled.length,
      onTime,
      late,
      missed,
      scheduled: payments.length - settled.length,
      onTimeRate: settled.length === 0 ? null : round2((onTime / settled.length) * 100),
      currency: prefs.currency,
      message:
        payments.length === 0
          ? 'no payments have been recorded yet; record each minimum as it is paid to build the history'
          : null,
    };
  },
};

/* ------------------------------------------------------------- utilization */

export const creditUtilization: ToolDefinition<Record<string, never>, unknown> = {
  name: 'finance.credit_utilization',
  description:
    'Per credit card: the balance, the limit, the utilization percentage, the statement closing day, and exactly what to pay to land at 30% and at 10% of the limit — plus the overall utilization across all cards. paymentFor30 = the amount to PAY now; targetBalanceFor30 = the balance that remains AFTER that payment (same for paymentFor10 / targetBalanceFor10). Quote both: pay paymentFor30 so the balance becomes targetBalanceFor30 — never quote a payment as if it were the resulting balance. totalToReach30 / totalToReach10 are the summed payments across cards. Sorted by APR, dearest first. This is the only source of truth for utilization arithmetic.',
  tier: 'auto',
  input: z.object({}),
  async execute(_input, ctx) {
    const prefs = await loadPreferences(ctx.buddi!.db, ctx.buddi!.owner);
    const cards = await loadCards(ctx.buddi!.db);
    const report = utilizationReport(cards);
    return {
      cards: report.cards.map((c) => ({
        name: c.name,
        balance: c.balance,
        creditLimit: c.creditLimit,
        utilization: c.utilization,
        apr: c.apr,
        minimumPayment: c.minimumPayment,
        statementDay: c.statementDay,
        paymentFor30: c.paymentFor30,
        targetBalanceFor30: c.targetBalanceFor30,
        paymentFor10: c.paymentFor10,
        targetBalanceFor10: c.targetBalanceFor10,
      })),
      count: report.cards.length,
      totalBalance: report.totalBalance,
      totalLimit: report.totalLimit,
      overallUtilization: report.overallUtilization,
      totalToReach30: report.totalToReach30,
      totalToReach10: report.totalToReach10,
      currency: prefs.currency,
      message:
        report.cards.length === 0
          ? 'no active credit cards are recorded; add them with their limits to track utilization'
          : report.totalLimit === 0
            ? 'no credit limits are recorded, so utilization cannot be computed; ask the owner for each card limit'
            : null,
    };
  },
};

const planInput = z.object({
  monthlyBudget: z
    .number()
    .min(0)
    .describe(
      'Money available this month for extra payments, on top of the minimums. Check it against a cash-flow projection before proposing it.',
    ),
});

export const creditPlanTool: ToolDefinition<z.infer<typeof planInput>, unknown> = {
  name: 'finance.credit_plan',
  description:
    'Allocate a monthly extra-payment budget across the cards: first bring every card under 30% utilization, dearest APR first, then put whatever is left on the highest-APR card. Returns, per card, payment (the amount to PAY on top of the minimum) and balanceAfter (the balance that remains AFTER that payment) — quote both: pay `payment` so the balance becomes `balanceAfter` — plus the utilization each card and the portfolio would land at, and how many months the highest-APR card takes to clear at that pace. Each allocation also carries `forecastBalance`: what that card is on course to report at its next close once the charges billed to it have landed — if it is above the balance the plan worked from, say so, because paying to `balanceAfter` will not hold if more is still to post. Deterministic — this is the only source of truth for the allocation.',
  tier: 'auto',
  input: planInput,
  async execute(input, ctx) {
    const prefs = await loadPreferences(ctx.buddi!.db, ctx.buddi!.owner);
    const cards = await loadCards(ctx.buddi!.db);
    const forecasts = await loadForecasts(ctx.buddi!.db, cards, today(ctx));
    const plan = creditPlan(cards, input.monthlyBudget);
    return {
      ...plan,
      /**
       * The allocation is computed off the balance as it stands. Where a card
       * has a statement day, `forecastBalance` says what it is on course to
       * REPORT — mention it when it is higher than the balance the plan works
       * from, because that is the figure utilization is scored on.
       */
      allocations: plan.allocations.map((a) => {
        const forecast = forecasts.get(a.name);
        return {
          ...a,
          forecastBalance: forecast?.forecastBalance ?? null,
          forecastUtilization: forecast?.forecastUtilization ?? null,
          statementCloseDate: forecast?.closeDate ?? null,
        };
      }),
      currency: prefs.currency,
      message:
        cards.length === 0
          ? 'no active credit cards are recorded, so there is nothing to allocate'
          : plan.shortfall > 0
            ? `this budget is ${plan.shortfall.toFixed(2)} short of putting every card under 30%`
            : null,
    };
  },
};

const upcomingInput = z.object({
  days: z
    .number()
    .int()
    .min(1)
    .max(120)
    .optional()
    .describe('Window ahead, in days. Default 30.'),
});

export const upcomingStatementsTool: ToolDefinition<z.infer<typeof upcomingInput>, unknown> = {
  name: 'finance.upcoming_statements',
  description:
    'Cards whose statement closes within the window, soonest first — the closing date, the date to pay by for the payment to post first, and what to pay for the card to report at 30% and at 10%. paymentFor30 = the amount to PAY before the statement closes; targetBalanceFor30 = the balance that would then be reported (same for paymentFor10 / targetBalanceFor10). Quote both: pay paymentFor30 so the reported balance becomes targetBalanceFor30. Utilization is scored off the balance reported at statement close, not off the due date, so this is the calendar that matters. When recurring charges are billed to the card or a payment is already scheduled, `forecastBalance` is what the card is on course to REPORT on the closing day (with `forecastEvents` naming each movement and its date) — quote it alongside the balance today whenever the two differ, because the forecast is the figure the bureaus will see.',
  tier: 'auto',
  input: upcomingInput,
  async execute(input, ctx) {
    const days = input.days ?? 30;
    const prefs = await loadPreferences(ctx.buddi!.db, ctx.buddi!.owner);
    const cards = await loadCards(ctx.buddi!.db);
    const from = today(ctx);
    const statements = upcomingStatements(cards, from, days);
    const forecasts = await loadForecasts(ctx.buddi!.db, cards, from);
    const noStatementDay = cards.filter((c) => c.statementDay === null).map((c) => c.name);
    return {
      from,
      days,
      statements: statements.map((s) => {
        const forecast = forecasts.get(s.name);
        return {
        name: s.name,
        statementDate: s.statementDate,
        daysUntil: s.daysUntil,
        payBefore: s.payBefore,
        balance: s.balance,
        creditLimit: s.creditLimit,
        utilization: s.utilization,
        apr: s.apr,
        /**
         * What the card is on course to report on the closing day: the balance
         * today plus the recurring charges billed to it before the close, less
         * the payments already scheduled. Null when nothing is scheduled either
         * way — then the balance IS the forecast. Quote it when it differs.
         */
        forecastBalance: forecast?.forecastBalance ?? null,
        forecastUtilization: forecast?.forecastUtilization ?? null,
        chargesBeforeClose: forecast?.chargesBeforeClose ?? 0,
        paymentsBeforeClose: forecast?.paymentsBeforeClose ?? 0,
        forecastEvents: forecast?.events ?? [],
        paymentFor30: s.paymentFor30,
        targetBalanceFor30: s.targetBalanceFor30,
        paymentFor10: s.paymentFor10,
        targetBalanceFor10: s.targetBalanceFor10,
        };
      }),
      count: statements.length,
      cardsWithoutStatementDay: noStatementDay,
      currency: prefs.currency,
      message:
        noStatementDay.length > 0
          ? `no statement closing day is recorded for: ${noStatementDay.join(', ')} — ask the owner and store it`
          : null,
    };
  },
};


/* ---------------------------------------------------------- credit terms */

/** Active cards with everything the credit domain needs to know about them. */
async function loadCardTerms(db: DbArea): Promise<(CardTerms & { id: string })[]> {
  const { rows } = await db.query(
    `select id, name, balance, credit_limit, statement_day, reports_day, utilization_target
       from finance.liabilities
      where active and kind = 'credit_card'
      order by name`,
  );
  return rows.map((r) => ({
    id: r.id as string,
    name: r.name as string,
    balance: num(r.balance),
    creditLimit:
      r.credit_limit === null || r.credit_limit === undefined ? null : num(r.credit_limit),
    statementClosesDay: r.statement_day === null ? null : Number(r.statement_day),
    reportsDay: r.reports_day === null ? null : Number(r.reports_day),
    utilizationTarget:
      r.utilization_target === null || r.utilization_target === undefined
        ? null
        : num(r.utilization_target),
  }));
}

export const creditOverviewTool: ToolDefinition<Record<string, never>, unknown> = {
  name: 'finance.credit_overview',
  description:
    "Everything the credit score rests on, in one read. Per card: the balance, the credit limit, utilization today, the utilization target in force for that card, the date the statement closes NEXT and how many days away it is, the date it reaches the bureaus, and reportedUtilizationEstimate — what the card is on course to REPORT once the charges billed to it land, which is the figure a score is actually scored on. Then the overall utilization across every card, and the score history with its trend, compared within each bureau and never across bureaus. `sentence` on a card over its target is the whole recommendation, already computed: say it as it is written. `missing` names what has never been recorded for a card (its limit, its closing day) — ask the owner ONCE for everything missing, in one message, then record it with finance.set_card_terms; never ask twice and never guess. This is the only source of truth for utilization and the score trend.",
  tier: 'auto',
  input: z.object({}),
  async execute(_input, ctx) {
    const prefs = await loadPreferences(ctx.buddi!.db, ctx.buddi!.owner);
    const asOf = today(ctx);
    const cards = await loadCardTerms(ctx.buddi!.db);
    // The balance a card will REPORT includes the charges billed to it that are
    // still to post, so the overview is scored off the forecast where there is
    // one. A card that looks fine today and closes over target once the
    // premiums land is exactly the case the balance alone would miss.
    const withForecast: CardTerms[] = [];
    for (const card of cards) {
      const forecast =
        card.statementClosesDay === null
          ? null
          : await loadStatementForecast(
              ctx.buddi!.db,
              {
                id: card.id,
                name: card.name,
                balance: card.balance,
                creditLimit: card.creditLimit,
                statementDay: card.statementClosesDay,
              },
              asOf,
            );
      withForecast.push({
        ...card,
        forecastBalance: forecast && forecast.hasForecast ? forecast.forecastBalance : null,
      });
    }
    const overview = creditOverview(withForecast, {
      today: asOf,
      defaultUtilizationTarget: prefs.utilizationTarget,
    });

    const { rows: scoreRows } = await ctx.buddi!.db.query(
      `select coalesce(bureau, bureau_or_source) as bureau, source, score, model, observed_on
         from finance.credit_scores
        order by observed_on desc, created_at desc
        limit 24`,
    );
    const points: ScorePoint[] = scoreRows.map((r) => ({
      bureau: r.bureau as string,
      score: Number(r.score),
      observedOn: toDateString(r.observed_on),
      source: (r.source as string | null) ?? null,
      model: (r.model as string | null) ?? null,
    }));
    const trend = scoreTrend(points);

    const asked: string[] = [];
    if (overview.missing.length > 0) {
      asked.push(
        ...overview.missing.map(
          (m) =>
            `${m.card}: ${m.fields
              .map((f) => (f === 'creditLimit' ? 'credit limit' : 'statement closing day'))
              .join(' and ')}`,
        ),
      );
    }
    if (points.length === 0) asked.push('the latest credit score, and which bureau it is from');

    return {
      ...overview,
      cards: overview.cards.map((c) => ({
        ...c,
        /** The whole recommendation, computed. Null when nothing needs saying. */
        sentence: closingSentence(c),
      })),
      currency: prefs.currency,
      score: {
        latest: trend.latest,
        perBureau: trend.perBureau,
        averageLatest: trend.averageLatest,
        history: points,
        count: trend.count,
      },
      /** Ask for all of this in ONE message, then record it. Never ask twice. */
      askOnce: asked,
      message:
        cards.length === 0
          ? 'no active credit cards are recorded; add them with finance.set_liability, then their terms with finance.set_card_terms'
          : asked.length > 0
            ? `ask the owner once for: ${asked.join('; ')} — then record it with finance.set_card_terms`
            : null,
    };
  },
};

const setTermsInput = z
  .object({
    card: z
      .string()
      .min(1)
      .describe("The card, by name, as finance.list_liabilities shows it. It must already exist."),
    statementClosesDay: z
      .number()
      .int()
      .min(1)
      .max(31)
      .optional()
      .describe(
        'Day of the month the statement CLOSES — the day the issuer snapshots the balance it sends to the bureaus. Not the payment due day; the two are usually three weeks apart and confusing them makes every piece of utilization advice a cycle late.',
      ),
    reportsDay: z
      .number()
      .int()
      .min(1)
      .max(31)
      .optional()
      .describe(
        'Day of the month that snapshot reaches the bureaus, when the owner knows it. Leave it out when they do not: the closing day is then assumed, which is the conservative reading.',
      ),
    creditLimit: z
      .number()
      .positive()
      .optional()
      .describe('The credit limit. Without it no utilization figure exists for this card.'),
    utilizationTarget: z
      .number()
      .positive()
      .max(100)
      .optional()
      .describe(
        'The percentage THIS card should report, overriding the installation default (30, or whatever finance.set_preferences holds). Set it per card only when the owner wants this card treated differently.',
      ),
  })
  .refine(
    (v) =>
      v.statementClosesDay !== undefined ||
      v.reportsDay !== undefined ||
      v.creditLimit !== undefined ||
      v.utilizationTarget !== undefined,
    { message: 'provide at least one term to set' },
  );

export const setCardTerms: ToolDefinition<z.infer<typeof setTermsInput>, unknown> = {
  name: 'finance.set_card_terms',
  description:
    "Record a card's credit terms: the day its statement closes, the day that reaches the bureaus, its credit limit, and its own utilization target. These are facts only the owner has, and they change almost never — so ask once for everything finance.credit_overview lists as missing, in a single message, record it here, and never ask again. Only the terms passed are changed; anything left out keeps its current value. Use finance.set_liability for the balance, the minimum and the due day.",
  tier: 'auto',
  input: setTermsInput,
  async execute(input, ctx) {
    const liability = await findLiability(ctx.buddi!.db, input.card);
    if (!liability) {
      return {
        status: 'unknown-card',
        message: `no card named '${input.card}'; list them with finance.list_liabilities, or record it first with finance.set_liability`,
      };
    }
    // coalesce, not overwrite: a call that sets the limit must not quietly
    // erase a closing day recorded weeks ago.
    const { rows } = await ctx.buddi!.db.query(
      `update finance.liabilities set
         statement_day = coalesce($2, statement_day),
         reports_day = coalesce($3, reports_day),
         credit_limit = coalesce($4, credit_limit),
         utilization_target = coalesce($5, utilization_target)
       where id = $1
       returning name, kind, balance, credit_limit, statement_day, reports_day, utilization_target`,
      [
        liability.id,
        input.statementClosesDay ?? null,
        input.reportsDay ?? null,
        input.creditLimit ?? null,
        input.utilizationTarget ?? null,
      ],
    );
    const row = rows[0];
    const prefs = await loadPreferences(ctx.buddi!.db, ctx.buddi!.owner);
    const card = overviewCard(
      {
        name: row.name as string,
        balance: num(row.balance),
        creditLimit: row.credit_limit === null ? null : num(row.credit_limit),
        statementClosesDay: row.statement_day === null ? null : Number(row.statement_day),
        reportsDay: row.reports_day === null ? null : Number(row.reports_day),
        utilizationTarget:
          row.utilization_target === null ? null : num(row.utilization_target),
      },
      { today: today(ctx), defaultUtilizationTarget: prefs.utilizationTarget },
    );
    return {
      status: 'ok',
      card: row.name,
      kind: row.kind,
      statementClosesDay: card.statementClosesDay,
      reportsDay: row.reports_day === null ? null : Number(row.reports_day),
      creditLimit: card.creditLimit,
      utilizationTarget: card.utilizationTarget,
      targetIsPerCard: card.targetIsPerCard,
      statementClosesOn: card.statementClosesOn,
      reportsOn: card.reportsOn,
      utilization: card.utilization,
      reportedUtilizationEstimate: card.reportedUtilizationEstimate,
      currency: prefs.currency,
      /** What is still unknown about this card. Ask for all of it at once. */
      missing: card.missing,
      message:
        card.missing.length > 0
          ? `still missing for ${row.name}: ${card.missing.join(', ')} — ask the owner once and record it here`
          : null,
    };
  },
};
