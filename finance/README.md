# Finance

Your money in one place, for [buddi](https://withbuddi.com). Your agents keep
your accounts, cards, loans, recurring charges and receipts, and answer
questions about them: what is left this month, what a purchase does to the next
weeks, which card to pay first. It projects your cash flow against a floor you
set, and warns you before a balance dips under it, a minimum payment comes due
or a card closes its statement high.

To have someone use it, add the **CFO** from buddi's agent catalogue: a
cash-flow advisor with a daily check and a Friday recap. If you accepted
**Ledger** (`@ledger`) from an earlier version, it keeps working as it is, and
buddi offers it the CFO's updates while you have not edited it.

## Where you see it

**Money** on buddi's rail: your accounts with what each holds and when it was
read, the bills coming up in the next 30 days (Mark paid when one went out
early), your cards and loans, and the statements your CFO has read. Add an
account or a bill from the page; Upload a statement opens your CFO's chat.
Names, banks and dates stay readable; amounts stay hidden until you pick
Amounts shown.
Two widgets for Home and the lock screen: **Money** (your cash and the next
bills, hidden until you tap Show) and **Coming up** (what is due and when,
amounts only if you allow them in Settings → Money).

## What it needs

Nothing to sign up for. You tell buddi your balances, or hand it a statement
(a PDF, a photo, a bank's CSV export) and an agent reads it for you.

## What it costs

Nothing. It runs on your computer. Reading a statement uses your agent's model
like any other message.

## What leaves your computer

Nothing. The plugin talks to no service: every figure is one you or an agent
recorded, kept in buddi's own database under the `finance` schema. What your
agent sends its model is its conversation with you, as always.

## What it asks before doing

Reading and computing run without asking. Anything that writes a batch or
destroys a record waits for your yes, on a card that says exactly what:

- **Importing** a statement or a CSV: the card names how many rows and which
  account or card. You can let it through for the rest of the conversation.
- **Correcting or deleting** transactions: the card shows every change or
  every row that goes.
- **Merging or removing** an account.

## Install

```sh
buddi plugins install @withbuddi/plugin-finance
```

or find it in buddi's plugin market on Settings → Plugins. buddi stages it and
shows what it claims (what it reaches in buddi, the hosts it talks to: none);
nothing runs until you approve it. Then add the CFO from the catalogue, or give
`finance.*` to an agent of your own.

## Remove

```sh
buddi plugins uninstall finance --yes
```

Your records stay in the database. `--purge --confirm finance` deletes them
too; that cannot be undone.

## For developers

`buddi.md` is what the owner reads before installing; it lists every tool,
sentinel and mission. `docs/credit.md` covers the credit tools. Build and test
from the repository root (see its README):

```sh
pnpm install && pnpm --filter @withbuddi/plugin-finance build
DATABASE_URL=postgres://… pnpm --filter @withbuddi/plugin-finance test
```

The DB suites create and drop their own databases beside the one in
`DATABASE_URL`. `scripts/` holds two maintenance scripts (a smoke run and a
recurring-charge finder) that read a live database directly.

Licensed under Apache-2.0.
