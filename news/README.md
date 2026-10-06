# @withbuddi/plugin-news

The news on the topics you follow, for [buddi](https://withbuddi.com): a
deliberate mix of English and French outlets, grouped into stories on your own
machine, with what was already told kept so a story is told once and comes
back only with an update. No account, no service of ours in between; stories
are grouped by the words they share and, once you download it on Settings →
News, by what they say, with a small multilingual sentence model (135 MB) that
runs on this machine.

A News page on the rail, the sources on Settings → News, a Top stories widget
for Home and the lock screen, and what Anchor (the news anchor in buddi's
catalogue) needs to write its editions.

## Install

```bash
buddi plugins install @withbuddi/plugin-news
```

It needs buddi with host API 1.27 or later (its logos, the News page and the
widget's five rows). Nothing is followed until you
turn on the starter sources or add a topic: the Plugins page says "Add a topic
or turn on the starter sources" until then.

## Topics and sources

Six starter topics, each a curated mix across the spectrum and both
languages, every address checked to answer a feed (2026-10-03):

| Topic | Sources | |
| --- | --- | --- |
| Technology | 12 | The Verge, Ars Technica, TechCrunch, Wired, NYT, Hacker News, Google News; Le Monde Pixels, Numerama, 01net, Frandroid, Journal du Net |
| AI | 10 | MIT Technology Review, The Verge, The Guardian, Import AI, Simon Willison, OpenAI, Google, Hacker News (AI keywords); Le Monde, ActuIA |
| Togo and West Africa | 15 | Togo First (fr, en), République togolaise, Jeune Afrique, Agence Ecofin, icilome, RFI (fr, en), Le Monde Afrique, Africanews (fr, en), BBC Africa (Togo keywords), Google News (fr, en) |
| US politics | 14 | AP, NYT, NPR, The Guardian, Politico, Axios, Semafor, The Hill, Fox News, Washington Examiner, National Review, The Economist; Le Monde and RFI Amériques (US keywords) |
| International | 14 | Reuters, AP, BBC, Al Jazeera, The Guardian, DW, France 24 (en, fr), NYT, FT; RFI, Le Monde, Libération, Le Figaro |
| Economy | 12 | Reuters, NYT, The Guardian, FT, Bloomberg, The Economist, CNBC; Le Monde (two), Le Figaro, Libération, Les Echos |

Outlets whose own feed refuses a reader (AP, Reuters, Jeune Afrique, Agence
Ecofin, Les Echos, the Togolese government's site) come through a Google News
search of their site. Paywalled outlets are headlines and summaries only. The
lists are in `src/starter.ts`, with the addresses that did not answer and why.

Your own topic is a name, keywords and feeds (a page that names its feed is
fine). With no feed, it follows a Google News search for its keywords in
English and French.

## The News page

`#/p/news/stories`, on the rail. Topic chips (All and yours, "+ Topic" to the
sources) and All · Not yet told · Today; one quiet line on the last fetch
("Fetched at 10:00 from 31 sources · next at 10:15 · 2 aren't answering",
linked to the sources), or the warning when nothing answered. Stories in cards
grouped by topic with See all: the outlets' logos ("RFI Afrique and 3 more"),
the age, the title, two lines, and quiet marks: OPINION, FR or EN · FR, "Told
you · this morning" or "New since this morning". No unread counts.

Each card's ⋯ holds only the ways out: Not interested, Mute an outlet (each of
the story's), Quiet the topic for a week, Mute the topic. The card gives way to
what happened and Undo for eight seconds. A card opens its sheet: the summary,
what is new since you were told, the sources with their logos linked out to
each article (a new tab, no referrer), how the story moved, and Not
interested · Less of this… · Ask Anchor.

States: loading, the first fetch, a failed fetch, everything told, a topic
with no source; on a phone the chips scroll and the ⋯ is a bottom sheet.

## Sources

Settings → News: per topic, each outlet with its logo, language, the stories
it brought this week, and its health in words ("Failing since Tue 08:00:
answered 404.", "Paused: it hadn't answered for a week.", "Muted") with its fix
as the button (Try again, Unmute); ⋯ to mute it or remove it from the topic.
**Add a source** takes a feed, a site (its feed is found), or words to follow
as a Google News search: it is fetched and parsed before anything is saved, and
says what was added. **Add a topic** takes a name, keywords and, optionally, a
feed. The topics can be quieted for a week, muted or removed; editions can be
read aloud (needs the Speech plugin and a voice); and what was told can be
forgotten.

## Logos

An outlet's logo is fetched from its site when it is first seen (the page's
icons, then `/apple-touch-icon.png`, then `/favicon.ico`), kept through buddi's
assets area — buddi re-draws it as a small PNG and serves it to your
dashboard — and fetched again a week later. The dashboard never asks the
outlet for anything. An outlet with no logo is a letter tile.

## Top stories widget

Small: three headlines with their outlet's logo. Medium: five, each with the
outlet and its age. On the lock screen: the medium one, compact. Untold first.
Settings: the topics (none ticked: every topic; a placement with some is named
after them, "Top stories · AI, US politics") and Top stories or Not yet told.

## How it works

Every minute the `news.fetch` timer takes the sources that are due: an
outlet's feed every 15 minutes, a Google News search every 20, asked only for
what changed (ETag and Last-Modified), one request at a time per site. A
source that fails is asked half as often each time, up to every six hours; it
is marked failing after a day and paused after a week, until you try it again.
Items older than three days are not kept, so a laptop that slept a week
catches up in one round.

New articles join a story when they tell the same thing: their words, with
names (people, places, numbers) counting most, compared within a topic over 48
hours. A small lexicon maps French and English news words onto one another,
so "La Fed abaisse ses taux" and "Fed cuts rates" are one story. An English
and a French article are compared on what both languages share (names,
numbers, the lexicon's words) once they name at least three things in common,
not counting a name all over the topic that day. Two stories that share words
but name different things stay two. Deals and buying guides ("% off", "best …
to buy", "bon plan", a price with its currency, an outlet's deals section) are
marked as they arrive and form stories of their own: editions and the widget
leave them out, and the News page shows them only under Deals. A Google News
item's link is swapped for the outlet's own address shortly after it arrives
(the item's Google page, then Google's decoder, once); when that fails the
Google link stays. A story ranks higher with
more outlets, both languages and different kinds of outlet, and fades with
age.

## For agents

| Tool | |
| --- | --- |
| `news.topics` | The topics, their sources, which are failing, stories in the last day. |
| `news.headlines { topic?, n ≤ 10, since?, untold? }` | Stories in rank order: title, lead, link, outlets, languages, and new, update or told. |
| `news.story { id }` | Every article on a story, with outlet, language, link, time, opinion and paywall. |
| `news.search { query, topic?, days ≤ 14, n ≤ 10 }` | The articles kept here, by every word, accents aside. |
| `news.mark_told { storyIds, edition }` | Records an edition's stories, so `untold` skips them until a material update: two more outlets, or an article that says something new. |
| `news.feedback { storyId \| outlet \| topic, action }` | Not interested, snooze, mute a topic, or clear, when you say so. |
| `news.edition_material { edition, maxStories?, next? }` | An edition's material: untold stories first (new, or told with an update), grouped by topic in your order, each with its outlets (language, kind, and lean where known), 2 to 4 articles with links, opinion marked; what was told already; your language; whether to read it aloud; whether you asked for quiet news today; the next edition's time. |
| `news.edition_save { edition, storyIds, text }` | Records the edition and what it told, in one transaction. |
| `news.read { storyId \| articleId }` | An article's text, fetched once when a summary is not enough and kept a week; refused for a paywalled outlet, a page its `robots.txt` closes, and past 20 a day. |
| `news.mute_outlet { outlet, muted? }` | Mutes an outlet everywhere. Asks you first when an agent calls it; your own button on the page does not. |
| `news.quiet_today { undo? }` | "Quiet news today": the editions left today are skipped until midnight. |

Another plugin that requires this one reads the `headlines`, `story` and
`edition_material` exports, which answer the same. A mission names
`edition_material` as its `context` (host API 1.27), so an edition is one model
call.

### Telegram's ways out

An edition sent to Telegram ends with two buttons. They are the mission
report's `actions` (offers: a tap asks Anchor in your words), so no gateway
change is needed; Anchor's package declares them in its edition prompts:

- **Quiet news today** — "Quiet the news for today." Anchor calls
  `news.quiet_today`; the next editions' material says `quietToday` and they
  report nothing until tomorrow.
- **Less of this…** — "Less of something in this edition: ask me which story,
  outlet or topic." Anchor asks, then calls `news.feedback` (a story or a
  topic) or `news.mute_outlet` (an outlet, which asks you first).

US politics outlets carry a lean (`lean`: left, lean-left, center, lean-right,
right) as AllSides' published media bias ratings place them. It adds a little
to a story carried on both sides and is given to Anchor so it can say who says
what; it is never shown on a card.

## What it stores

Schema `news`: topics, sources and their health, outlets, articles of the last
30 days (title, a summary of at most 600 characters, link, language, time), the
text of an article Anchor read (a week), the stories they form, editions and
what each told (90 days), and your settings. Logos are kept by buddi in its
assets area, removed with the plugin.

## What leaves your computer

Only feed fetches: each source's address is asked for its latest items;
Google News is sent a topic's keywords as the search (so an owner topic's name
and keywords are visible to Google); Hacker News's front page comes from
Algolia; a Google News item's Google page and Google's decoder are asked once
for the outlet's own link (nothing about you goes with it); an outlet's site is
asked for its icon when it is first seen and once a week after; and an article Anchor reads is fetched from its outlet, once,
after checking its `robots.txt`. No
cookies, no referrer, no account, tracking parameters stripped from stored
links. Nothing about you, your agents or your conversations is sent. Hosts the
manifest cannot know (a feed you add, an outlet a search names) are declared
when first seen and listed on the Plugins page. Download on Settings → News
fetches the meaning model (paraphrase-multilingual-MiniLM-L12-v2, int8 ONNX,
135 MB) from Hugging Face, each file pinned to a commit and checked by its
SHA-256; nothing is sent.

## License

Apache-2.0.
