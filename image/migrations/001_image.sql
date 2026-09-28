-- image: the owner's choice of account and model, and one row per image made.
--
-- Applied with `set local search_path to image, public`. Never edit an applied
-- file: add 002_*.sql.

-- One row, the owner's. Written only by `image.set_settings` (ownerOnly).
create table if not exists settings (
  id boolean primary key default true check (id),
  account_id text null,
  model text null,
  daily_cap integer not null default 30 check (daily_cap between 1 and 1000),
  updated_at timestamptz not null default now()
);

-- Provenance for every image this plugin stored: who asked, where, with what
-- words, on which account and model. The picture itself is core.artifacts.
create table if not exists generation (
  id uuid primary key default gen_random_uuid(),
  artifact_id uuid not null,
  agent_id text not null,
  conversation_id uuid null,
  prompt text not null,
  aspect text not null,
  reference_ids uuid[] not null default '{}',
  backend text not null,
  account_id text not null,
  model text not null,
  bytes integer not null,
  created_at timestamptz not null default now()
);

create index if not exists generation_created_idx on generation (created_at desc);
