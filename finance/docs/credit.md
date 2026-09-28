# Credit: the advisor coaches a score with real data

Status: specification, 2026-09-21. Being built in the finance plugin; the
Credit Coach agent is retired because it had no data of its own.

## Why

A credit score moves on a few levers: utilization at the moment a card
reports, payments on time, the age of accounts, the mix. The finance plugin
already knows the cards, balances and limits. What it lacked: the score
itself over time, each card's statement closing day and reporting day, a
target utilization, and a watcher that speaks up before a statement closes.
Without those, a coach has nothing to say, which is what happened.

## Data

- `finance.credit_scores`: bureau, score, observed on, source, note. The
  advisor asks for the score monthly (a mission) and records what the owner
  reads from their bank or bureau app; it never scrapes one.
- Per card: statement closing day (1 to 31), reporting day (optional, when
  it differs), credit limit, utilization target (default 30 percent, a
  global default in preferences). Asked once, recorded with
  `set_card_terms`, and shown as missing until filled.

## Tools

- `record_credit_score` (auto): one observation.
- `credit_overview` (auto): every card with balance, limit, utilization,
  next closing date and days until it, the estimated reported utilization,
  the overall utilization, and the score history with its trend. One call
  answers "how am I doing".
- `set_card_terms` (auto): the per-card fields above.

## Watcher

`finance.statement-closing`: three days before a card closes, if its
utilization is above target, one finding in one sentence with the number
that fixes it: "Amex closes Thursday at 42%; paying 400 by Wednesday brings
it under 30%." One finding per card per cycle. A finding is a suggestion;
paying is the owner's, through the existing gated flow if a payment tool
ever exists.

## Missions

- `monthly-score`: the 1st of each month, ask for the latest score(s) and
  record them.
- `pre-statement-review`: weekly, run the overview and say what closes in
  the coming week and what to pay before it.

## Role and voice

The Finance Advisor holds the `credit` role; there is one voice for money.
The skill `coaching-a-credit-score` states the levers in order, what to ask
for once, never to recommend closing old cards, and to answer in one
sentence with a number. A distinct coach persona later is a persona swap,
not a data change.

## Acceptance

1. "How is my credit doing" answers with utilization per card and the last
   score, or asks for the two missing terms once.
2. Three days before a closing day with utilization above target, the
   Watchers page shows the finding with the amount and the day.
3. The monthly mission records a score the owner types, and the trend
   shows after two.
4. No tool sends money or touches a card; the plugin only reads and records.
