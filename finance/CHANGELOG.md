# Changelog

What changes in @withbuddi/plugin-finance from one release to the next, newest first.

## 0.1.5 — unreleased

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
