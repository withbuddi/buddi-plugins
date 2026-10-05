/**
 * The scheduled missions this plugin suggests.
 *
 * A default mission is domain knowledge: "every Friday, recap the week" only
 * means something because the finance tools exist, so it ships with them rather
 * than with the gateway. Nothing here is installed by importing the plugin —
 * `buddi missions add-defaults` is the owner accepting the suggestion.
 *
 * The agent is named by role, never by id: this installation gives
 * `finance-advisor` the `overview`, `recap` and `credit` roles, and another
 * installation can hand them to a different agent without touching this file.
 * `credit` is deliberately not a new agent — coaching a score is the finance
 * advisor's job, with a skill, not a second principal with its own grant.
 */
import type { SuggestedMission } from '@buddi/core/plugin';

export const FRIDAY_RECAP_ID = 'friday-recap';
export const FRIDAY_RECAP_CRON = '0 8 * * FRI';
export const FRIDAY_RECAP_PROMPT = `Produce the weekly recap. Use the finance tools for every number; never do the arithmetic yourself.

1. Cash: total across accounts, per account if there are several. If any liability is recorded, add total debt and net worth (cash minus debt).
2. Due in the next 14 days: each charge and income with its date and amount.
3. 60-day projection: the minimum projected balance and the exact date it happens, the first floor breach if there is one, and whether the safety floor holds. If no safety floor is set, say so in one line.
4. What changed since last week, if the tools can tell: this month's spending summary against the previous month's.
5. One concrete recommendation, in a single line.
6. End with one line naming the Money page, where all of it is: "Everything is on your Money page: #/p/finance/money".

Keep the whole message under 1500 characters, plain text, no markdown.`;

export const DAILY_CHECK_ID = 'daily-check';
export const DAILY_CHECK_CRON = '0 8 * * *';
export const DAILY_CHECK_PROMPT = `Run the daily check. Use the finance tools for every number; never do the arithmetic yourself.

1. Project the cashflow over the next 30 days and note the minimum balance and its date.
2. List everything due in the next 3 days — charges and income, with dates and amounts.
3. List receipts or imported transactions that are still unmatched, if the tools can tell you.

Then decide, and stay silent unless something is genuinely urgent. Urgent means one of:
- the projection breaches the safety floor within 7 days;
- a minimum payment or a charge falls due within 3 days with no payment recorded;
- an account balance is already below the floor.

If none of that is true, call mission.silent with the one-line reason. If something is urgent, call mission.report with urgency 'urgent', at most 600 characters, plain text, and exactly one recommended action, ending with "See your Money page: #/p/finance/money".`;

export const WEEKLY_CONSOLIDATION_ID = 'weekly-consolidation';
export const WEEKLY_CONSOLIDATION_CRON = '0 20 * * SUN';
export const WEEKLY_CONSOLIDATION_PROMPT = `Placeholder. Consolidate the week's derived memories and finance observations into durable notes, then stay silent (mission.silent) unless the consolidation itself found something the owner must act on.

This mission is registered disabled on purpose: enable it once the consolidation tools exist.`;

export const MONTHLY_SCORE_ID = 'monthly-score';
export const MONTHLY_SCORE_CRON = '0 9 1 * *';
export const MONTHLY_SCORE_PROMPT = `It is the 1st. Collect this month's credit score(s) from the owner and record them.

1. Call finance.credit_overview. It returns the score history and, per bureau, when each score was last recorded.
2. Ask the owner for their latest score. Name the bureau you already have readings for, and ask which bureau this one is for if they answer with a bare number. Ask for every bureau in ONE message; never send a second message per bureau.
3. Record each answer with finance.record_credit_score — the bureau, the score, the date they saw it, and where they read it. Record it before you reply; a number said in passing and not written down is gone with this conversation.
4. Reply in one sentence with a number: the score, the change against the last reading from the SAME bureau, and the one lever that moves it next month (from finance.credit_overview, never invented). Say nothing about closing a card.

If the owner does not answer, that is not a failure: call mission.silent with the one-line reason. Otherwise this message is the ask itself, so it always goes out.`;

export const PRE_STATEMENT_REVIEW_ID = 'pre-statement-review';
export const PRE_STATEMENT_REVIEW_CRON = '0 9 * * MON';
export const PRE_STATEMENT_REVIEW_PROMPT = `Review the cards that report before next Monday. Use the finance tools for every number; never do the arithmetic yourself.

1. Call finance.credit_overview. Look at every card whose statement closes within the next 7 days.
2. A card at or under its utilization target needs nothing said about it.
3. For a card over its target, the overview already carries the whole recommendation on that card as \`sentence\` — say it exactly as written, one line per card, at most three lines.
4. Before recommending a payment, check it against finance.project_cashflow: money that is not there is not advice. If the payment would breach the safety floor, say what can be paid instead and what that lands at.

If no card closes inside the window over its target, call mission.silent with the one-line reason. Otherwise call mission.report, urgency 'normal', under 600 characters, plain text.`;

/**
 * What each one is allowed to do to the owner's evening:
 *
 *  - `friday-recap`          always delivers (the owner asked for it weekly).
 *  - `daily-check`           delivers only if it calls mission.report.
 *  - `monthly-score`         always delivers: the message IS the ask.
 *  - `pre-statement-review`  delivers only if a card is closing over target.
 *  - `weekly-consolidation`  registered disabled — a placeholder for later.
 */
export const financeMissions: SuggestedMission[] = [
  {
    id: FRIDAY_RECAP_ID,
    name: 'Friday recap',
    agentRole: 'recap',
    cron: FRIDAY_RECAP_CRON,
    misfirePolicy: 'coalesce',
    prompt: FRIDAY_RECAP_PROMPT,
    // The one mission that speaks whether or not it decided to: the owner asked
    // for a recap every Friday, not for a recap when something is wrong.
    alwaysDeliver: true,
  },
  {
    id: DAILY_CHECK_ID,
    name: 'Daily check',
    agentRole: 'overview',
    cron: DAILY_CHECK_CRON,
    misfirePolicy: 'coalesce',
    prompt: DAILY_CHECK_PROMPT,
    alwaysDeliver: false,
  },
  {
    id: MONTHLY_SCORE_ID,
    name: 'Monthly score',
    agentRole: 'credit',
    cron: MONTHLY_SCORE_CRON,
    // A month's ask, asked once: two missed 1sts are not two conversations.
    misfirePolicy: 'latest-only',
    prompt: MONTHLY_SCORE_PROMPT,
    // The message is the question. A silent ask is not an ask.
    alwaysDeliver: true,
  },
  {
    id: PRE_STATEMENT_REVIEW_ID,
    name: 'Pre-statement review',
    agentRole: 'credit',
    cron: PRE_STATEMENT_REVIEW_CRON,
    misfirePolicy: 'latest-only',
    prompt: PRE_STATEMENT_REVIEW_PROMPT,
    alwaysDeliver: false,
  },
  {
    id: WEEKLY_CONSOLIDATION_ID,
    name: 'Weekly consolidation',
    agentRole: 'overview',
    cron: WEEKLY_CONSOLIDATION_CRON,
    misfirePolicy: 'coalesce',
    prompt: WEEKLY_CONSOLIDATION_PROMPT,
    alwaysDeliver: false,
    enabledByDefault: false,
  },
];
