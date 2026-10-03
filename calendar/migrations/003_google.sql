-- Google accounts (calendar 0.3.0).
--
-- A `google` account is an OAuth sign-in core made for this plugin: the
-- tokens are the owner secret `secret_name`, bound to core's `http.bearer`
-- for this plugin and www.googleapis.com, refreshed and sent by core, never
-- read here. `username` is the account's address (its primary calendar's
-- id); a calendar's `url` is its Google calendar id.
--
-- `needs_sign_in`: Google stopped accepting the sign-in (revoked, or the
-- seven days of testing mode); `signed_out_notified_at`: the one message the
-- owner was sent about it, cleared by signing in again.
alter table account add column if not exists needs_sign_in boolean not null default false;
alter table account add column if not exists signed_out_notified_at timestamptz;

-- A Google sign-in waiting for the owner: where to send them, the core
-- sign-in it belongs to, and the account it renews (null for a new one).
create table if not exists google_sign_in (
  id text primary key,
  account_id text references account (id) on delete cascade,
  secret_name text not null,
  authorize_url text not null,
  expires_at timestamptz not null,
  created_at timestamptz not null default now()
);
