# news

The news on the topics you follow, from English and French outlets you can
see and change, grouped into stories on your own machine, with what was
already told kept so nothing is told twice.

## What it does

Eleven tools your agents can call. Six read: `news.topics`,
`news.headlines` (the top stories of a topic, or of all, each grouped from
several outlets, with whether it was told already), `news.story` (every
article on one story, with links), `news.search` (the articles kept here, by
words), `news.edition_material` (an edition's stories, untold first) and
`news.read` (an article's text, fetched once from its outlet). Four keep this
plugin's own records and change nothing else: `news.mark_told` and
`news.edition_save` (what an edition told), `news.feedback` ("not
interested", "not today") and `news.quiet_today`. One asks you first:
`news.mute_outlet`.

A News page on the rail, the sources on Settings → News, and a Top stories
widget for Home and the lock screen. It works better with the Speech plugin
(editions read aloud) and says so when it is not there.

Nothing is followed until you turn on the starter sources (Technology, AI,
Togo and West Africa, US politics, International, Economy: about 75 checked
sources) or add a topic of your own, with keywords and feeds. Another plugin
that requires this one may read headlines and a story (its `headlines` and
`story` exports), and nothing else of it.

## What runs on a timer

`news.fetch`, every minute: the sources that are due, each every 15 to 30
minutes, asked only for what changed. New articles are grouped into stories
here, with no service: by the words they share, and by what they say once
you download the meaning model on Settings → News (a small multilingual
sentence model, 135 MB, which runs on this machine; each tick embeds a few
articles within a few seconds and never waits for it). A source that fails is asked less and
less often, is marked failing after a day and paused after a week. It sends
you nothing.

## What it stores

Schema `news`: your topics, the sources and the outlets behind them, the
articles of the last 30 days (title, a short summary, link, language, time),
an article's text when Anchor read it (a week), the stories they form, each
edition's told stories, your settings, and what the meaning model made of
each article and topic name (a list of numbers per article). The model
itself is kept in the plugin's own folder and removed with it. Outlet logos are kept by buddi as
small images (its assets area) and removed with the plugin.

## What leaves the machine

Only feed fetches: a request to each source's address for its latest items,
to Google News with a topic's keywords as the search (an owner topic's name
and keywords are visible to Google) and, once per item, for an item's own
outlet link, to Hacker News's Algolia front page,
to an outlet's site for its icon when it is first seen and once a week
after, and to an article's outlet when Anchor reads it (once, after its
robots.txt). No cookies, no
account, nothing about you, your agents or your conversations. When you
press Download on Settings → News, the meaning model's files are fetched
from Hugging Face (huggingface.co and its download servers), pinned and
checked; nothing is sent. A feed you
add, and an outlet a search names, is declared when it is first seen and
listed on the Plugins page.

Schema: news
Hosts: *.01net.com, 01net.com, *.actuia.com, actuia.com, *.africanews.com, africanews.com, *.agenceecofin.com, agenceecofin.com, *.aljazeera.com, aljazeera.com, *.apnews.com, apnews.com, *.arstechnica.com, arstechnica.com, *.axios.com, axios.com, *.bbc.com, bbc.com, *.blog.google, blog.google, *.bloomberg.com, bloomberg.com, *.cnbc.com, cnbc.com, *.dw.com, dw.com, *.economist.com, economist.com, feeds.bbci.co.uk, *.foxnews.com, foxnews.com, *.france24.com, france24.com, *.frandroid.com, frandroid.com, *.ft.com, ft.com, hn.algolia.com, *.icilome.com, icilome.com, *.importai.substack.com, importai.substack.com, *.jeuneafrique.com, jeuneafrique.com, *.journaldunet.com, journaldunet.com, *.lefigaro.fr, lefigaro.fr, *.lemonde.fr, lemonde.fr, *.lesechos.fr, lesechos.fr, *.liberation.fr, liberation.fr, *.nationalreview.com, nationalreview.com, news.google.com, *.npr.org, npr.org, *.numerama.com, numerama.com, *.nytimes.com, nytimes.com, *.openai.com, openai.com, *.politico.com, politico.com, *.republicoftogo.com, republicoftogo.com, *.reuters.com, reuters.com, *.rfi.fr, rfi.fr, *.semafor.com, semafor.com, *.simonwillison.net, simonwillison.net, *.techcrunch.com, techcrunch.com, *.technologyreview.com, technologyreview.com, *.theguardian.com, theguardian.com, *.thehill.com, thehill.com, *.theverge.com, theverge.com, *.togofirst.com, togofirst.com, *.washingtonexaminer.com, washingtonexaminer.com, *.wired.com, wired.com, huggingface.co, *.hf.co
