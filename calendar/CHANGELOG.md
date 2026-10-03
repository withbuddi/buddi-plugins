# Changelog

What changes in @withbuddi/plugin-calendar from one release to the next, newest first.

## 0.3.0 — unreleased

### Added

- The widget gives withbuddi.com and buddi's Browse a sample to draw before anyone installs it (`preview`, one per size), so the listing shows it at both sizes; buddi reads it only for the market.
- Sign in with Google (Settings → Calendar): buddi opens Google's consent page — the events of your calendars and their list, nothing else — and takes Google's answer on this computer; when your browser is on another one, you paste the address Google's last page ended on. buddi keeps the sign-in in its vault, renews it and sends it only to Google's calendar API; the plugin never sees a token (host API 1.28).
- Google calendars are read with Google's own calendar API into the same tools, Calendar page, glance and widget; the calendars the account can write to are linked at first, the others offered under From your accounts.
- `calendar.create_event`, `calendar.update_event` and `calendar.cancel_event` work on Google calendars you allowed changes on, with the same cards and limits; a change made in Google since the card is refused, not overwritten.
- When Google stops accepting the sign-in (revoked, or the seven days of Google's testing mode), the account says "sign in again", Settings → Calendar warns at the top, you get one message with Sign in to Google again, and signing in again keeps every calendar link.

### Changed

- Needs host API 1.28, and may send you a message (`owner:notify`) when a Google sign-in needs renewing.

## 0.2.0 — unreleased

### Added

- Link with an app password (Settings → Calendar): iCloud, Fastmail or any CalDAV server. buddi finds the account's calendars with their colours and links the ones with events for reading; you allow changes on the ones agents may add events to. The password is an owner secret buddi signs requests in with; the plugin never holds it (host API 1.26).
- `calendar.create_event`, `calendar.update_event` and `calendar.cancel_event`, each one an approval card: the calendar, the title, when in your format, and before → after for a change. Written in your timezone with its VTIMEZONE; a change made in the calendar since the card is refused, not overwritten. No invitations; a repeating event is changed or cancelled only as a whole series, and cancelling a series is asked for as such.
- Account calendars are read over CalDAV into the same tools, Calendar page, glance and widget; today, upcoming and find give the model the ids of the events it may change.

### Changed

- Needs host API 1.26.
