# @withbuddi/plugin-calendar

Your calendars, for [buddi](https://withbuddi.com), so your agents know what
today holds, what the week looks like and when you are free — and, in the
calendars you allow, add, move and cancel events. Every change is a card you
approve first.

## Install

```bash
buddi plugins install @withbuddi/plugin-calendar
```

It needs buddi with host API 1.28 or later. Then link a calendar on Settings →
Calendar, and grant the tools to an agent (`calendar.*`), or let Planner pick
them up: its morning brief lists today's meetings and the gaps between them
when this plugin is installed. The Chief of Staff in the agent catalogue has
the writing tools too.

There are three ways to link a calendar: a **Google account**, signed in with
Google; an **account** signed in with an app password (iCloud, Fastmail,
CalDAV) — both of which agents can read and, where you allow it, write to; or
a calendar's **private link**, which they can only read.

## Signing in with Google

Settings → Calendar → **Sign in with Google**, then **Continue to Google**:
Google asks whether buddi may

- see, edit, create and delete the events of your calendars
  (`calendar.events`), to read your day and write the events you approve;
- see the list of your calendars (`calendar.calendarlist.readonly`), to show
  them here.

Nothing else: not your mail, contacts, files, or your calendars' sharing
settings. Allow it, come back, and press **Finish signing in**. buddi names the
account by its address, links the calendars you can write to for reading, and
offers the others (holidays, calendars shared with you) under **From your
accounts**, where you link them and **Allow changes** as for any account.

When buddi runs on another computer — a home server, the dashboard opened
over Tailscale — Google's last page cannot load in your browser, since it
points at that computer (`http://127.0.0.1:…`). That is expected: copy the
whole address from that tab, choose **Paste the address instead**, and paste
it.

buddi, not this plugin, runs the sign-in (PKCE, with the answer taken on a
loopback port for ten minutes at most) and keeps the tokens as an owner
secret in its vault, sent only to Google's calendar API
(`www.googleapis.com`) for this plugin and renewed by buddi itself. Settings
→ Keys and secrets lists it as "Calendar sign-in: Google <address>". **Sign
out** forgets it; to take buddi off your Google account too, remove it at
[myaccount.google.com/connections](https://myaccount.google.com/connections).

**While Google is still reviewing buddi** (its "testing" mode), three things
hold: Google warns that the app is unverified (Continue past it), only the
accounts listed as testers can sign in, and a sign-in lasts seven days. When
Google stops accepting a sign-in — after those seven days, or if you revoke
it — the account says **sign in again**, Settings → Calendar says so at the
top, and you get one message with *Sign in to Google again*; nothing fails
silently. **Sign in again** on the account keeps every calendar link and
every permission you gave.

## Linking an account with an app password

Settings → Calendar → **Link with an app password**: pick the service, type
the sign-in name and an app-specific password, and **Sign in and find
calendars**. buddi finds the account's calendars with their colours and links
the ones that hold events for reading. Under **From your accounts** you link
or unlink each one, and **Allow changes** on the ones agents may add events
to; **Read only** takes that back. **Find calendars again** picks up a
calendar you added since; **Sign out** forgets the password.

An app-specific password is a password made for one app, which you can
revoke on its own without changing your account's password:

- **iCloud**: sign in at [account.apple.com](https://account.apple.com) →
  Sign-In and Security → App-Specific Passwords → Generate (it needs
  two-factor authentication, which every recent Apple ID has) → name it
  "buddi" → copy the password, shaped `abcd-efgh-ijkl-mnop`. Sign in with
  your Apple ID (your iCloud email) and that password. Revoking it in the
  same place signs buddi out.
- **Fastmail**: Settings → Privacy & Security → Manage app passwords and
  access → New app password → give it access to "Calendars (CalDAV)" →
  copy it. Sign in with your Fastmail address and that password.
- **Another CalDAV server** (Nextcloud, Radicale, Baïkal, a hosting
  provider): its CalDAV address — Nextcloud's is
  `https://your-server/remote.php/dav` — your user name, and an app password
  if the server offers them. HTTPS on the standard port only.

The password becomes an owner secret the moment you save it, kept in buddi's
vault and never shown again. buddi itself signs each of this plugin's
requests in — only to that account's server (for iCloud, `*.icloud.com`,
where your calendars live on a numbered host), only with the calendar
verbs, with small requests and at most 120 a minute — and the plugin never
holds the password. Settings → Keys and secrets lists it under Calendar
links and sign-ins.

## Linking a calendar by its private link

Each calendar is linked by its private ICS address:

- **Google**: Settings → your calendar → Integrate calendar → Secret address
  in iCal format. A work or school Google account may have it turned off by
  its administrator.
- **iCloud**: in the Calendar app, share the calendar → Public Calendar →
  copy the link (it starts with `webcal://`; paste it as it is).
- **Outlook**: Settings → Calendar → Shared calendars → Publish a calendar →
  copy the ICS link.

Anyone with that link can read the calendar. So buddi keeps it like a
password: the moment you save it, it becomes an owner secret in buddi's
vault (the keychain on a Mac, an encrypted file elsewhere), never shown again. When an agent asks, buddi fetches the link on
this plugin's behalf; the plugin itself never reads it, and no other plugin
can fetch it. If you reset the link at Google or stop sharing at iCloud, the
calendar says it cannot be read; add it again with the new link.

## The Calendar page

The plugin adds Calendar to the dashboard's rail, with three views behind a
switch: the week, its days as columns with the hours down the side and each
event placed at its time (all-day ones at the top); the month, six weeks of
days with up to three events each, and a day's whole list under the grid
when you choose it; and a list, one group per day for the next seven days.
‹ Today › move through the weeks or months, as do the arrow keys, and T comes
back to today. Each calendar has its own colour, and a day with nothing on
says "Nothing.". The page remembers the view you chose; a phone opens on the
list. With more than one calendar linked, a filter at the top shows only the
ones you pick. With none linked, the page links to Settings → Calendar.
It reads through the same ten-minute cache as the tools. You can hide it from
the rail in Settings → Appearance.

## What your agents get

Reading, at once:

- `calendar.today`: today's events, all-day ones first, in your time.
- `calendar.upcoming { days? }`: the coming days, up to 14.
- `calendar.find { query, from?, to? }`: events whose title, place or notes
  match, from 30 days ago to 180 days ahead unless you give dates.
- `calendar.free { date, from?, to? }`: the free time in a day, 09:00 to
  18:00 unless told otherwise.

Writing, each call an approval card, only in calendars you allowed changes
on (today, upcoming and find give the model the id of each event it may
change):

- `calendar.create_event { calendar, title, start, end? | duration?, allDay?,
  location?, notes?, timezone? }`: `start` is `YYYY-MM-DDTHH:MM` in your time
  (or a date for an all-day event, whose `end` is its last day); an hour long
  when neither end nor duration is given. The card says: Add to Work
  (iCloud), the title, when, where.
- `calendar.update_event { id, title?, start?, end?, duration?, allDay?,
  location?, notes?, timezone? }`: only what changes; an empty place or note
  takes it away. The card shows each change as before → after.
- `calendar.cancel_event { id, series? }`: deletes the event.

What they do not do: invite anyone or send invitations, or touch an event
someone else is invited to; change or cancel one occurrence of a repeating
event — a change applies to the whole series (its time of day and length,
not its days), and cancelling a series needs `series: true`, which the card
says in so many words. Times are written in your timezone with the zone's
rules (VTIMEZONE), so an event stays at 09:00 across a clock change. If an
event changed in your calendar between the card and your approval, nothing is
written and the card says so; ask again to see it as it is.

Recurring events, their exceptions and moved instances, all-day and multi-day
events, and events in other time zones are read as your calendar app shows
them. Each calendar is read at most every ten minutes; an account's calendars
are read over five weeks back to six months ahead, and further when the
Calendar page asks.

## Licence

Apache-2.0. It reads ICS with [node-ical](https://github.com/jens-maus/node-ical)
(Apache-2.0).
