/**
 * What this plugin knows that no tool schema can hold.
 *
 * A skill is a procedure, proposed and never installed: the owner accepts it
 * through `platform.accept_plugin_skill` and it is theirs from that moment.
 * This one exists because of a real failure. The advisor drove the browser to
 * the bank, read the live balance off the page, answered the owner's question
 * from it — and recorded only the transaction. The browser session ended the
 * conversation, the observation went with the transcript, and the next morning
 * the same question was answered from a ledger balance a fortnight old.
 *
 * A balance that was *seen* is the one number the model cannot recompute. It
 * has to be written down at the moment it is read.
 */
import type { SuggestedSkill } from '@buddi/core/plugin';

export const financeSkills: SuggestedSkill[] = [
  {
    name: 'an-observed-balance-is-recorded',
    description:
      'What to do the moment you read a real account balance — from the browser, a statement, or the owner. Read this before answering any question about how much money there is.',
    body: `A balance you have **observed** is evidence that expires with the conversation. Record it before you answer.

## The rule
When you read an account balance from a live source — a bank or card page in the browser, a statement, a screenshot or PDF the owner sent, or the owner simply telling you what an account holds — call \`finance.set_balance\` **before** you give your answer, with:

- \`balance\`: the amount exactly as the source shows it;
- \`account\`: the account it belongs to;
- \`asOf\`: the date **the source itself** is from — the statement date, the "as of" line on the page, or today when you are looking at a live figure. Never a date you hope it means.

Then say so in your answer, in a clause: "…and I've recorded it as of the 21st." The owner should never have to wonder whether what you saw was kept.

## What is never recorded
A balance you **computed** is not an observation and never goes into \`set_balance\`:

- what \`finance.project_cashflow\` says the balance will be on Friday;
- a recorded balance minus the transactions you know about since;
- a total you added up across accounts;
- what would be left after a purchase you are being asked about.

Recording a computed figure quietly turns your arithmetic into the ledger's truth, and every projection afterwards starts from a guess. Record what you saw; explain what you worked out.

## Why it matters here
Driving the browser fills a transcript fast, so the conversation ends soon after a banking session and the next message starts a fresh one. What you saw on those pages does not come with it — only what you wrote down does. \`finance.set_balance\` is that writing down.

## A duplicate account is merged, never excluded
The same real account recorded twice — 'Checking' and 'Main Checking', one of them
carrying the history and the other the fresh balance — is fixed with
\`finance.merge_accounts\`, which moves the transactions, recurring items and
liabilities onto the account being kept, carries the newer balance over, and
deletes the duplicate. Never "fix" it by setting \`includeInCashflow: false\` on
one of them: that leaves two accounts, two balances and a projection quietly
missing money the owner has. Excluding an account says *this money cannot be
spent* — a 401k, a brokerage — and it never means *this row is wrong*.

An account recorded by mistake that holds nothing at all is deleted with
\`finance.remove_account\`; it refuses the moment anything points at it, and
then the answer is a merge. Both tools ask the owner first and show exactly
what will move and what will be deleted.

## Reading before answering
\`finance.list_accounts\` marks any balance older than a week with \`stale: true\` and its \`balanceAgeDays\`. A stale balance is not a wrong balance, but it is not an answer either:

- say the date you are quoting from, every time it is not today's;
- offer to go and read the real one, and record it when you do;
- \`finance.project_cashflow\` reports \`oldestBalanceAsOf\` — the oldest balance its answer rests on. When that is not today, name it in your reply.

## A goal on debt is a metric, a delta and a deadline
When the owner says they want their debt down by a number in a stretch of months, that is a **goal**, not a reminder and not a promise you make in a sentence. Propose it with \`goal.set\`, and propose it *once*, with:

- \`title\`: a short name the owner will recognise on a card months from now — "Debt down by 40k". It is **required**: a \`goal.set\` without one is refused before the owner ever sees the proposal;
- \`metric\`: \`finance.total_debt\` — the number buddi will measure, whoever is talking to it. \`finance.card_balance\` (with \`params: { "account": "<the card>" }\`) when the goal is about one card, \`finance.cash_available\` when it is about building cash up;
- \`target\`: \`{ "kind": "delta", "value": -40000 }\` — a **delta**, with its sign, because that is how the owner said it. An absolute target is for a number to land on;
- \`deadline\`: an ISO date you worked out yourself from today, never a phrase;
- \`cadence\`: \`weekly\` for debt. It moves with statements, not with hours;
- \`milestones\`: numbers **on the same scale as the target** — deltas when the target is a delta: \`[-10000, -20000, -30000]\`, never \`[77400, 67400]\`. Each fires once, ever.

The whole shape, from the spec:

> "@cfo help me cut my debt by 40k in six months." The advisor reads the
> accounts, proposes: metric \`finance.total_debt\`, delta −40,000, deadline in
> 26 weeks, weekly cadence, milestones at −10k, −20k, −30k. The card says
> "From $87,400 today to $47,400 by 22 March: $1,540 a week, checked weekly,
> held by @cfo". The owner approves. Every week core measures; in week 6
> the projection lands short, the second miss wakes the advisor, which reads
> the cards and the statement dates, and answers with what changed and one
> recommendation, or proposes \`goal.update\`. At −10k the advisor says so, once.

You hold the goal, so you are the one woken about it: when a check wakes you, read \`goal.status\` before you say anything — the numbers there are measured, not remembered — then answer with what changed and **one** recommendation. You never move the line quietly: a target that is not going to work is a \`goal.update\` the owner sees, with the reason.`,
  },
  {
    name: 'coaching-a-credit-score',
    description:
      'How to coach a credit score with the numbers this plugin holds: the levers in the order they actually move, what to ask the owner for once, and the one sentence to answer with. Read this before saying anything about a score, a card limit or utilization.',
    body: `A credit score is coached with four levers, and they are not equal. Work them **in this order** and say only what the tools computed.

## Who does this
The \`credit\` role. This installation gives it to the **Finance Advisor** — it is not a separate agent and should not become one: coaching a score is reading the same cards, the same balances and the same cash flow the advisor already reads, and a second principal would need the same grant for no new reach. If your installation hands the \`credit\` role elsewhere, this skill goes with the role.

## The levers, in order

1. **Utilization at reporting.** The only lever that moves inside one cycle, and the heaviest one the owner controls day to day. It is scored on the balance the issuer **reports at statement close**, not on the balance today and not on the balance at the due date. A payment made the day after the statement closes changes nothing until the next cycle. \`finance.credit_overview\` gives \`reportedUtilizationEstimate\` per card — the figure the bureaus are on course to see — plus the closing date, the days until it, and the payment that brings it to target. Quote those; never recompute them.
2. **On-time payments.** The heaviest factor overall, but it is a floor, not a lever: you cannot make it better this month, only worse. One missed minimum undoes a year of utilization work. \`finance.payment_history\` holds the record and \`finance.minimum-due\` watches the next three days.
3. **Age of accounts.** Moves only with time. Nothing to do about it except not damage it — see below.
4. **Mix.** The smallest factor by a wide margin. Never recommend opening a loan or a card "for the mix"; the hard inquiry and the lowered average age cost more than the mix gains.

## Ask once, then never again
A card's **limit**, its **statement closing day**, the day it **reports**, and its **utilization target** are facts only the owner has. They change almost never. \`finance.credit_overview\` lists everything missing under \`askOnce\`:

- ask for **all of it in one message** — a card's limit and its closing day together, every card at once;
- record the answer immediately with \`finance.set_card_terms\`;
- record a score the moment it is said, with \`finance.record_credit_score\` and the **bureau** it is for. A number mentioned in passing and not written down is gone with the conversation.

Then stop asking. An owner asked twice for the same limit stops answering.

## Never recommend closing an old card
Closing a card removes its limit from the total, which **raises** utilization overnight, and it starts the clock on losing the age of that account. An old card with no fee that the owner never uses is doing nothing but helping. If it carries a fee, the answer is asking the issuer to downgrade it to a no-fee product — the same account, the same age, the same limit — not closing it.

The same restraint applies to opening: no new card "to lower utilization". It lowers the ratio and costs an inquiry and average age, and the owner already has the cheaper move.

## How to say it
**One sentence, with a number in it.** The number is what makes it actionable; the sentence is what makes it heard.

> Amex closes Thursday at 42%; paying 400 by Wednesday brings it under 30%.

\`finance.credit_overview\` already carries that sentence per card, computed from the balance, the limit, the target and the closing date. Say it as written. Do not stack three cards, a score history and a lecture on mix into one message — the owner acts on one sentence and ignores five.

Before recommending a payment, check it against \`finance.project_cashflow\`: a payment that breaches the safety floor is not advice. If the money is not there, say what can be paid and what that lands at — a card at 34% is better than a card at 42% even when 30% was not reachable.

## What is never said
- A score you were not told. There is no way to compute one; \`finance.credit_score_history\` is the only source, and "no score recorded yet" is the honest answer.
- A comparison across bureaus or models. Experian and Equifax do not hold the same file; FICO 8 and VantageScore 3 do not score the same file the same way. A trend is only ever within one bureau.
- A promise of points. "Should help" is the strongest claim available; how much a score moves depends on the file, and the file is not visible here.`,
  },
];
