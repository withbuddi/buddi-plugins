-- calendar plugin schema (applied with search_path = calendar, public).
--
-- One row per linked calendar. The link itself is never here: it is an owner
-- secret (`secret_name`), bound to core's `http.url` for this plugin and its
-- host, and fetched without this plugin ever reading it.
create table if not exists calendar (
  id text primary key,
  name text not null,
  provider text not null,
  host text not null,
  secret_name text not null unique,
  last_fetched_at timestamptz,
  last_error text,
  event_count integer,
  created_at timestamptz not null default now()
);
create unique index if not exists calendar_name on calendar (lower(name));
