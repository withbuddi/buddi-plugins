# @withbuddi/plugin-developer

A workspace an agent may code in, for [buddi](https://withbuddi.com): one
folder you name, on your computer, with a mode you choose. Inside it the agent
reads files, edits them, runs a short list of commands, starts dev servers you
can preview, and commits on a branch of its own. Outside it, none of these
tools do anything.

It also proposes an agent, **developer** (`@dev`), granted these tools and
nothing else. Accepting it is yours; installing the plugin creates nothing.

## The workspace

An agent asks for one with `developer.workspace`, and nothing happens until you
say yes. The card names the folder, the mode and the `PATH` commands will run
with (your login shell's, captured once at that moment). One workspace per
agent; asking for another is another card.

To start a new project, the agent calls `developer.workspace` with
`create: true`. The card says so plainly: create a new, empty folder `<name>`
in `<parent>` and work there in `<mode>` mode. On approval that one folder is
made and becomes the workspace. Its parent must already exist, the name is a
plain folder name, and a folder that appears between the card and your yes is
refused rather than adopted. An existing folder is never emptied or changed.

## The modes

- **ask**: every write and every command waits for your yes.
- **edit**: reads, searches and edits go through; every command asks.
- **run**: edits go through, and so does a pinned list of commands (tests,
  builds, linters, read-only tools such as `ls`, `grep` and `cat`), each with
  the exact flags it may take. Anything else asks, by name: every installer,
  `npx`, `curl`, `ssh`, `git push`, `sudo`, `rm -rf`.

`run` mode runs your project's own scripts, as you: `npm test` does whatever
the `package.json` says, exactly as when you type it.

## Previews

`developer.start` runs a long-lived process (a dev server) and
`developer.preview` shows it on buddi's canvas, behind your dashboard sign-in.
The port is checked against the process itself, and buddi's own ports and the
database's are refused. A Tailscale route for a started process is off by
default; turn it on in Settings → Developer if you want it on your tailnet.

## Safety

**It runs code you did not write, as your user. There is no sandbox.** The
boundary is a rule the plugin enforces, not one the operating system does:

- Every path is resolved inside the workspace; one that leaves it, or passes
  through a symbolic link, is refused.
- Your SSH, cloud, GPG, npm, git and shell configuration, the keychain and
  buddi's own data are refused even when the workspace sits above them.
  Nothing under `.git/` is written.
- There is no shell: a command is spawned directly, so nothing expands, pipes
  or chains. The child gets a minimal environment and none of buddi's: no
  database URL, no keys, no model token.
- A secret reaches a process only when you bound it to that workspace in
  Settings → Keys and secrets. It is never written into a file, a result or a
  log; `developer.write` refuses content carrying a stored secret.
- Git runs with its own configuration and the repository's hooks disabled.
  There is no `push`, no `reset` and nothing that rewrites history.

Give it a folder you would let a colleague use.

## What leaves your computer

Nothing. No tool here reaches the network, and no program that does is on the
run list.

## Install

```sh
buddi plugins install @withbuddi/plugin-developer
```

buddi stages it and shows what it claims; nothing runs until you approve it.
Then accept the developer agent, or give `developer.*` to an agent of your own.

## Remove

```sh
buddi plugins uninstall developer --yes
```

## For developers

`buddi.md` is what the owner reads before installing: the run list, the git
actions, what is stored and what runs where. `node scripts/validate.mjs`
prints the install card for a built plugin without installing it. Build and
test from the repository root (see its README):

```sh
pnpm install && pnpm --filter @withbuddi/plugin-developer build
DATABASE_URL=postgres://… pnpm --filter @withbuddi/plugin-developer test
```

Licensed under Apache-2.0.
