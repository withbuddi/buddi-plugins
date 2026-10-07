# Changelog

What changes in @withbuddi/plugin-speech from one release to the next, newest first.

## 0.1.5 — unreleased

### Changed

- `speech.say` results draw as buddi's `audio` canvas renderer (host API 1.33): a player with seeking and an MP3 download, technical details collapsed.

- `speech.say` honours `approvals.configuredForRun` (host API 1.33): a mission run whose context plugin vouches for it through `consent_for_run` (News, for an edition set to be read aloud) speaks without a card; other conversations keep their approval rules.

- Settings → Speech is simpler: no more Service menu. Listening and Speaking each pick an account, and every account that can do it is in the list with what it does: "Gemini · listens and speaks", "OpenAI key · listens and speaks", "Ollama Cloud · speaks (untested)". Whisper and Kokoro stay first, and are used by themselves once installed.
- Accounts that can't do audio are no longer hidden: a ChatGPT subscription or a Claude sign-in shows under each row, greyed, with the reason ("ChatGPT subscription: its backend has no audio").
- Models come from the account itself: OpenAI's transcribe and TTS models, Gemini's Flash and TTS models, or whatever your own server lists. Before an account is saved or tested you see its usual audio models.
- Each row has a Test beside the account: Listening sends a 2-second clip, Speaking says one sentence and plays it, and both say what happened the way Test connection does ("Asked gpt-4o-mini-tts to say … → done in 1.2 s").
- "What leaves" is folded into "What leaves this computer" at the bottom of the page.

### Added

- Gemini listens and speaks: a Gemini account (a Google AI Studio key) now works for both, through Google's own Gemini API.
- A server buddi can't judge (Ollama, any other OpenAI-compatible address) can be tried: pick a model and press Test; once a sample works, Save keeps that model, and the list marks it "· worked".
