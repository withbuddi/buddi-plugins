# buddi-plugins

The first-party plugins for [buddi](https://github.com/withbuddi/buddi), one
directory each, published to npm as `@withbuddi/plugin-<name>`:

| Plugin | npm | License |
| --- | --- | --- |
| [calendar](calendar/README.md) | `@withbuddi/plugin-calendar` | Apache-2.0 (needs host API 1.9) |
| [finance](finance/README.md) | `@withbuddi/plugin-finance` | Apache-2.0 |
| [image](image/README.md) | `@withbuddi/plugin-image` | Apache-2.0 |
| [speech](speech/README.md) | `@withbuddi/plugin-speech` | GPL-3.0-only (its local voice runs eSpeak NG) |
| [weather](weather/README.md) | `@withbuddi/plugin-weather` | Apache-2.0 |

Install one with `buddi plugins install @withbuddi/plugin-<name>`, or from
Settings → Plugins. Each plugin's README says what it needs, what it costs and
what leaves your computer.

A plugin is an ordinary npm-style package that exports a `PluginManifest` and
imports `@buddi/core`. Core never imports a plugin, so a plugin lives outside
buddi's tree and installs into a running installation like any other package.
`@buddi/core` is a **peer** dependency and never a normal one: a plugin carrying
its own copy of core would get a second registry, a second pool and a second set
of module-level singletons, and its tools would register into an object nobody
reads.

## Developing against a local checkout

Core is not on npm, so for development `pnpm-workspace.yaml` points
`@buddi/core` at a buddi checkout beside this repository with a pnpm override:

```yaml
overrides:
  '@buddi/core': 'link:../buddi/packages/core'
```

A plugin's own package.json names core only as an optional peer
(`peerDependencies` and `peerDependenciesMeta`), and the workspace file is never
packed, so what npm publishes carries no link and an installed plugin gets the
core of the buddi that installs it. That assumes `buddi` and `buddi-plugins`
are siblings.

The linked core must be built (`pnpm -r build` in the buddi checkout) before
anything here compiles: the link points at the package, and the package's types
and entry point are in its `dist`.

## Build, typecheck, test

```sh
pnpm install
pnpm build       # pnpm -r build  — tsc per plugin, output in <plugin>/dist
pnpm typecheck   # pnpm -r typecheck
pnpm test        # pnpm -r test   — vitest per plugin
```

Some suites need Postgres. They resolve their connection the way the
application does, and skip with one printed line when nothing answers. To run
them, point `DATABASE_URL` at a throwaway database you are happy to have test
databases created and dropped beside:

```sh
docker run -d --rm --name plugins-pg -e POSTGRES_USER=buddi -e POSTGRES_PASSWORD=test \
  -e POSTGRES_DB=buddi -p 127.0.0.1:55499:5432 postgres:16
DATABASE_URL="postgres://buddi:test@127.0.0.1:55499/buddi" BUDDI_VAULT=memory pnpm test
```

Each DB suite creates and drops its own throwaway database; nothing is written
to the one named in the URL.

## Installing a build of your own

`npm pack` in a plugin's directory builds it (`prepack`) and writes the tarball
npm would publish; install that, exactly as a stranger would:

```sh
cd finance && npm pack
buddi plugins install ./withbuddi-plugin-finance-0.1.0.tgz   # stages it and prints the approve line
```

A built directory installs too (`buddi plugins install /path/to/buddi-plugins/finance`),
with the plain `--yes`: a directory has no integrity hash. The plugin's tools
are registered by the next process start.

Each plugin ships a `buddi.md`: prose the owner reads *before* anything of it is
imported, with `Schema:` and `Hosts:` lines that are compared with the manifest
after the import. A difference is not refused — it is shown as drift, and costs
a second approval.

## Publishing

A tag `<name>@<version>` (`git tag finance@0.1.1 && git push --tags`) runs
`.github/workflows/publish.yml`: it checks that the plugin's package.json is at
that version, builds buddi's core beside it, typechecks and tests the plugin on
a Postgres service, and publishes it with `npm publish --provenance --access
public` (a pre-release version under the `next` dist-tag). No npm token lives in
this repository: npm trusts the workflow.

**Once per plugin, on npmjs.com**, by an owner of the `withbuddi` scope: package
`@withbuddi/plugin-<name>` → Settings → Trusted publisher → GitHub Actions,
owner `withbuddi`, repository `buddi-plugins`, workflow `publish.yml`,
environment `npm`. The GitHub repository needs an environment named `npm`
(Settings → Environments). If npm offers no settings page for a package that
does not exist yet, publish its first version by hand from a clean checkout
(`npm publish --access public` in its directory, logged in as a scope owner),
then add the trusted publisher.

Every pull request also runs `.github/workflows/pack-check.yml`: it packs each
plugin and installs the tarballs with buddi's CLI from npm
(`@withbuddi/buddi`, its `latest`) in a scratch data directory — stage, approve, then
`buddi plugins list` must say ok.

## Shared skills

`skills/` holds skills that belong to no plugin: a markdown procedure an agent
reads, granting nothing. They install by being copied into an installation's
shared skills directory rather than by installing a package — `skills/README.md`
has the file format the loader expects and the two ways to install one.

## Writing your own plugin

`template/` is a complete, buildable plugin with nothing domain-specific in it:
a manifest, one `auto` tool, one `gated` tool with a `describe`, a commented-out
source stub, a migration, a `buddi.md` and a test that registers the manifest
through core's own validation. It is what `buddi plugins init` writes, so the
two cannot drift apart.

Two ways in:

```sh
buddi plugins init my-plugin          # writes ./my-plugin, core link resolved
cp -R template my-plugin              # or copy it here, beside finance
```

Publish yours under your own npm name, never `@withbuddi`.

If you copy it, change `name`, `schema` and the tool family together, rename
`migrations/001_template.sql`, rewrite `buddi.md`, and add the directory to
`pnpm-workspace.yaml`. The template is deliberately *not* in the workspace: it
is a stencil, not a plugin anyone should install.

The guide is `docs/plugins.md` in the buddi checkout beside this one —
`../buddi/docs/plugins.md`. Start at its "Start here" chapter for the path from
nothing to a running plugin; §9 is every field of the contract in a table. The
guide lives there rather than here because it is versioned with the contract it
documents, and it travels with `@buddi/core` once that is published.
