# Shared skills

Skills that belong to no plugin. A skill is a procedure, never a privilege:
installing one grants no tool and lowers no tier (`packages/core/src/agents/skills.ts`
in the buddi checkout enforces that — a `tools` or `tier` key fails the load).

None ship here yet; the format and the install steps below are what one needs.

## The file format the loader expects

One flat markdown file per skill, `skills/<name>.md`, with YAML frontmatter
whose `name` equals the file name, a one-line `description`, and optionally
`provenance`, `source`, `created` and `agents`. The frontmatter is strict: an
unknown key fails the load, so there is no `argument-hint` here (that is a
Claude Code skill's field, not buddi's) and a skill directory holding a
`SKILL.md` is not discovered — the loader reads `*.md` in the skills directory
itself.

## Installing one

Shared skills are auto-discovered from the installation's shared skills
directory, `<data>/skills/` (`BUDDI_SKILLS_DIR`). With no `agents` key a shared
skill loads for every agent; with one, only for the agents it names. Copy it
there:

```sh
cp skills/<name>.md "$BUDDI_SKILLS_DIR/"
```

To give it to one agent only, either add an `agents:` line to the frontmatter,
or drop the file into that agent's own directory instead, where it is always
loaded:

```sh
cp skills/<name>.md "$BUDDI_AGENTS_DIR/<agent-id>/skills/"
```

`BUDDI_DATA_DIR` is the installation's data directory, with `agents/` and
`skills/` inside it; `buddi doctor` reports where that is. No path is assumed
here. Nothing needs building and nothing needs a plugin: these files are
read at agent load, so a restart is enough.
