# Speech

Voice for [buddi](https://withbuddi.com). Your agents listen to a recording
and answer with a voice, and buddi hears and answers your voice notes on
Telegram. You choose who listens and who speaks on Settings → Speech: one of
your model accounts, or models that run on your computer.

## What it needs

One of:

- **An OpenAI account** with an API key, added on Settings → Model accounts.
- **A Gemini account** (an OpenAI-compatible account on Google's address with
  an AI Studio key): it listens with a Flash model and speaks with a TTS
  model, through the Gemini API itself.
- **An OpenAI-compatible server** that answers the same two audio routes: a
  local Whisper server, LM Studio, speaches, Ollama, or a hosted one. buddi
  can't tell what such a server does, so it is offered as untested; press Test
  with a model, and once a sample works Save keeps it.
- **Nothing at all**: Whisper (listens, 252 MB) and Kokoro (speaks, 92 MB, in
  English, French, Spanish, Italian, Portuguese and Hindi) run on your
  computer. You download them once with Install on Settings → Speech or
  `buddi speech install`; each file is pinned and checked against its SHA-256.
  Kokoro brings eSpeak NG (13 MB) to pronounce the languages other than
  English.

A ChatGPT subscription and a Claude sign-in have no audio: the page lists them
greyed under each row with that reason.

Every request goes through buddi's own web access, which refuses addresses on
your computer and your network. One exception: it **talks directly to a server
you run on your own network**. An OpenAI-compatible account whose base URL is
`localhost`, a loopback, private (192.168.x, 10.x, 172.16–31.x, fc00::/7) or
tailnet (100.64.0.0/10) address, or a name that resolves only to those, is
called directly, on any port, as buddi calls it for an agent. Any other base
URL goes through buddi's web access.

The plugin is large: about 340 MB on disk once installed, most of it ONNX
Runtime's prebuilt engine for the local models, which it carries whether you
use them or not.

## What it costs

The plugin is free, and so are the local models. OpenAI bills per minute
listened and per character spoken, Google per token; another service at its
own price. At most
200 transcriptions and 200 spoken replies a day by default; you change both on
Settings → Speech.

## What leaves your computer

With a cloud listener, the recording; with a cloud speaker, the text to say.
Each goes to the service of the account you chose (api.openai.com,
generativelanguage.googleapis.com, or your OpenAI-compatible server). With Whisper and Kokoro, nothing: installing them
downloads from huggingface.co, its download servers (*.hf.co) and
registry.npmjs.org (eSpeak NG), and sends nothing.

## What it asks before doing

The first transcription and the first spoken reply in a conversation are each
an approval card; later ones in that conversation run. A spoken reply's card
also offers "Always: this agent" (buddi's standing approval, kept per agent and
plugin version), so an agent that speaks every morning asks once. Your own voice notes on
Telegram ask nothing, and still count against the limits.

## Install

```sh
buddi plugins install @withbuddi/plugin-speech
```

or find it in buddi's plugin market on Settings → Plugins. buddi stages it and
shows what it claims (what it reaches in buddi, the hosts it talks to); nothing
runs until you approve it. Then choose an account on Settings → Speech.

## Remove

```sh
buddi plugins uninstall speech --yes
```

Spoken replies stay in the Files library; its settings and usage stay in the
database, and downloaded models in `plugins-data/speech/` under buddi's data
directory (Remove on Settings → Speech deletes them first). `--purge --confirm
speech` deletes its settings and usage too; that cannot be undone.

## For developers

`buddi.md` is what the owner reads before installing it; buddi's
`docs/speech.md` is the owner's page.

### Tools

| Tool | Input | Output | Tier |
| --- | --- | --- | --- |
| `speech.transcribe` | `{ artifactId, language? }` | `{ text, language? }` | `auto`, asks once per conversation |
| `speech.say` | `{ text (≤ 4,000 chars), voice? }` | an audio file in the Files library | `auto`, asks once per conversation |
| `speech.set_settings` | one side, or the limits | the settings | `ownerOnly`, the page's Save |
| `speech.test` | `{ side, account?, model?, modelOther?, voice?, languages? }` | `{ message, text? }` or `{ message, play }` | `ownerOnly`, the Test beside each row's Account: the bundled 2-second clip, or one sentence played back, reported as "Asked gpt-4o-mini-tts to say … → done in 1.2 s"; with no `account`, what is saved. A sample that worked on an untested account is kept in `speech.tried` |
| `speech.preview` | `{ account?, model?, modelOther?, voice?, lang? }` | `{ play: { mime, data } }` | `ownerOnly`, the play button beside the Voice or a language's voice (`lang`: the sample's language) |
| `speech.install` | `{ kind: 'whisper' \| 'kokoro' }` | a note; the download runs on | `ownerOnly`, the page's Install |
| `speech.remove` | `{ kind }` | a note | `ownerOnly`, the page's Remove |

`speech.transcribe` reads an audio file (≤ 25 MB, by its bytes: OGG, MP3,
M4A, AAC, WAV, WebM, FLAC). `speech.say` asks for OGG/Opus and keeps what the
service sends as what its bytes say it is; bytes that are not audio are a
refusal. Called as the owner (`agentId: 'owner'`, core's owner path, which is
how Telegram hears a voice note), neither asks for approval. Both count against their daily cap and refuse, with one sentence
naming Settings → Speech, when nothing is set up.

`speech.preview` says "Hi, I'm buddi. This is how I sound." with the choices
the Speaking form holds now, saved or not, and returns the audio as core's
page `play` result: the browser plays it and nothing is kept. No Files
artifact, no usage row, no daily cap; an Ogg answer is cut at 5 s on a page
boundary. Choosing an account there binds it to the plugin, as Save does.

### Backends

Everything vendor-specific sits behind two ports in `src/backends/types.ts`:
`Listener.transcribe` and `Speaker.synthesize`, each with an optional
`stream` (implemented by no backend yet; the telephony plugin needs it).
`SpeechBackend { kind, label, accountKind?, leaves, listener?, speaker?,
voices? }`. The registry (`BACKENDS`, `backendFor`) is exported from the
package root for another plugin to import.

- `openai`: an `openai` account. Defaults `gpt-4o-mini-transcribe` and
  `gpt-4o-mini-tts`. `models(side)` asks the account's `GET /models` (through
  `ctx.buddi.accounts.resolve`, cached ten minutes per account) and keeps the
  ids matching `/transcribe|whisper/` or `/tts|speech/`, the default first;
  a failure is the default alone. Voices: OpenAI's fixed list.
- `openai-compatible`: an `openai-compatible` account, same routes on its
  base URL. Ollama Cloud is refused by its address.
- `whisper-local`: Whisper small (q8, multilingual) through Transformers.js
  on ONNX Runtime (CPU). The recording is decoded to 16 kHz mono in WASM
  (`local/audio.ts`: `ogg-opus-decoder`, `mpg123-decoder`, WAV by hand), one
  transcription at a time, 60 s of work per clip, clips over ten minutes
  refused. The language is detected in one decoder step; with the
  owner's languages (`ListenRequest.languages`, several) every other token is
  masked, so the likeliest of theirs wins. It comes back with the text.
- `kokoro-local`: Kokoro-82M (q8). English through `kokoro-js`, which
  phonemizes it itself; French (`ff_siwis`), Spanish (`ef_dora`, `em_alex`,
  `em_santa`), Italian (`if_sara`, `im_nicola`), Portuguese (`pf_dora`,
  `pm_alex`, `pm_santa`) and Hindi (`hf_alpha`, `hf_beta`, `hm_omega`,
  `hm_psi`) through eSpeak NG, as Kokoro's Python pipeline (misaki's
  `EspeakG2P`) does: `local/phonemes.ts` cuts the text at its punctuation,
  asks eSpeak for IPA with stress (voices `fr`, `es`, `it`, `pt-br`, `hi`),
  folds its two-letter phonemes to Kokoro's symbols (`tʃ`→`ʧ`, `eɪ`→`A`…),
  keeps only what Kokoro's tokenizer knows (an unknown symbol is dropped and
  logged once), and the model reads the ids with the voice
  (`generate_from_ids`). The voice's first letter is the language
  (`local/voices.ts`). `Speaker.voiceForText` picks the voice of the reply's
  language (the language the text looks like, `guessLanguage`, or the
  owner's one spoken language): a voice the call named when it speaks it,
  else the owner's voice for that language (`speak_voices`), else the chosen
  voice when it speaks it, else that language's first voice;
  `speech.say`, and so Telegram and the dashboard, go through it. An
  English voice with a text clearly not English is a typed
  `NotEnglishRefusal`, code `not-english` ("not in a language this voice
  speaks"). Japanese and Chinese voices are in the pack but not listed:
  misaki uses pyopenjtalk and a pinyin front end for them, not eSpeak.
  24 kHz PCM is encoded to OGG/Opus at 24 kbps by `local/ogg-opus.ts`
  (`opusscript`'s WASM libopus and a small OGG page writer).

Both run in a `worker_threads` Worker of the plugin's own (`local/worker.ts`,
`local/engine.ts`; `local/client.ts` on the main side, one call at a time),
so the rest of buddi keeps answering while a model runs: ONNX Runtime's Node
binding runs a session synchronously. Budgets: 60 s per clip, 90 s and
4,000 characters per reply; past a budget the call is refused and the worker
is terminated and started again. ONNX uses `min(4, cores − 2)` threads (at
least one); `SPEECH_THREADS` overrides it.

Both read only from `<data>/plugins-data/speech/{whisper,kokoro,espeak}`
(`env.allowRemoteModels = false`). `install.ts` fetches them, through
`ctx.buddi.http` (`net.ts`: redirects followed hop by hop through the host,
since Hugging Face answers each file with one to its CDN): a pinned
manifest (`local/models.ts`, Hugging Face `resolve/<commit>` URLs, sizes and
SHA-256), downloaded into a temporary directory, verified, then renamed into
place; a failed hash keeps nothing. `installLocal`, `installedLocal` and
`removeLocal` are exported for `buddi speech install`, which hands
`installLocal` an `http` area of its own (core's address rules, and any host
not declared under `network` refused), so the CLI path follows the same rules
without a running gateway; the page uses
`speech.install` (background) and polls `install_status`. With nothing
chosen for a side and the model installed, the local backend is used.

eSpeak NG is not in `package.json` (this plugin is GPL-3.0 like it, but
the build is 25 MB nobody needs without Kokoro): it is Kokoro's companion in
the manifest (`COMPANIONS`),
Echogarden's Emscripten build (`@echogarden/espeak-ng-emscripten` 0.3.5,
asm.js, every eSpeak language), fetched as its npm registry tarball
(12.5 MB), checked by SHA-256 and unpacked (`local/untar.ts`) into
`espeak/`: `espeak-ng.js`, `espeak-ng.data` and `COPYING`. Kokoro-FastAPI
keeps it apart the same way: its image installs espeak-ng from the
distribution and misaki loads it through `espeakng-loader`. It has its own
marker: a Kokoro installed before it keeps speaking English
(`installedLocal().kokoro.usable`), `installed` stays false with `missing`
its size, and the next install fetches only eSpeak. (`kokoro-js`'s own
`phonemizer` dependency embeds an English-only eSpeak NG under an
Apache-2.0 label.)

### Settings

`speech.settings`, one row: `listen_backend`, `listen_account_id`,
`listen_model`, `listen_languages` (the languages the owner speaks, ISO 639-1
codes from `src/languages.ts`, at most 8; empty lets the service detect any;
one is sent as `language`, several restrict Whisper's detection and send a
cloud service nothing), `speak_backend`, `speak_account_id`,
`speak_model`, `speak_voice`, `speak_voices`, `transcribe_cap` and `say_cap` (200 each).
`speak_voices` (`004_speak_voices.sql`) maps a language to its voice for a
speaker whose voices carry their language (`SpeechBackend.languageVoices`:
Kokoro); `speak_voice` stays the voice for a language not in it and the one
voice of the others. Before the first save that writes the map, the one
voice reads as the voice of its own language when the owner speaks it, else
of the first listed language, else English. On the page, such a speaker gets
one field per language (`voice_en`, `voice_fr`… with their play buttons,
Kokoro's order) for the languages listed, in place of Voice; a cloud
speaker, or no listed language Kokoro speaks, keeps the one Voice field.
`listen_language`, the one hint of earlier versions, is moved into the list
by `002_listen_languages.sql` when it is a code, read as a one-element list
when it is a name, and cleared on the next save. The page's Model fields are
selects filled by the `listen_models` and `speak_models` queries, with
"Other…" revealing a text field; the Speaking block says when Kokoro is the
speaker and a listed language has no Kokoro voice (Japanese, Chinese,
German…): "No German voice on this computer; German replies use the cloud
speaker when one is set, else text."
`speech.usage` is one row per use, which the caps count from midnight in the
owner's timezone.

The page has no Service field: each row (Listening, Speaking) picks an
Account, `local` (Whisper or Kokoro, first, and chosen by itself once
installed with nothing else chosen), an account id, or `off`; Save stores
the backend that account runs (`backendForAccount`: `openai`, `gemini` for
an account on generativelanguage.googleapis.com, else `openai-compatible`),
and the tools derive it from the account again, so a Gemini account saved
before this version runs on Gemini. Which accounts a row offers comes from
host API 1.30's `capabilities` (`{ audioIn, audioOut, source }`), worked out
the same way from `kind` and `baseUrl` on an older buddi
(`capabilitiesOf`): `known` accounts are labelled "listens and speaks",
`probe` ones "speaks (untested)" until a Test worked ("(tried)"), and `none`
ones (a ChatGPT subscription, Claude) are faint lines under the row with
the reason. Models come per account: OpenAI's `/models` kept to the
transcribe and TTS families, the Gemini API's `/v1beta/models` kept by
`supportedGenerationMethods` (Flash models that take a file for listening,
TTS models for speaking; Live-only ones left out), a compatible server's
`/models` with the likely ones first and those a Test worked with first,
marked "· worked". A page's query may not bind an account, so until Save or
Test binds one, OpenAI and Gemini offer their known audio models. Save
keeps a model on a `probe` account only once `speech.tried` has it
(`005_tried_models.sql`). What leaves folds into "What leaves this computer"
at the foot of the page.

### Build and test

```sh
pnpm install && pnpm --filter @withbuddi/plugin-speech build
DATABASE_URL=postgres://… pnpm --filter @withbuddi/plugin-speech test
SPEECH_REAL_MODELS=1 pnpm vitest run src/local.real.test.ts   # downloads and runs the real models
```

`SPEECH_MODELS_DIR` keeps the downloaded models between runs of the real
suite; without it they go to a temporary directory that is deleted.

`@huggingface/transformers` lists `onnxruntime-web`, which its Node build never
loads; `package.json` overrides it with `stubs/onnxruntime-web` (a package that
throws if anything ever loads it), which saves about 90 MB per install.

Licensed under GPL-3.0-only, because the local voice runs eSpeak NG (GPL-3.0).

`speech.say` speaks without a card in a mission run whose context plugin vouches for it: Speech asks `ctx.buddi.approvals.configuredForRun('speech.say')` (host API 1.33), and buddi asks that run's context plugin through its `consent_for_run` export, afresh at every call (News does so for an edition you set to be read aloud). The configured Speech service and its daily limits still apply; other agents, conversations and delegated runs never inherit it. Its result draws as the `audio` canvas renderer.
