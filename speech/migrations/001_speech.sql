-- speech: the owner's choices for listening and speaking, and one row per use.
--
-- Applied with `set local search_path to speech, public`. Never edit an
-- applied file: add 002_*.sql.

-- One row, the owner's. Written only by `speech.set_settings` (ownerOnly).
-- A backend is an id from the plugin's registry (`openai`,
-- `openai-compatible`, later `whisper-local` and `kokoro-local`); the account
-- is a Settings → Model accounts id, for a cloud backend only.
create table if not exists settings (
  id boolean primary key default true check (id),
  listen_backend text null,
  listen_account_id text null,
  listen_model text null,
  listen_language text null,
  speak_backend text null,
  speak_account_id text null,
  speak_model text null,
  speak_voice text null,
  transcribe_cap integer not null default 200 check (transcribe_cap between 1 and 10000),
  say_cap integer not null default 200 check (say_cap between 1 and 10000),
  updated_at timestamptz not null default now()
);

-- Every transcription and every utterance: what the daily caps count, and
-- who asked. The recording and the voice are core.artifacts; the text of an
-- utterance is kept (it is what the agent said), a transcript is not.
create table if not exists usage (
  id uuid primary key default gen_random_uuid(),
  side text not null check (side in ('listen', 'speak')),
  agent_id text not null,
  conversation_id uuid null,
  artifact_id uuid null,
  backend text not null,
  account_id text null,
  model text not null,
  chars integer not null default 0,
  bytes integer not null default 0,
  created_at timestamptz not null default now()
);

create index if not exists usage_side_created_idx on usage (side, created_at desc);
