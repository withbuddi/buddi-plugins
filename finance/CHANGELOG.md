# Changelog

What changes in @withbuddi/plugin-finance from one release to the next, newest first.

## 0.1.6 — unreleased

### Changed

- The Money page hides amounts, not the page: account names, banks, "as of" dates, what is coming up and your cards stay readable, every amount reads •••• until you press Show amounts (hidden again when you leave the window), and the totals are cards at the top. Before anything is recorded it shows the three ways in: drop a statement, let your CFO read your bank in the browser, or say what an account holds.
- Your currency starts as the one your time zone suggests (dollars in America/…, pounds in London, francs in Zurich, yen in Tokyo; euros otherwise), shown on the first-run sheet to confirm or change, and kept once anything is recorded.
- A bank or card CSV goes in as exported: PNC and other US layouts (Withdrawals/Deposits, Debit/Credit, $ and parentheses, month-first dates, a summary line above the header, no header at all), and a card export's positive charges are flipped. Staging says which lines it could not read and why; a file it cannot read at all says what is missing.
- Your CFO is told to hand a statement file to the import as it is, never to retype or rewrite it.
- Needs buddi with host API 1.31 or later.

## 0.1.5 — 2026-10-05

### Added

- A Money page on the rail: your accounts with what each holds and when it was read, the bills due in the next 30 days, your cards and loans with what to pay before a statement closes, and the statements your CFO has read, with the file to open. Add an account or a bill from the page; Upload a statement opens your CFO's chat.
- Mark paid on a bill coming up: it leaves Coming up and the forecast, so a bill you paid early is not counted twice, and you can say what the account holds now in the same step.
- Two widgets: Money (your cash and the next three bills, hidden until you tap Show, never on the lock screen) and Coming up (what is due and when; amounts only once you tick Show amounts on the lock screen in Settings → Money).
- Settings → Money: your currency, your safety floor, and amounts on the lock screen.
- "Which bank or account?": the first-run sheet (`finance.setup`) takes an account's name, kind and balance, or a statement your CFO then reads into it and asks you about before anything is written.

### Changed

- The watchers' messages open the Money page, and the Friday recap and the daily check end by naming it.
- It now asks to start agent runs by itself: only to hand a statement you dropped on the first-run sheet to your CFO.
- Needs buddi with host API 1.28 or later.
