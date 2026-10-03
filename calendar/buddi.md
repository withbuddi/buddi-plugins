# calendar

Reads your calendars, so your agents know today, the coming days and when you
are free; and in the calendars you allow, adds, changes and cancels events —
each change approved by you on a card first.

## How it reads them

Two ways, both on Settings → Calendar:

- **Link with an app password**: an iCloud, Fastmail or other CalDAV account,
  signed in with an app-specific password. buddi finds the account's
  calendars and their colours, links the ones with events for reading, and
  you allow changes on the ones agents may add events to.
- **A private link**: a calendar's private ICS address — Google's "Secret
  address in iCal format", Outlook's published ICS link, iCloud's public
  calendar link. Read only.

A link or a password is a credential, so buddi keeps it like one: it becomes
an owner secret in buddi's vault the moment you save it, never shown again.
buddi itself puts it into the requests this plugin makes — the link as the
address, the password as the sign-in — and only to that calendar's server;
the plugin never reads either, and no other plugin can use them.

## What your agents get

Four tools that only read: `calendar.today`, `calendar.upcoming` (up to 14
days), `calendar.find` (a search) and `calendar.free` (the free time in a
day). Three that write, each one an approval card: `calendar.create_event`,
`calendar.update_event` and `calendar.cancel_event`, in calendars you allowed
changes on. They do not invite anyone, leave events with invitees alone, and
change or cancel a repeating event only as a whole series. Times are in your
timezone.

## What you see

Calendar on the rail: the week by the hour, the month by the day, or the next
seven days as a list, each calendar in its own colour, with a filter by
calendar when more than one is linked. On a card, before you approve: the
calendar, the title, when (in your time format), and for a change what it was
and what it will be.

## What it stores

`calendar.account`: each signed-in account's service, server, user name and
the name of the secret that holds its password. `calendar.calendar`: each
calendar's name, colour, where it comes from (an account and its address
there, or the secret that holds its link), whether agents read it and may
change it, and when it was last read. Events are kept in memory for ten
minutes and never written to the database.

## What runs on a timer

Nothing. A calendar is read when an agent asks, at most every ten minutes.

## What leaves the machine

Requests to each calendar's own server: the file behind a private link, and
for an account its calendar list, the events in a window around today, and
the events you approved, written or deleted. Nothing about you or your
conversations is sent. A server on a host other than these is declared when
you add it and listed on the Plugins page.

Schema: calendar
Hosts: calendar.google.com, *.icloud.com, caldav.fastmail.com, outlook.office365.com, outlook.live.com
