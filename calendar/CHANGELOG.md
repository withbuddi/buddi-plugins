# Changelog

What changes in @withbuddi/plugin-calendar from one release to the next, newest first.

## 0.2.0 — unreleased

### Added

- Link with an app password (Settings → Calendar): iCloud, Fastmail or any CalDAV server. buddi finds the account's calendars with their colours and links the ones with events for reading; you allow changes on the ones agents may add events to. The password is an owner secret buddi signs requests in with; the plugin never holds it (host API 1.26).
- `calendar.create_event`, `calendar.update_event` and `calendar.cancel_event`, each one an approval card: the calendar, the title, when in your format, and before → after for a change. Written in your timezone with its VTIMEZONE; a change made in the calendar since the card is refused, not overwritten. No invitations; a repeating event is changed or cancelled only as a whole series, and cancelling a series is asked for as such.
- Account calendars are read over CalDAV into the same tools, Calendar page, glance and widget; today, upcoming and find give the model the ids of the events it may change.

### Changed

- Needs host API 1.26.
