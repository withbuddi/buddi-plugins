# Changelog

What changes in @withbuddi/plugin-news from one release to the next, newest first.

## Unreleased

### Added

- News search results show readable article cards with cached story images; Anchor opens the matching story before explaining it, and Telegram includes its available publisher image.

- Read publisher images, captions and credits from RSS/Atom; cache recent images locally and prefer the headline article’s photo in story views.

### Fixed

- Saved edition requests can include the existing recording on Telegram without generating speech again (`attachAudio: true` lists it under the answer's `attachments`).

### Changed

- Add news.editions so agents can retrieve exact saved editions, filter by edition kind, and count the archive in any chat surface.

- Saved editions include their recording in the drawer; edition players support seeking and local MP3 downloads. Speech and saved-edition canvas results show the content with technical details collapsed.

- Enabling Read aloud for a News edition authorizes Speech for that edition run through the `consent_for_run` export (host API 1.33); other conversations keep their approval rules.

- News uses buddi's generic host API 1.33 contracts: StoryRow fields on `news.story` and `news.search` for the `story` renderer, `attachments` and `messenger.mediaFirst` for Telegram pictures and recordings, a `query` view and `sheet`/`digest` components for saved editions. The `story` export is unchanged.

- Edition material supplies the owner’s local date and timezone and no longer invents a next edition time when the active schedule is unknown.

- Latest edition and story edition links open the saved edition in a scrollable drawer, including an empty state when none is saved.

- News story results open as readable canvas stories with attributed excerpts, linked sources, a coverage timeline and collapsed technical details.

- Ask Anchor carries the selected story into a new conversation so follow-up questions use its collected sources.

- Attribute story headlines and excerpts to their source publishers, suppress duplicate update text, and label the coverage timeline without claiming who first reported a story.

- Guide fresh installs through source selection, with a review of the US and International starter feeds or a custom first topic. Show regular settings as separate sections after sources are added.

- Show the shared model download confirmation directly in News setup and settings, so approving it does not require a trip to Home.

- Present first-run News setup as a compact card with clear download, progress, fallback and next-step copy.

- Fresh News setup starts with the shared meaning-model download, live progress, retry and an explicit word-matching fallback. Sources and other settings appear after that choice; existing configured installations stay accessible.

- The starter kit now contains US and International only, with 28 feeds in English and French. Existing topics and sources stay as the owner configured them.

## 0.2.5 — unreleased

### Added

- Stories cluster by meaning: Settings → News offers a small multilingual sentence model (paraphrase-multilingual-MiniLM-L12-v2, int8, 135 MB) to download, on one card the owner approves; buddi downloads it as a shared model and runs it on its own ONNX engine (host API 1.32), which it downloads for this platform only on first need, on the same card. Each tick embeds a few new articles within four seconds (title and lead, kept per article), and an article joins a story when their meaning is close enough with the topic's own direction taken out, the word rules deciding in an uncertain band and on their own while the model is not downloaded, still loading, or failed. The settings line shows the state of the model and the engine, from buddi: not downloaded, waiting for the card, downloading, ready, or failed with the reason. Stories made by words before the model was ready are grouped again once by meaning when it has caught up.

### Changed

- Needs host API 1.32 (`uses: ['onnx']`). The plugin carries a tokenizer and no ONNX Runtime: the install stays small, and Hugging Face's hosts are no longer in its network list, since buddi fetches the model.

## 0.2.4

### Fixed

- One shared name no longer makes a story: the topic's own name ("Togo" in Togo and West Africa) and the terms running through a tenth of its stories that day no longer count as names, a year is a word, one name in common needs two other words in common too, and an article is compared with the story as a whole and must share a name with its first article, so a story cannot drift from a football match to a tax meeting, nor Malaysia's 2027 budget join France's. On the first tick after the update, the last 48 hours' open stories are grouped again once: a story that survives keeps its id and told-marks, a part split off becomes a new story, and each one's title, counts and "How it moved" follow its own articles.

## 0.2.3

### Added

- The widget gives withbuddi.com and buddi's Browse a sample to draw before anyone installs it (`preview`, one per size), so the listing shows it at both sizes; buddi reads it only for the market.
- An `edition` page query: one saved edition read back for buddi's chat, which draws it as the edition card — the edition's name and time, its first sentence, each topic with its stories (Anchor's headline and line, UPDATE or OPINION, the outlet's logo with up to two more, "and N more" and the link). It reads both the Markdown Anchor writes from 1.0.1 and the plain editions before it; a story is matched to one the edition told by its link, for the logos.

- The `edition` query names each told story's topic and the outlets that can be muted, and hands the chat's card its ways out (Not interested, Mute an outlet, Quiet the topic for a week, Mute the topic) as declared page actions (`actions`: tool, label, args, hint, group, done, undo), so buddi runs them without knowing this plugin's tools.

### Changed

- `news.edition_save` answers with a link that names the edition (`#/p/news/stories?edition=<id>`), so the report's "Open edition" and the chat's card know which one it is.

## 0.2.2

Same as 0.2.1, published from the repository workflow so the market can list it with provenance.

## 0.2.1 — unreleased

### Changed

- The same story in English and French now joins up more often: two articles in different languages are compared on what both languages share (names, numbers and a larger lexicon of news words and countries) once they name three things in common, leaving out names all over the topic that day (the flydubai pair from the first editions is one story now; two Ebola reports about different things stay two). The new words are read only across the two languages, so two articles in one language are judged as before. On the first tick after an update, the last 48 hours' open stories are regrouped by these rules, told-marks kept.
- Deals and buying guides ("% off", "best … to buy", "bon plan", "promo", a discounted price, an outlet's deals section) are marked as they arrive, form stories of their own, and stay out of editions, the widget and the headlines; the News page shows them under a new Deals tab only. Articles from before this version are read once on the first tick.
- A Google News item's link becomes the outlet's own address shortly after it arrives (its Google page, read once with a 1 MB cap and ten seconds, then Google's decoder), so cards, a story's sources and editions link the outlet (an edition resolves its own picks the timer has not reached yet, for up to 25 seconds); when that fails the Google link stays and is marked, and is not asked again.

## 0.2.0 — unreleased

### Added

- The News page: topic chips, All · Not yet told · Today, the last fetch in one quiet line, stories as cards grouped by topic with their outlets' logos, OPINION, FR or EN · FR, "Told you · this morning" or "New since this morning"; each card's ways out (Not interested, mute an outlet, quiet or mute the topic) with Undo in place; a story's sheet with its sources linked out and how it moved; loading, first fetch, failed fetch, all told, a topic with no source, and the phone layout.
- Settings → News: each topic's sources with logo, language, the week's stories and their health in words with the fix as the button; Add a source by feed, site or a Google News search, checked before it is saved; Add a topic; quiet, mute or remove a topic; editions read aloud; Forget what was told.
- The Top stories widget: three headlines with logos at small, five with outlet and age at medium and on the lock screen, untold first; pick topics (the placement is named after them) and Top stories or Not yet told.
- For Anchor: `news.edition_material` (also an export, for a mission's context), `news.edition_save`, `news.read` (an article's text, fetched once and kept a week; paywalls, `robots.txt` and 20 a day respected), `news.quiet_today`, and `news.mute_outlet`, which asks the owner when an agent calls it.
- A curated lean on the US politics outlets (AllSides' ratings), used for ranking and given to Anchor, never shown.

### Changed

- Logos are kept through buddi's assets area (host API 1.27) and refreshed weekly; the ones 0.1.0 kept move there by themselves. Needs host API 1.27.
- Muting an outlet from chat goes through `news.mute_outlet` (asks first); `news.feedback` no longer mutes outlets.

## 0.1.0 — unreleased

### Added

- The news data layer: six starter topics (Technology, AI, Togo and West Africa, US politics, International, Economy) with 76 checked English and French sources, and topics of your own; feeds fetched every 15 to 30 minutes with conditional requests, backing off and pausing a failing source; articles grouped into stories on your machine across both languages; `news.topics`, `news.headlines`, `news.story`, `news.search`, `news.mark_told` and `news.feedback` for agents, and `headlines` and `story` exports for other plugins; outlet icons fetched once and served by buddi.
