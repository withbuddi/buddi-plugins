# image

Makes one picture from a prompt, with a provider account you choose on
Settings → Image, and keeps it in your Files library, where the canvas shows it.

## What it uses

An account from Settings → Model accounts — never a key from the environment
and never your own `~/.codex` login:

- **ChatGPT subscription (a Codex account).** buddi itself asks ChatGPT for
  the picture, with that account's sign-in, through ChatGPT's own image tool;
  the sign-in never reaches this plugin and no `codex` command runs. It uses
  your subscription.
- **OpenAI.** The Images API (`gpt-image-1` unless you name another model),
  billed per image.
- **Gemini (Imagen).** A Gemini account draws with Imagen
  (`imagen-4.0-generate-001` unless you name another) through Google's
  OpenAI-compatible endpoint, billed per image by Google. It takes no
  reference pictures.
- **Any OpenAI-compatible service** (a local or hosted FLUX server, for
  instance) that offers an Images API. Any model name it takes; the account's
  own default until you type one.

## What it asks, and how much

The first image in a conversation is an approval card; later ones in the same
conversation run (a colleague the conversation delegated to counts as the same
conversation). At most 30 images a day by default; you change it on the page.

## What it stores

`image.settings` (the account, the model, the daily limit) and
`image.generation` (one row per picture: the agent, the conversation, the
prompt, the account and model). The picture itself is in the Files library.

## What leaves the machine

The prompt and any reference images, to the service of the account you chose:

- ChatGPT subscription: chatgpt.com (OpenAI), as a request from buddi with
  that account's sign-in.
- OpenAI: api.openai.com.
- Gemini: generativelanguage.googleapis.com (Google). The prompt only; no
  references are sent.
- OpenAI-compatible: the base URL of that account, and nowhere else (an
  answer pointing at another host is not fetched).

## What it ships

One skill, writing-an-image-prompt, for any agent given `image.generate`. It
proposes no agent: the Illustrator is in buddi's agent catalogue. An
Illustrator (`@art`) accepted from an earlier version keeps working, its file,
role and data untouched.

Schema: image
Hosts: chatgpt.com, api.openai.com, generativelanguage.googleapis.com
