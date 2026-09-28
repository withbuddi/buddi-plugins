# speech

Lets your agents listen to a recording and answer with a voice, through a
service you choose on Settings → Speech, or on this computer. It is also how
buddi hears and answers your voice notes on Telegram.

## What it uses

An account from Settings → Model accounts — never a key from the environment:

- **OpenAI**, with an API key: `/audio/transcriptions` to listen and
  `/audio/speech` to speak, billed per minute and per character by OpenAI.
- **An OpenAI-compatible server** that answers the same two routes: a local
  Whisper server, LM Studio, speaches, or a hosted one.

A ChatGPT subscription, a Claude sign-in and Ollama Cloud serve no audio
routes, so they are not offered.

Or no account at all: **Whisper** (small, multilingual, 252 MB) listens and
**Kokoro** (82M, 92 MB) speaks on this computer, in English, French, Spanish,
Italian, Portuguese and Hindi; eSpeak NG (13 MB, GPL-3.0, downloaded with
Kokoro rather than shipped in the plugin) pronounces the languages other
than English. You download them once with Install on the page or
`buddi speech install`; each file is pinned and checked against its SHA-256. They run on ONNX Runtime's prebuilt CPU
binaries, with nothing compiled; those make the plugin itself about 340 MB
on disk.

## What it asks, and how much

The first transcription and the first spoken reply in a conversation are
each an approval card; later ones in the same conversation run. Your own
voice notes on Telegram ask nothing (you are not an agent), and still count. At most 200
transcriptions and 200 spoken replies a day by default; you change both on
the page.

## What it stores

`speech.settings` (the service, account, model, language and voice for each
side, and the two limits) and `speech.usage` (one row per use: the agent, the
conversation, the file, the service and model, the length). A spoken reply is
kept in the Files library as an audio file; a transcript is returned to the
agent and not stored here. The local models, when installed, are in the data
directory under `plugins-data/speech/`.

## What leaves the machine

With a cloud listener, the recording; with a cloud speaker, the text to say.
Each goes to the service of the account you chose: OpenAI (api.openai.com) or
the base URL of your OpenAI-compatible account. With Whisper and Kokoro on
this computer, nothing. Installing them fetches from huggingface.co, its
download servers (*.hf.co) and registry.npmjs.org (eSpeak NG), and sends
nothing. Every request goes through buddi's own web access, which refuses
addresses on this computer and your network; an OpenAI-compatible server of
yours on such an address is reached directly, as buddi reaches it for an
agent.

## What it proposes

One skill, speaking-for-the-ear. No agent. Accepting it is yours.

Schema: speech
Hosts: api.openai.com, huggingface.co, *.hf.co, registry.npmjs.org
