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

## The Money page

A place on the rail, **Money** (`#/p/finance/money`), and a Settings entry,
**Settings → Money** (`#/settings/p.finance`). Every figure is read through
the same tools an agent reads, so the page and the CFO never disagree, and
every read that carries an amount is masked until the owner presses Show.

- **Accounts**: one line per account — its name, kind, bank, what it holds and
  the day that was read ("as of 3 Oct"), marked when it is older than a week.
  Update records today's balance (`finance.set_balance`). Empty: "No accounts
  yet", with the first-run sheet in place.
- **Coming up**: the recurring charges due in the next 30 days, soonest first,
  each with its account or the card it is billed to. **Mark paid**
  (`finance.mark_paid`) marks that occurrence and every earlier one paid, and
  takes what the account holds now when the money has already left: Coming up,
  the cash-flow projection and the card's statement forecast then leave it out,
  so a bill paid early is not spent twice.
- **Cards & debts**: the credit overview — per card the share of its limit on
  course to report, the closing day, the minimum and when it is due, and on a
  card over its target the overview's own sentence; loans with their APR. **I
  paid it** records the minimum (`finance.record_payment`).
- **Statements read**: the last eight statements read into an account, with
  the day, the account and what they added ("12 new lines · −€1,240 out ·
  +€2,100 in · 1 Sep – 30 Sep"), and the file to open.
- The head: **Upload a statement** opens the CFO's chat (whoever holds
  `overview`), where a dropped statement is read and staged and the import
  waits on its approval card as before; **Add** → An account (name, kind,
  opening balance: `finance.set_balance`) or A bill or an income
  (`finance.add_recurring`).
- Settings → Money: the currency, the safety floor, and **Show amounts on the
  lock screen** (`finance.set_money_settings`, the owner's alone).

Two widgets open the page. **Money** (`finance.money`) is the cash across
accounts and the next three bills; it carries amounts, so it is sensitive:
hidden on Home until Show and never on a lock screen. **Coming up**
(`finance.due`) is made for the lock screen: what is due and when, and how
much only once the owner ticks Show amounts on the lock screen.

The watchers' findings (a breached floor, a minimum due, a card closing over
target, a stale balance) carry **Open Money**, and their brief asks the agent
to name the page; the Friday recap and the daily check end with it.

## First run: `finance.setup`

"Which bank or account?" — the sheet the host's first-run bank row opens. On
the page it is the drawer `setup`: `#/p/finance/money?open=setup`. Through
the page act route, `POST /api/pages/finance/act` with
`{ tool: "finance.setup", args }`; it is `ownerOnly` (no model sees it) and
`auto`.

```ts
// args
{
  name: string;                 // 1–80, required: "Checking", "Revolut"
  kind?: 'cash' | 'savings' | 'retirement' | 'investment' | 'hsa' | 'other' | '';  // '' or absent: cash
  balance?: number;             // required unless artifactId is given
  asOf?: 'YYYY-MM-DD' | '';     // the day the balance is from; today when absent
  institution?: string | '';    // the bank, when it is not in the name
  artifactId?: string | '';     // a statement already in the Files library (uuid)
}
// answer
{
  accountId: string;            // the account, created or found by name (case-insensitive)
  name: string;
  kind: string;
  balance: number | null;       // null: a new account set up from a statement alone
  balanceAsOf: string | null;
  created: boolean;             // false: an account of that name was updated
  statement?: { artifactId: string; handedTo: string | null };
  message: string;              // the sentence to show: "Revolut is added."
  link: '#/p/finance/money';
}
```

Without a balance and without a statement it refuses ("say what the account
holds, or hand in a statement"); an `artifactId` that is not in the library is
refused too. With a statement, the plugin starts one run (`schedule`,
`enqueueRun`, deduplicated on the file) for the agent holding `overview`,
asking it to stage the statement into that account with
`finance.stage_import`, record the balance it states, and show the owner the
summary before committing: the import waits on its approval card as any
other. With nobody holding `overview`, or a buddi that starts no runs, the
file stays in Files and `handedTo` is null. This is why the plugin now
declares `schedule` ("starts agent runs by itself"): only this sheet uses it,
only when the owner hands in a statement.

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
