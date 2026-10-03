-- CalDAV accounts (calendar 0.2.0).
--
-- An account is a sign-in to a CalDAV server: the user name, the host its
-- password may go to (exact, or `*.icloud.com`), and the name of the owner
-- secret that *is* the app password — bound to core's `http.basic` for this
-- plugin and that host, sent by core, never read here. `kind` is `caldav`;
-- a `google` account (OAuth) is the seam for later.
create table if not exists account (
  id text primary key,
  kind text not null default 'caldav',
  service text not null,
  label text not null,
  server text not null,
  host_pattern text not null,
  username text not null,
  secret_name text not null unique,
  home_url text,
  last_found_at timestamptz,
  last_error text,
  created_at timestamptz not null default now()
);

-- A calendar is a private link (no account) or one calendar of an account,
-- at its own address. Every calendar an account holds has a row; `linked`
-- says whether agents read it, `writable` whether the owner lets them add
-- and change events in it (each change still an approval), `can_write` what
-- the server said about this user's rights (null: it did not say).
alter table calendar add column if not exists account_id text references account (id) on delete cascade;
alter table calendar add column if not exists url text;
alter table calendar add column if not exists color text;
alter table calendar add column if not exists linked boolean not null default true;
alter table calendar add column if not exists writable boolean not null default false;
alter table calendar add column if not exists can_write boolean;
alter table calendar alter column secret_name drop not null;

drop index if exists calendar_name;
create unique index if not exists calendar_linked_name on calendar (lower(name)) where linked;
create unique index if not exists calendar_account_url on calendar (account_id, url) where account_id is not null;
