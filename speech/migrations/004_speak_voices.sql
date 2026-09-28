-- speech: a voice per language ("English voice", "French voice") on
-- Settings → Speech, for a speaker whose voices each speak one language
-- (Kokoro). ISO 639-1 code → voice id. `speak_voice` stays: the voice for a
-- language not in the map, and the one voice of a speaker whose voices carry
-- no language (OpenAI, compatible). Until the next save the plugin reads an
-- empty map with a saved `speak_voice` as that voice for the owner's first
-- language (`store.ts`, `voicesOf`).
alter table settings add column if not exists speak_voices jsonb not null default '{}'::jsonb
  check (jsonb_typeof(speak_voices) = 'object');
