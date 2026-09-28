-- speech: voice replies on Telegram, chosen on Settings → Speech ("On
-- Telegram") or with /voice in the chat. The Telegram surface reads them
-- through `speech.telegram_voice` (ownerOnly). Null is "not chosen here":
-- the chat's own setting (core.surface_chat_voice) applies.
alter table settings add column if not exists telegram_voice_when text null
  check (telegram_voice_when in ('spoken', 'always', 'off'));
alter table settings add column if not exists telegram_voice_form text null
  check (telegram_voice_form in ('voice', 'both'));
