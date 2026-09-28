-- template: the first migration.
--
-- Applied with `set local search_path to template, public`, so table names here
-- are unqualified and this file cannot reach another plugin's tables by
-- accident. Files run in filename order, are tracked by (schema, filename), and
-- are NEVER re-run and never rolled back: add 002_*.sql, never edit this one.
create table if not exists note (
  id uuid primary key default gen_random_uuid(),
  body text not null,
  created_at timestamptz not null default now()
);

create index if not exists note_created_at_idx on note (created_at desc);
