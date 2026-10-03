# Changelog

What changes in @withbuddi/plugin-news from one release to the next, newest first.

## 0.1.0 — unreleased

### Added

- The news data layer: six starter topics (Technology, AI, Togo and West Africa, US politics, International, Economy) with 76 checked English and French sources, and topics of your own; feeds fetched every 15 to 30 minutes with conditional requests, backing off and pausing a failing source; articles grouped into stories on your machine across both languages; `news.topics`, `news.headlines`, `news.story`, `news.search`, `news.mark_told` and `news.feedback` for agents, and `headlines` and `story` exports for other plugins; outlet icons fetched once and served by buddi.
