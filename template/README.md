# buddi-plugin-template

A [buddi](https://github.com/withbuddi/buddi) plugin. It exports a
`PluginManifest` and depends on `@buddi/core` as a **peer**, never as a normal
dependency: a plugin carrying its own copy of core would register its tools into
a registry nobody reads.

## Build it

```sh
pnpm install
pnpm build      # tsc → dist/
pnpm test       # the manifest, through core's own validation
```

Core is an optional peer. For development, `pnpm-workspace.yaml` points it at a
buddi checkout beside this repository (`../../buddi/packages/core`) with a pnpm
override, the same checkout `finance` uses. That file is never packed, so what
you publish carries the peer range and no link. The checkout must be built
(`pnpm -r build`) before this compiles: its types and entry point are in its
`dist`.

`buddi plugins init <name>` writes this same tree, with the override already
resolved to the core your installation is running. Copying `template/` by hand
is the other way in; rename it, and change `name`, `buddi.name`, `schema` and the tool family
together.

## Install it

```sh
pnpm build
buddi plugins install .          # stages it and prints what it claims; imports nothing
buddi plugins install . --yes    # approves it, imports it, applies its migrations
buddi service restart            # plugins are registered at start
```

Then `buddi plugins list`, and grant `template.*` to an agent on the dashboard's
Plugins page (or in the agent's own `tools:` line).

While you are working on it, `buddi plugins dev .` watches `dist` and tells you
— or the service — to restart when the build changes.

## Publish it

```sh
npm pack      # builds first (prepack) and writes buddi-plugin-template-0.1.0.tgz
buddi plugins install ./buddi-plugin-template-0.1.0.tgz   # exactly what you would publish
npm publish --provenance --access public
```

Publish under a name or scope you own (`@you/buddi-plugin-template`), never
under `@buddi`: buddi does not own that scope on npm. `buddi.name` in
package.json is the plugin's name whatever the package is called.

## What is here

| | |
| --- | --- |
| `src/index.ts` | the manifest: one `auto` tool, one `gated` tool with `describe`, a source stub |
| `migrations/001_template.sql` | the Postgres schema this plugin owns |
| `buddi.md` | what the owner reads before anything is imported |
| `pnpm-workspace.yaml` | the development link to core; not packed |
| `LICENSE` | a placeholder: put the full license text here |

The guide is `docs/plugins.md` in the buddi repository. Read it before you ship:
the tiers, the effect envelope and what a gated `execute` owes the owner are all
decided there.
