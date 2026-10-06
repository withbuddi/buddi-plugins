# For coding agents

Read `../buddi-planning/HANDBOOK.md` first: repositories, the two buddi
instances on this Mac, the dev loop, tests, reviews, releases and the
standing rules. Then `../buddi-planning/ROADMAP.md` for what is next.

## This repo
- `pnpm -r build`, `pnpm test`. Try a plugin on dev from its folder: `buddi-dev plugins install ./ && buddi-dev plugins approve <id>`, then `buddi-dev service restart`.
- Public: nothing personal in fixtures or examples. No ML runtime inside a plugin; use the host engine (`uses: ["onnx"]`).
- Publish only when Amen says so: bump version, push main, then tag `<plugin>@<version>` in a separate command; then the market entry.
