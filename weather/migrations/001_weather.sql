-- weather plugin schema (applied with search_path = weather, public).
--
-- The owner's places, one of them home; the units they read; and the severe
-- weather already said, so one storm is one message.
create table if not exists place (
  id text primary key,
  label text not null,
  name text not null,
  latitude double precision not null check (latitude between -90 and 90),
  longitude double precision not null check (longitude between -180 and 180),
  timezone text,
  is_home boolean not null default false,
  created_at timestamptz not null default now()
);
create unique index if not exists place_label on place (lower(label));
create unique index if not exists place_one_home on place (is_home) where is_home;

create table if not exists settings (
  id integer primary key default 1 check (id = 1),
  units text not null check (units in ('metric', 'imperial')),
  updated_at timestamptz not null default now()
);

create table if not exists alert (
  key text primary key,
  place_id text not null,
  sent_at timestamptz not null default now()
);
