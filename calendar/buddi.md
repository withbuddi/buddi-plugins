# calendar

Reads your calendars, so your agents know today, the coming days and when you
are free. Read-only: nothing is ever written to a calendar.

## How it reads them

Each calendar is linked on Settings → Calendar by its private ICS address:
Google's "Secret address in iCal format", iCloud's public calendar link, or
Outlook's published ICS link. Anyone with that link can read the calendar, so
buddi keeps it like a password: it becomes an owner secret in buddi's vault
the moment you save it, never shown again, and this plugin fetches it through
buddi without ever reading it. No other plugin can fetch it.

## What your agents get

Four tools, none of which changes anything: `calendar.today`,
`calendar.upcoming` (up to 14 days), `calendar.find` (a search) and
`calendar.free` (the free time in a day). Times are in your timezone.

## What it stores

`calendar.calendar`: each calendar's name, service, host, the name of the
secret that holds its link, and when it was last read. Events are kept in
memory for ten minutes and never written to the database.

## What runs on a timer

Nothing. A calendar is read when an agent asks, at most every ten minutes.

## What leaves the machine

A request for each linked calendar's file, to the service that hosts it.
Nothing about you or your conversations is sent. A link on a host other than
these is declared when you add it and listed on the Plugins page.

Schema: calendar
Hosts: calendar.google.com, *.icloud.com, outlook.office365.com, outlook.live.com
