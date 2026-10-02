# finance

Keeps the owner's money in one place and answers questions about it: accounts
and balances, recurring charges and income, liabilities with their amortization,
credit cards with statements and minimums, receipts, CSV imports staged before
they are committed, and a cashflow projection with a safety floor. It also ships
sentinels that watch for a breached floor, a minimum payment coming due, a stale
balance, a closing statement and receipts nobody matched, and it suggests five
missions: a Friday recap, a daily check, a monthly score ask, a weekly
pre-statement review and a disabled weekly consolidation. It also tidies the
account list itself: the same real account recorded twice can be merged into
one, and an account recorded by mistake and holding nothing can be deleted.

## Who uses it

Installing the plugin gives tools and proposes no agent. The advisor is the
**CFO** in buddi's agent catalogue (withbuddi.com), added with one approval:
roles `overview`, `recap` and `credit`, the ones the sentinels and missions
address, with `finance.*`, its own memory, reminders and schedules.

- An owner who accepted **Ledger** (`@ledger`) from an earlier version keeps
  it: its file, handle, roles, missions (`agent:ledger:daily-check`,
  `agent:ledger:friday-recap`) and data are untouched. The catalogue counts it
  as the CFO and offers the CFO's updates while its file is unedited.
- Any agent the owner gives these roles to, hand-made or not, receives the
  findings and the role missions instead.

## Imports

`finance.stage_import` stages rows without writing them; `finance.commit_import`
writes them after the owner says yes. Up to 200 rows can be passed inline. For
more, pass `file`: the artifact id of a CSV with a header row naming `date`,
`amount` and `description` (`category` and `status` optional), dates
`YYYY-MM-DD` and amounts plain numbers, or of a JSON array of rows. A file in
another shape is refused with what was found; nothing is guessed.

## Fixing mistakes

A wrong row can be fixed. `finance.find_transactions` finds rows by ledger,
dates, amount, text, category, source or the document they came from, and gives
each its id. `finance.update_transactions` changes the date, amount,
description, category or ledger of up to 200 rows, and
`finance.delete_transactions` deletes rows by id, by document, or by a date
range on one account or card. Both ask first, with a preview of every change or
of the rows that will go. To undo an import, delete by the document it came
from, then stage it again. Balances are stated figures, so a fix does not change
them; summaries and typical spending follow at once.

## Credit

It also holds what a credit score rests on, so the advice can be arithmetic
rather than encouragement. Each card carries its statement **closing** day (the
day the issuer snapshots the balance it sends to the bureaus — not the payment
due day), the day that snapshot **reports**, its limit, and the utilization
target it is held to; the installation default is 30% and lives in
`finance.set_preferences`. Scores are recorded per **bureau** with the date and
where the owner read them, and never overwritten, so the trend is readable.

- `finance.credit_overview` — per card: balance, limit, utilization today, the
  target, the next closing date and days until it, the reporting date, and the
  utilization the card is on course to REPORT once the charges billed to it
  land, which is the figure a score is scored on. Then the overall utilization,
  the score history and its trend per bureau. It lists under `askOnce`
  everything that has never been recorded.
- `finance.set_card_terms` — records exactly that: closing day, reporting day,
  limit, per-card target. Only what is passed is changed.
- `finance.record_credit_score` — the bureau, the score, the date, the source.

The `finance.statement-closing` sentinel raises one finding per card per cycle,
three days before the statement closes, when that card is on course to report
above its target. The finding's title is the whole recommendation, computed:
"Amex closes Thursday at 42%; paying 400 by Wednesday brings it under 30%".

Nothing in this plugin names an agent by id. Sentinels ask the host, at poll
time, who holds a role — `credit` first and then `overview` for the credit
watches, `overview` for the rest — and address the finding to whoever that is.
When no agent holds any of them, the finding names nobody and core falls back to
the wake mission's agent, which exists by construction; the plugin says so once
per process rather than on every tick. An unaddressed finding still reaches the
owner. A finding addressed to a deleted agent does not.

The watchers' wakes are gathered: when several findings for the same agent
arrive together (three cards due the same week), the first waits two minutes
for the rest, and one run reads them all and sends one message — never more than
ten minutes after the first. A buddi older than host API 1.20 wakes once per
finding instead.

Two missions belong to the `credit` role: `monthly-score` asks the owner on the
1st for their latest score(s) and records them, and `pre-statement-review` runs
weekly over the cards closing inside seven days. **The `credit` role is not a
new agent — the advisor (the CFO, Ledger, or your own) should hold it.** Coaching a score is reading
the same cards, balances and cash flow the advisor already reads, and a second
principal would need the same grant for no extra reach. The catalogue's CFO
holds all three roles, as Ledger did.

It ships one skill, `an-observed-balance-is-recorded`: a balance read from a
live source — the browser, a statement, the owner saying so — is recorded with
`finance.set_balance` before the answer is given, and a balance that was merely
computed never is. The same skill says what to do about a duplicate account: it
is merged, never hidden by taking it out of the cash flow.
`finance.list_accounts` marks any reading older than a week `stale: true`, and `finance.project_cashflow` names the oldest as-of date its
answer rests on.

It ships a second skill, `coaching-a-credit-score`, for whoever holds the
`credit` role: the levers in the order they actually move (utilization at
reporting, on-time payments, age, mix), what to ask the owner for once and then
never again, that an old card is never closed — closing it removes its limit and
raises utilization overnight — and that the answer is one sentence with a number
in it.

Almost everything it does is a read over its own tables or a pure computation,
and those tools run without asking. `finance.update_transactions` and
`finance.delete_transactions` ask first (see Fixing mistakes). Two more do not
run without asking either, because they DESTROY a record the owner cannot get
back, and both are gated — they describe exactly what will
happen and wait for a yes:

- `finance.merge_accounts` — folds a duplicate account into the one being kept.
  Every transaction, recurring item, liability and staged import that pointed at
  the duplicate is repointed in one transaction, the newer of the two balances
  is the one kept, and the duplicate is then deleted. The approval card names
  the counts of what moves and what goes.
- `finance.remove_account` — deletes an account that nothing points at. It
  refuses the moment anything does, names what, and sends the owner to
  `finance.merge_accounts` instead.

## Numbers a goal can watch

It contributes three metrics — read-only, measured on buddi's own schedule, and
`null` rather than a zero when nothing is recorded. Two of them are the Money
block's own figures without the words; the third is one card:

- `finance.total_debt` — everything owed across the recorded cards and loans,
  in the owner's currency, as of the newest balance stated on one of them. The
  figure the Money block calls "Debt"; it should go **down**.
- `finance.cash_available` — the spendable total, as of the newest balance it
  rests on: the figure the Money block calls "Cash", which excludes retirement,
  brokerage and HSA money. It should go **up**.
- `finance.card_balance` — what one card owes, as of the day that balance was
  stated. Not a Money-block figure: it is about a single card. It takes
  `{ "account": "Rewards Card" }` — the card's name or its id, the way every
  other finance tool names one — and refuses, naming the active cards, when it
  is not one of them. A card that has been paid off and deactivated stops being
  measurable instead: the goal reads "not measured since …" rather than
  reporting the happy ending as an outage. It should go **down**.

Nothing either of them touches leaves this machine; the schema below is the
whole of their reach.

Schema: finance
Hosts: none
