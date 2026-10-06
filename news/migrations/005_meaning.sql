-- news 0.2.5: what the meaning model made of each article and each topic's
-- name (embed.ts), so stories cluster by meaning once the owner downloaded
-- it. Each vector names its model: a vector from another model is never
-- compared. Float32, little-endian, 384 of them for the model of 0.2.5.
create table if not exists article_vectors (
  article_id text primary key references articles (id) on delete cascade,
  model text not null,
  vector bytea not null,
  created_at timestamptz not null default now()
);

-- A topic's name, embedded: its direction is taken out of its articles'
-- vectors, as its words are taken out of their terms. Embedded again when
-- the topic is renamed.
create table if not exists topic_vectors (
  topic_id text primary key references topics (id) on delete cascade,
  model text not null,
  name text not null,
  vector bytea not null
);
