# Image

Pictures for [buddi](https://withbuddi.com). An agent makes one image from a
prompt, optionally from pictures you hand it, and keeps it in your Files
library, where the canvas shows it.

For an agent your other agents can ask for pictures, add the **Illustrator**
from buddi's agent catalogue. If you accepted it (`@art`) from an earlier
version, it keeps working as it is, and buddi offers it the catalogue's
updates while you have not edited it.

## What it needs

An image service you already have, added on Settings → Model accounts: an
OpenAI account, a ChatGPT subscription, Gemini, or any service with an
OpenAI-compatible images endpoint (a local or hosted FLUX server, for
instance). Settings → Image lists the accounts it can use. buddi never reads a
key from your environment.

## What it costs

The plugin is free. Each picture is billed by the service you chose, at its
price (per image on an API account; against your plan on a subscription). At
most 30 images a day by default; you change the limit on Settings → Image.

## What leaves your computer

The prompt, and any reference pictures, go to the service of the account you
chose. The picture comes back and stays on your computer. Nothing else is sent.

## What it asks before doing

The first image in a conversation is an approval card naming the account and
the model; later ones in that conversation run. A colleague the conversation
delegated to counts as the same conversation.

## Install

```sh
buddi plugins install @withbuddi/plugin-image
```

or find it in buddi's plugin market on Settings → Plugins. buddi stages it and
shows what it claims (what it reaches in buddi, the hosts it talks to); nothing
runs until you approve it. Then choose an account on Settings → Image, and
add the Illustrator from the catalogue or give `image.generate` to an agent of
your own.

## Remove

```sh
buddi plugins uninstall image --yes
```

Your pictures stay in the Files library and the plugin's settings stay in the
database. `--purge --confirm image` deletes its settings and history too; that
cannot be undone.

## For developers

`image.generate { prompt, references?, name?, aspect? }` returns
`{ id, name, bytes, width?, height?, backend, account, model, prompt, forAgent }`:
the canvas folds `prompt` under the picture and never draws `forAgent`, the
model's own instruction (core's `AGENT_ONLY_FIELD`).

Each service is one `ImageBackend` in `src/backends/`, listed in `BACKENDS`.
The tool is declared `auto` and narrowed by `tierFor`: gated until the owner
has approved one `image.generate` in the conversation, then auto. With no
usable account chosen it refuses at once and raises no card.

```sh
pnpm install && pnpm --filter @withbuddi/plugin-image build
DATABASE_URL=postgres://… pnpm --filter @withbuddi/plugin-image test
```

The tests run fake services locally; with `DATABASE_URL` they also run the
tool on Postgres (account choice, refusals, the approval, the cap).

Licensed under Apache-2.0.
