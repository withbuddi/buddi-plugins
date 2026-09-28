-- The developer plugin's own schema: which directory an agent works in, the
-- mode the owner chose for it, and the long-lived processes it started.
--
-- Table names are unqualified on purpose: `migrate` runs every file with
-- `set local search_path to developer, public`, so a file can never reach
-- another plugin's tables by accident.

create table if not exists workspaces (
  -- One workspace per agent, which is the whole rule: the agent id is the key.
  agent_id   text primary key,
  -- Absolute, realpath-resolved at the moment the owner approved it.
  dir        text not null,
  -- Chosen by the owner, never by the agent. `edit` is the default.
  mode       text not null default 'edit' check (mode in ('ask', 'edit', 'run')),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table if not exists processes (
  agent_id   text not null,
  -- The agent's own name for it: `dev`, `tests`.
  name       text not null,
  pid        integer not null,
  command    text not null,
  started_at timestamptz not null default now(),
  -- The loopback port it listens on, when one is known. Nullable: most
  -- processes are a test watcher and listen on nothing.
  port       integer,
  -- Where its output is being written, under buddi's data directory.
  log_path   text not null,
  primary key (agent_id, name)
);

-- One row, the owner's. `only_row` is the constraint that says so.
create table if not exists settings (
  only_row         boolean primary key default true check (only_row),
  -- Off by default: it publishes a port on the tailnet. See buddi.md.
  tailscale_routes boolean not null default false,
  updated_at       timestamptz not null default now()
);
