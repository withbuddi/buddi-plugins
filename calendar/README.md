# @withbuddi/plugin-calendar

Your calendars, for [buddi](https://withbuddi.com), so your agents know what
today holds, what the week looks like and when you are free. It reads; it
never writes to a calendar.

## Install

```bash
buddi plugins install @withbuddi/plugin-calendar
```

It needs buddi with host API 1.9 or later. Then link a calendar on Settings →
Calendar, and grant the tools to an agent (`calendar.*`), or let Planner pick
them up: its morning brief lists today's meetings and the gaps between them
when this plugin is installed.

## Linking a calendar

Each calendar is linked by its private ICS address:

- **Google**: Settings → your calendar → Integrate calendar → Secret address
  in iCal format. A work or school Google account may have it turned off by
  its administrator.
- **iCloud**: in the Calendar app, share the calendar → Public Calendar →
  copy the link (it starts with `webcal://`; paste it as it is).
- **Outlook**: Settings → Calendar → Shared calendars → Publish a calendar →
  copy the ICS link.

Anyone with that link can read the calendar. So buddi keeps it like a
password: the moment you save it, it becomes an owner secret in your
keychain, never shown again. When an agent asks, buddi fetches the link on
this plugin's behalf; the plugin itself never reads it, and no other plugin
can fetch it. If you reset the link at Google or stop sharing at iCloud, the
calendar says it cannot be read; add it again with the new link.

## What your agents get

- `calendar.today`: today's events, all-day ones first, in your time.
- `calendar.upcoming { days? }`: the coming days, up to 14.
- `calendar.find { query, from?, to? }`: events whose title, place or notes
  match, from 30 days ago to 180 days ahead unless you give dates.
- `calendar.free { date, from?, to? }`: the free time in a day, 09:00 to
  18:00 unless told otherwise.

Recurring events, their exceptions and moved instances, all-day and multi-day
events, and events in other time zones are read as your calendar app shows
them. Each calendar is read at most every ten minutes.

## Licence

Apache-2.0. It reads ICS with [node-ical](https://github.com/jens-maus/node-ical)
(Apache-2.0).
