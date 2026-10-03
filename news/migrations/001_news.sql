-- news plugin schema (applied with search_path = news, public).
--
-- The data model of buddi-planning/specs/news-and-anchor.md §3: topics and
-- the sources that feed them (a source may feed several topics), the outlets
-- articles come from with their logos, articles and the topics they belong
-- to, stories per topic, editions and what each told, and settings. Pages,
-- widgets and Anchor read these tables; nothing here is shaped for one screen.

create table if not exists topics (
  id text primary key,
  slug text not null unique,
  name text not null,
  keywords text[] not null default '{}',     -- the Google News query, and the words a keywords-filtered source must match
  languages text[] not null default '{en}',  -- 'en', 'fr': the editions an owner topic's searches ask for
  builtin boolean not null default false,    -- a starter topic
  position integer not null default 0,
  muted_until timestamptz,                   -- 'infinity' for muted for good
  created_at timestamptz not null default now()
);
create unique index if not exists topics_name on topics (lower(name));

-- An outlet's logo, fetched by the plugin. Kept here until the host has an
-- assets area (host API 1.27); `outlets.logo_key` is the key either way.
create table if not exists logos (
  key text primary key,                      -- 'lemonde.fr'
  mime text not null check (mime in ('image/png', 'image/jpeg', 'image/gif', 'image/webp', 'image/x-icon')),
  bytes bytea not null check (octet_length(bytes) <= 262144),
  sha256 text not null,
  source_url text not null,
  fetched_at timestamptz not null default now()
);

create table if not exists outlets (
  id text primary key,                       -- its domain, 'lemonde.fr'
  name text not null,
  domain text not null unique,
  language text check (language in ('en', 'fr')),
  kind text check (kind in ('wire', 'national', 'international', 'regional', 'specialist', 'state', 'company', 'blog')),
  lean text,                                 -- optional, curated US politics only; never shown
  paywall boolean not null default false,
  logo_key text references logos (key) on delete set null,
  logo_fetched_at timestamptz,               -- the last attempt, found or not
  muted boolean not null default false,
  created_at timestamptz not null default now()
);

create table if not exists sources (
  id text primary key,
  outlet_id text references outlets (id) on delete set null,  -- null for Google News, Hacker News, GDELT: their items name the outlet
  name text not null,
  kind text not null check (kind in ('rss', 'atom', 'gnews', 'hn', 'gdelt')),
  url text not null unique,
  final_url text,                            -- where a redirect led; fetched instead of url
  language text not null check (language in ('en', 'fr')),
  opinion boolean not null default false,    -- everything it carries is opinion
  every_seconds integer not null check (every_seconds >= 300),
  etag text,
  last_modified text,
  next_at timestamptz not null default now(),
  last_ok_at timestamptz,
  last_error text,
  failing_since timestamptz,
  failures integer not null default 0,
  state text not null default 'ok' check (state in ('ok', 'failing', 'paused')),
  added_by text not null check (added_by in ('starter', 'owner')),
  muted boolean not null default false,
  created_at timestamptz not null default now()
);
create index if not exists sources_due on sources (next_at) where not muted and state <> 'paused';

create table if not exists topic_sources (
  topic_id text not null references topics (id) on delete cascade,
  source_id text not null references sources (id) on delete cascade,
  filter text not null default 'none' check (filter in ('none', 'keywords')),
  primary key (topic_id, source_id)
);

create table if not exists articles (
  id text primary key,
  source_id text not null references sources (id) on delete cascade,
  outlet_id text references outlets (id) on delete set null,
  url_canonical text not null unique,
  url text not null,                         -- as linked, tracking parameters stripped
  guid text,
  title text not null,
  lead text not null default '',             -- plain text, at most 600 characters
  language text not null check (language in ('en', 'fr')),
  opinion boolean not null default false,
  published_at timestamptz not null,
  fetched_at timestamptz not null default now(),
  tokens text[] not null default '{}',       -- the clustering sequence (text.ts): title then lead terms, in order
  entities text[] not null default '{}',
  title_hash text not null,                  -- of the normalised title, for one outlet's repeats
  search text not null default ''            -- title and lead, lower case without accents
);
create index if not exists articles_outlet_title on articles (outlet_id, title_hash, published_at);
create index if not exists articles_published on articles (published_at);
create index if not exists articles_tokens on articles using gin (tokens);

create table if not exists stories (
  id text primary key,
  topic_id text not null references topics (id) on delete cascade,
  title text not null default '',
  lead text not null default '',
  title_article_id text references articles (id) on delete set null,
  languages text[] not null default '{}',
  first_seen timestamptz not null,
  updated_at timestamptz not null,
  article_count integer not null default 0,
  outlet_count integer not null default 0,
  tokens text[] not null default '{}',       -- the story's most frequent terms
  score real not null default 0,             -- at the last update; lists rank with age applied at read time
  twin_of text references stories (id) on delete set null,
  hidden text check (hidden in ('not_interested', 'snoozed')),
  snoozed_until timestamptz,
  last_told_at timestamptz
);
create index if not exists stories_topic_updated on stories (topic_id, updated_at desc);
create index if not exists stories_tokens on stories using gin (tokens);

create table if not exists article_topics (
  article_id text not null references articles (id) on delete cascade,
  topic_id text not null references topics (id) on delete cascade,
  story_id text references stories (id) on delete set null,
  primary key (article_id, topic_id)
);
create index if not exists article_topics_story on article_topics (story_id);
create index if not exists article_topics_unclustered on article_topics (topic_id) where story_id is null;

create table if not exists editions (
  id text primary key,
  kind text not null check (kind ~ '^[a-z0-9][a-z0-9_-]{0,39}$'),  -- morning, midday, evening; or a brief's own name
  agent_id text,
  language text,
  created_at timestamptz not null default now(),
  text text,
  story_ids text[] not null default '{}'
);

create table if not exists told (
  edition_id text not null references editions (id) on delete cascade,
  story_id text not null references stories (id) on delete cascade,
  told_at timestamptz not null,
  article_count integer not null,
  outlet_count integer not null,
  was_update boolean not null default false,
  primary key (edition_id, story_id)
);
create index if not exists told_story on told (story_id, told_at desc);

create table if not exists settings (
  id boolean primary key default true check (id),
  voice_editions text[] not null default '{}',
  window_hours integer not null default 48 check (window_hours between 12 and 168),
  retention_days integer not null default 30 check (retention_days between 7 and 90)
);
insert into settings (id) values (true) on conflict do nothing;
