-- speech: the models an account answered a sample with on Settings → Speech.
-- An account buddi cannot judge from its kind and address (Ollama, another
-- OpenAI-compatible server; host API 1.30's `capabilities.source = 'probe'`)
-- is offered as untested, and Save keeps its model only once Test worked
-- with it. One row per account, side and model; a Test that fails later
-- leaves the row: it worked once, and the tools say what failed.
create table if not exists tried (
  account_id text not null,
  side text not null check (side in ('listening', 'speaking')),
  model text not null,
  tried_at timestamptz not null default now(),
  primary key (account_id, side, model)
);
