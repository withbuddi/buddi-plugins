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

It needs buddi with host API 1.32 or later (buddi's engine for local models,
on top of the logos, the News page and the widget's five rows). Nothing is followed until you
turn on the starter sources or add a topic: the Plugins page says "Add a topic
or turn on the starter sources" until then.

The install stays small: the plugin carries only a tokenizer for the meaning
model. The model runs on buddi's own ONNX engine, which buddi downloads for
this platform only the first time a plugin needs it (about 114 MB, 45 MB on
disk), on the same card as the model.

## Topics and sources

Two starter topics, each a curated mix across the spectrum and both
languages, every address checked to answer a feed (2026-10-03):

| Topic | Sources | |
| --- | --- | --- |
| US | 14 | AP, NYT, NPR, The Guardian, Politico, Axios, Semafor, The Hill, Fox News, Washington Examiner, National Review, The Economist; Le Monde and RFI Amériques (US keywords) |
| International | 14 | Reuters, AP, BBC, Al Jazeera, The Guardian, DW, France 24 (en, fr), NYT, FT; RFI, Le Monde, Libération, Le Figaro |

Outlets whose own feed refuses a reader (AP and Reuters) come through a Google News
search of their site. Paywalled outlets are headlines and summaries only. The
lists are in `src/starter.ts`, with the addresses that did not answer and why.

The starter kit adds 28 feeds for US and International news. US keeps its existing
`us-politics` ID for compatibility. Existing owners’ topics and sources are not
removed by this change. International remains worldwide coverage.

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
interested · Less of this… · Ask Anchor. Ask Anchor opens a new conversation with the story headline and ID attached as a removable reference. Explain this story and Compare the sources send immediately when clicked, preserving any draft in the composer. Anchor retrieves the collected articles with `news.story`.

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

Once the meaning model is downloaded (Settings → News), each tick also embeds
up to 128 new articles within about four seconds, and stories join by meaning
first. Once loaded, the model and its tokenizer take about 150 MB of memory;
buddi unloads the model after five minutes without new articles and loads it
again with the next ones.

## For agents

| Tool | |
| --- | --- |
| `news.topics` | The topics, their sources, which are failing, stories in the last day. |
| `news.headlines { topic?, n ≤ 10, since?, untold? }` | Stories in rank order: title, lead, link, outlets, languages, and new, update or told. |
| `news.story { id }` | Every article on a story, with outlet, language, link, time, opinion and paywall. |
| `news.search { query, topic?, days ≤ 14, n ≤ 10 }` | The articles kept here, by every word, accents aside. |
| `news.mark_told { storyIds, edition }` | Records an edition's stories, so `untold` skips them until a material update: two more outlets, or an article that says something new. |
| `news.feedback { storyId \| outlet \| topic, action }` | Not interested, snooze, mute a topic, or clear, when you say so. |
| `news.edition_material { edition, maxStories?, next? }` | An edition's material: untold stories first (new, or told with an update), grouped by topic in your order, each with its outlets (language, kind, and lean where known), 2 to 4 articles with links, opinion marked; what was told already; your language; whether to read it aloud; whether you asked for quiet news today; your local date and timezone. A next edition time is included only when explicitly supplied; no schedule is assumed. |
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
and keywords are visible to Google); an owner-added Hacker News source uses
Algolia; a Google News item's Google page and Google's decoder are asked once
for the outlet's own link (nothing about you goes with it); an outlet's site is
asked for its icon when it is first seen and once a week after; and an article Anchor reads is fetched from its outlet, once,
after checking its `robots.txt`. No
cookies, no referrer, no account, tracking parameters stripped from stored
links. Nothing about you, your agents or your conversations is sent. Hosts the
manifest cannot know (a feed you add, an outlet a search names) are declared
when first seen and listed on the Plugins page. Download on Settings → News
asks buddi, on one card you approve, for the meaning model
(paraphrase-multilingual-MiniLM-L12-v2, int8 ONNX, 135 MB, from Hugging Face,
each file pinned to a commit and checked by its SHA-256) and, the first time
a plugin needs it, the engine it runs on; buddi downloads both, the plugin
fetches neither, and nothing is sent.

## License

Apache-2.0.

Fresh setup starts with the meaning-model download. Approve the download and continue to sources when it is ready, or explicitly choose word matching for now. The choice is saved; existing configured installations keep their settings accessible.

Step 2 lets you review the 28 US and International starter feeds before enabling them, or add a custom first topic. Settings appear as separate blocks once sources are configured.

Story drawers attribute original headlines, feed excerpts and distinct updates to their publishers. Coverage timelines describe only the sources News collected; they do not establish who first broke a story.

Latest edition opens the most recent saved edition in a scrollable drawer. A story’s “Read the edition” link and an edition notification open the specific saved edition. Editions remain readable while Do Not Disturb holds their notifications.

Enabling Read aloud for a News edition lets Speech narrate that edition in its own mission run, with the configured Speech service and its normal daily limits, without a card each time. News answers buddi's `consent_for_run` export (host API 1.33): yes only for `speech.say`, only in a run started from `edition_material`, and only for an edition you chose — read afresh at every call, so turning it off stops the next one. Speech asks through `approvals.configuredForRun`; other agents, conversations and delegated runs never inherit it.

`news.editions { id?, kind?, limit?, attachAudio? }` reads the saved archive, newest first. No arguments returns the latest edition with its original text and the total number of saved editions. Filter `kind` to morning, midday or evening, use `id` for a particular edition, or `limit` (1–10) for a recent list. Set `attachAudio: true` when showing one edition: its answer then lists the edition's recording under `attachments` (host API 1.33, by the link its report was sent under), and Telegram sends it first with the text below; the dashboard plays it under the call. Omit it for counts and lists. It creates no edition and changes no told marks.

### Story images

RSS Media RSS images/thumbnails, image enclosures, Atom image enclosures, and
images embedded in feed HTML are retained with supplied captions and credits.
Two recent images are cached per polling tick through host HTTP and assets;
the browser only reads local PNGs. The cache retains at most 40 photos, pruning
old photos when its existing bytes exceed 12 MB, within the host’s 20 MB quota.
Only PNG/JPEG/GIF under 256 KB and the host decoder’s pixel limits are accepted.
Missing, unsupported or oversized images leave the text layout intact.

Search results include available cached story images and render as article cards
with source links and attribution. Anchor opens a matching story before explaining
it, so its full sources and illustration are available alongside the answer.

### How News uses buddi's generic contracts (host API 1.33)

- `news.story` and `news.search` answer in buddi's StoryRow words as well
  (`kicker`, `titleAttribution`, `summaryAttribution`, each source's `meta`,
  the timeline as `{ at, text }` in your zone), drawn by the `story` canvas
  renderer (`news.search` as a list, `map: { rows: 'articles' }`). The `story`
  export keeps its earlier shape for plugins that require News.
- `news.story`'s view declares `messenger: { mediaFirst: true }`, and its answer
  lists the story's cached picture under `attachments` (this plugin's own
  asset, captioned with the headline, caption and credit): Telegram sends the
  picture, then the explanation below it.
- `news.editions`'s view declares `messenger: { mediaFirst: true, when:
  { path: 'attachAudio', equals: true } }`.
- `news.edition_save` draws as a `query` view: the `edition` page query and a
  `digest` component. The News page's edition drawer is a `sheet` holding the
  same `digest`; the edition carries its closing line (`foot`) and its report
  link (`report`), from which buddi plays the recording.
- The `consent_for_run` export vouches for `speech.say` in a read-aloud
  edition's run (above).
