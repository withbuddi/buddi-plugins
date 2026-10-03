-- news 0.2.1: deals apart, and the outlet's own link for a Google News item.

-- What an article is: news, or a deal or buying guide (kept out of editions and
-- the widget, shown under the News page's Deals). Null until the plugin has
-- read it: ingest sets it, and a tick reads the rows from before this version.
alter table articles add column if not exists kind text check (kind in ('news', 'deal'));
create index if not exists articles_unkinded on articles (published_at) where kind is null;

-- A Google News item's link: `resolved` once its outlet's own address replaced
-- the redirect in `url`, `unresolved` when asking for it failed (the redirect
-- stays, marked). Null for every other link, and for one not asked yet.
alter table articles add column if not exists link_state text check (link_state in ('resolved', 'unresolved'));
alter table articles add column if not exists link_tried_at timestamptz;
create index if not exists articles_redirects on articles (published_at) where link_state is null and url like 'https://news.google.com/%';
