# developer

A workspace an agent may work in: one directory you name, on this machine, with
a mode you choose. Inside it the agent reads files, edits them, runs a short
list of commands and commits on a branch of its own. Outside it, none of these
tools do anything at all.

**It runs code you did not write, as your user.** There is no sandbox. The
workspace boundary is a rule this plugin enforces — every path is resolved
component by component, any symbolic link is refused, and a path that leaves
the directory is refused — not an operating-system one. `~/.ssh`, `~/.aws`,
`~/.gnupg`, `~/.npmrc`, `~/.netrc`, `~/.gitconfig`, `~/.config/gh`, your shell
rc files, `~/Library/Keychains`, `~/.buddi`, buddi's own data directory and the
vault are refused even when the workspace sits above them. Nothing under
`.git/` is ever written. Give it a directory you would let a colleague use.

## Starting a new project

An agent asked to start a project in a folder that does not exist yet calls
`developer.workspace` with `create: true`. The card says so plainly — "Create a
new, empty folder `<name>` in `<parent>` and work there in `<mode>` mode" — and
on approval that one folder is made and becomes the workspace. Only the last
folder is created: its parent must already exist. The name is a plain folder
name (no `..`, no slashes, not starting with a dot, at most 100 characters),
and the new folder passes the same checks as any workspace, so nothing is
created inside a refused place. If a folder by that name appears between the
card and your approval, the call is refused rather than adopting it; a folder
that already exists is shown as it is, and never emptied or changed.

## How a command runs

There is no shell. A command is split into words and the program is spawned
directly with those arguments, so nothing expands, redirects, pipes or chains.
The child gets an environment this plugin builds — `PATH`, `HOME`, `USER`,
`LANG`, `LC_ALL`, `TERM`, `TMPDIR`, `SHELL` and `CI=1` — and **none** of
buddi's own: no `DATABASE_URL`, no `BUDDI_*`, no vault key, no model token.

The one addition is deliberate, and it is yours: a secret you stored in
Settings → Keys and secrets and bound to this workspace's `developer.env`
arrives in the child's environment under the variable you named. buddi asks
you the first time (or every time, if you bound it that way), and the value is
delivered straight into the process and nowhere else — never into a file,
never into a result, never into a log. A process that prints its own
environment shows `‹secret:NAME›` where the value was.

The `PATH` is your own, captured once by asking your login shell when you
approve the workspace, and printed on that approval card. Everything after that
runs with that `PATH` and no shell.

In `ask` and `edit` mode every command is put to you. In `run` mode a pinned
list runs without a card — and the list is of programs **and their flags**,
because a flag is how a listed program reads somewhere else: `node --import`,
`make -C /tmp`, `grep -f /etc/passwd`, `sort -o /tmp/out`, `find -L`, `rg -L`
are all a listed program doing something the list never meant.

The programs are `node` (on a file, or `--test`), `npm`/`pnpm`/`yarn`/`bun`
with `run`, `test`, `build`, `lint` or `typecheck` and a script name,
`python -m pytest|unittest|mypy|ruff|black`, `pytest`, `go test|build|vet|fmt`,
`cargo test|build|check|clippy|fmt`, `make` with bare targets, `tsc`,
`vitest`, `jest`, `eslint`, `prettier`, `ruff`, `black`, `mypy`, and the
read-only tools `ls`, `cat`, `head`, `tail`, `wc`, `grep`, `rg`, `find`,
`diff`, `sort`, `uniq`, `echo`, `pwd`, `which`. Each one carries the exact set
of flags it may be given; anything else is put to you, by name. A flag's value
has to be the kind the list declares — a word carries no slash, and a glob may
carry one but may not climb or begin with one — and an argument beginning with a dash asks, even after `--`.
Every path, operand or flag value, must be inside the workspace, read against
the directory the command runs in.

Every other command asks, including every installer, `npx` and its cousins,
`curl`, `wget`, `ssh`, `git push`, `sudo` and `rm -rf`.

## Secrets are never written into files

`developer.write` and `developer.edit` refuse content that carries a stored
secret — whatever the file it was headed for, and whether or not it is a
`.env`. The refusal names the secret (`‹secret:NAME›`) and says to bind it
instead. Ordinary `.env` files with ordinary configuration pass unchanged, and
deleting a line that carries a value still works: the check is on what goes
*into* the file, so a value can always be cleaned back out. This is why a
`.env` line for a password or a token should not exist: the owner binds the
secret to `developer.env` for this workspace, and `developer.start` and
`developer.run` put it in the process environment where the project reads it.

**What `run` mode is really agreeing to.** `npm test` and `make` run *this
project's own scripts*, as you. The list bounds which programs start; it says
nothing about what a `package.json` does once one of them is running. That is
the same thing you agree to when you type `npm test` yourself, and it is the
whole of what `run` mode means.

## A workspace of many repositories

A workspace can be a folder that holds several projects — your `Projects`
directory, say. Everything still works: reads, edits, searches and the run
list are about paths, not about repositories. Two things follow, and the agent
is told both:

- **The git tools refuse**, because the workspace is not a repository root. A
  commit or a stash there would take work from projects that have nothing to
  do with the task. When you want an agent to use git, give it the one
  repository as its workspace; the skill tells it to ask you for that.
- **Symbolic links are stepped over, not fatal.** A dotfiles repository full
  of links lists and searches like anything else; the result says how many
  entries were skipped. Only a link in the path you *asked for* is a refusal,
  since then there is nothing to list.

## Git

Git runs from the absolute binary found on that `PATH`, with its own
configuration disabled: no system or global config, an empty hooks directory,
no pager, no signing program, no `core.sshCommand`, no external diff. A
repository's own hooks and filters do not run. The six actions are `status`,
`diff`, `log`, `branch`, `commit` and `stash`; there is no `push`, no `reset`,
no checkout of another branch and nothing that rewrites history. A commit is
free only in `run` mode, because `git add` and `git commit` run a repository's
own filters and hooks — so in `run` mode a commit runs those filters, exactly
as `npm test` runs the project's scripts. `stash` can put changes aside or
list them, never bring them back: that is a merge, and a merge runs the
repository's own merge drivers. The workspace must be the repository root, or
a commit would take work that is not the agent's.

## What it stores

Schema: developer

- `workspaces` — one row per agent: the directory, the mode you chose (`ask`,
  `edit` or `run`), the captured `PATH` and the git binary on it.
- `processes` — the long-lived processes an agent started: name, pid, when the
  operating system says that pid started, command, port and where its output
  is being written.
- `settings` — one row: whether a started process also gets a Tailscale route.

Nothing else is kept. File contents are read and handed to the run that asked
for them; they are not stored here.

## Numbers a goal can watch

One metric, and it never runs anything:

- `developer.failing_tests` — how many tests were failing in the last test run
  recorded for the calling agent's workspace, the same run
  `developer.summarise` reports, as of when it ran. It should go **down**.

  Only a real test runner is believed — `vitest`, `jest`, `pytest`,
  `python -m pytest|unittest`, `go test`, `cargo test`,
  `npm|pnpm|yarn|bun test`, `node --test`, `make test` — because the panel's
  "last test run" also accepts a typecheck or a lint, and a green `pnpm
  typecheck` measured as "0 failing tests" would settle a goal as met with
  nothing having been tested. The count is read from the runners' own summary
  lines and **added up** across them, so a `pnpm -r test` over eight red tests
  in three packages says eight rather than whichever package printed last.

  There is no number — the check records *not measurable* rather than a zero —
  with no workspace, no recorded run (a restart loses the memo), a run that was
  not a test runner, or a failed run whose output never said how many tests
  failed.

## What runs on a timer

Nothing. This plugin has no sources and no sentinels: everything it does
happens because an agent called a tool, or because you pressed something on
Settings → Developer.

## What leaves the machine

Hosts: none

No tool here reaches the network, and no program that does is on the run list,
so `curl`, `wget`, `ssh`, `git push`, `npm publish` and every installer are put
to you for approval in every mode.

Two things put a *port* of this machine in front of something:

- **A preview.** `developer.preview` names a running process; buddi frames it
  on the canvas, served from a second listener of the gateway's with a
  single-use ticket the dashboard hands out, behind your dashboard sign-in.
  Nothing new is exposed, and the plugin never produces a link itself. The port
  is verified against the process's own pid, so a process that merely prints a
  port number does not get one; buddi's own ports, the database's and anything
  privileged are refused.
- **A Tailscale route, off by default.** When you turn it on in Settings →
  Developer, a process that listens on a port also gets `tailscale serve
  --https=<port>` pointing at buddi's preview listener, and anyone on your
  tailnet can reach it, guarded by the tailnet alone. The route is removed when
  the process stops. The listener's port is the one buddi itself reports, not a
  guess; when this buddi is not serving previews, no route is added and the
  tool says so.

## What it writes outside the database

One log file per running process, under buddi's data directory
(`$BUDDI_DATA_DIR`, or `$BUDDI_HOME`, or `~/.buddi`), at
`developer/logs/<agent>.<name>.log`, and one empty directory,
`developer/empty-hooks`, that git's `core.hooksPath` points at. And whatever
the agent edits, which is the point: files inside the workspace you granted.

## What it proposes

One agent, `developer` (handle `@dev`), granted this plugin's tools and nothing
else, with one skill — the loop it works in, what the mode decides, and the
branch rule. It asks for 150 steps per reply (`maxTurns: 150`) rather than the
built-in 40, because coding spends many tool calls on one answer; a reply that
uses them all stops and offers Continue. Change it on the agent's Setup → Brain.
Accepting it is yours; installing the plugin creates nothing.
