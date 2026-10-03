# @withbuddi/plugin-news

The news on the topics you follow, for [buddi](https://withbuddi.com): a
deliberate mix of English and French outlets, grouped into stories on your own
machine, with what was already told kept so a story is told once and comes
back only with an update. No model, no account, no service of ours in between.

This release is the data layer: fetching, stories, the tools your agents call
and the exports other plugins read. The News page, the source manager and the
Top stories widget come next.

## Install

```bash
buddi plugins install @withbuddi/plugin-news
```

It needs buddi with host API 1.18 or later. Nothing is followed until you
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
so "La Fed abaisse ses taux" and "Fed cuts rates" are one story. Two stories
that share words but name different things stay two. A story ranks higher with
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
| `news.feedback { storyId \| outlet \| topic, action }` | Not interested, mute, snooze, or clear, when you say so. |

Another plugin that requires this one reads the `headlines` and `story`
exports, which answer the same.

## What it stores

Schema `news`: topics, sources and their health, outlets and their icons,
articles of the last 30 days (title, a summary of at most 600 characters, link,
language, time; never the full text), the stories they form, editions and what
each told (90 days), and your settings.

## What leaves your computer

Only feed fetches: each source's address is asked for its latest items;
Google News is sent a topic's keywords as the search (so an owner topic's name
and keywords are visible to Google); Hacker News's front page comes from
Algolia; and an outlet's site is asked for its icon, once a month at most. No
cookies, no referrer, no account, tracking parameters stripped from stored
links. Nothing about you, your agents or your conversations is sent. Hosts the
manifest cannot know (a feed you add, an outlet a search names) are declared
when first seen and listed on the Plugins page.

## License

Apache-2.0.
