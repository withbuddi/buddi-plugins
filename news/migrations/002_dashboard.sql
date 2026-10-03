-- news 0.2.0: the dashboard and the editions.
--
-- Logos move to the host's assets area (host API 1.27): `outlets.logo_key` is
-- now the key of a kept asset, not a row of `logos`. The rows already in
-- `logos` are handed to `assets.put` by the plugin on its first tick (SQL
-- cannot), then deleted; the table goes in a later version.

alter table outlets drop constraint if exists outlets_logo_key_fkey;

-- When the source was last asked, answered or not: the page's "Fetched at 10:00".
alter table sources add column if not exists last_tried_at timestamptz;
update sources set last_tried_at = greatest(last_ok_at, failing_since) where last_tried_at is null;

-- "Quiet news today": the editions left today are skipped until this instant.
alter table settings add column if not exists quiet_until timestamptz;

-- An article's text, fetched once when Anchor reads it (news.read), kept 7 days.
create table if not exists article_texts (
  article_id text primary key references articles (id) on delete cascade,
  status text not null check (status in ('ok', 'refused', 'failed')),
  text text not null default '',
  reason text,
  fetched_at timestamptz not null default now()
);
create index if not exists article_texts_fetched on article_texts (fetched_at);

-- The curated lean of the starter US politics outlets (spec §3, §13.1), as
-- AllSides' published media bias ratings place them: used for the diversity
-- bonus in ranking and given to Anchor, never shown on a card.
update outlets set lean = v.lean from (values
  ('apnews.com', 'lean-left'), ('nytimes.com', 'lean-left'), ('npr.org', 'lean-left'), ('theguardian.com', 'left'),
  ('politico.com', 'lean-left'), ('axios.com', 'lean-left'), ('semafor.com', 'center'), ('thehill.com', 'center'),
  ('foxnews.com', 'right'), ('washingtonexaminer.com', 'lean-right'), ('nationalreview.com', 'right'),
  ('economist.com', 'lean-left'), ('reuters.com', 'center'), ('wsj.com', 'center'), ('bbc.com', 'center')
) as v(domain, lean)
where outlets.domain = v.domain and outlets.lean is null;
