-- Two changes to what a card costs.
--
-- 1. A new workspace starts in `run` mode. `edit` as the default made every
--    first session a wall of cards for `npm run build`; `run` is what an owner
--    who granted a workspace at all almost always wants, and `ask` and `edit`
--    remain one select away for a repository with something to lose.
--
-- 2. A command the owner approved can be remembered. On the approval card the
--    owner may say "always, in this workspace": exactly this argv, or any
--    command that begins with these words (`npm install …`). The row is bound
--    to the agent *and* the directory, so a workspace moved elsewhere starts
--    with nothing remembered, and it is shown and revocable on Settings →
--    Developer. The words are stored as the argv that will be spawned, never
--    the string a shell would re-read.

alter table workspaces alter column mode set default 'run';

create table if not exists allowed_commands (
  id         bigserial primary key,
  agent_id   text not null,
  dir        text not null,
  -- The words, as `plainWords` read them and as the program receives them.
  argv       jsonb not null,
  -- True: any command whose first words are `argv`. False: exactly `argv`.
  prefix     boolean not null default false,
  created_at timestamptz not null default now(),
  unique (agent_id, dir, argv, prefix)
);
