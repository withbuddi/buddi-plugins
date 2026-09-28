-- The boundary changed model after two reviews (docs/specs/developer.md §4,
-- §5). Three facts have to be recorded rather than recomputed:
--
--  * `toolchain_path` — the owner's own PATH, asked of their login shell once,
--    at the moment they approved the workspace, and shown on that card. Every
--    command afterwards runs with this PATH and no shell at all, so the value
--    the owner saw is the value that is used.
--  * `git_path` — the git binary resolved from that PATH at the same moment,
--    absolute, so `git` never means "whatever is first on a PATH now".
--  * `started_at_native` — what `ps -o lstart=` said when a process was
--    started. A pid alone is not an identity: after a reboot a recycled pid
--    reads as alive, and `stop` would signal an unrelated process group of the
--    owner's. The pair (pid, start time) is the identity.

alter table workspaces add column if not exists toolchain_path text not null default '';
alter table workspaces add column if not exists git_path text not null default '';
alter table processes  add column if not exists started_at_native text not null default '';
