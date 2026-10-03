# Changelog

What changes in @withbuddi/plugin-news from one release to the next, newest first.

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
