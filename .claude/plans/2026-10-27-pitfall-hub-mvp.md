# pitfall-hub MVP

Goal: one local knowledge base of pitfalls that every agent on this machine can write to and query, across projects.

## Decisions
- Scope: personal, cross-project. Single SQLite file at `~/.pitfall-hub/pitfalls.db` (override with `PITFALL_HUB_DB`).
- Storage: built-in `node:sqlite` (no native build), FTS5 `trigram` tokenizer so CJK substrings are searchable.
  CJK runs are split into overlapping 3-grams and OR-ed; terms shorter than 3 chars fall back to LIKE.
- Dedup: `record` refuses when an active entry has the same normalized title or error signature (paths/numbers stripped),
  and returns the existing one so the agent updates it instead. `force` overrides.
- Relevance for hooks: tags detected from the project (package.json deps, pyproject, Cargo, go.mod, Dockerfile, WSL)
  matched against entry tags.

## Surfaces
1. Core `PitfallStore` (src/core)
2. MCP stdio server: search / get / record / update / feedback / list_tags
3. Web UI: Hono JSON API + React 19 + Tailwind v4 SPA (built into dist/web, served by `pitfall serve`)
4. CLI: search, show, add, export, import, stats, serve, mcp, hook, install/uninstall
5. Claude Code integration (`pitfall install`): user-scope MCP registration, skill, SessionStart hook

## Out of scope (later)
- Team/server mode with auth, embeddings/semantic search, auto-capture of failures without agent judgement.

## Revision: Docker deployment (same day)
- Runs in Docker (`docker-compose.yml`, conventions copied from scriptwright: ports only in the override file,
  prod example under `docker/` pulling a prebuilt image behind Traefik).
- The agent workspace is itself a fail-closed container behind Mihomo, so sibling containers are not reachable
  over the network. Locally, agents reach pitfall-hub through `docker exec`:
  MCP = `docker exec -i pitfall-hub pitfall mcp`, hooks = local fingerprint + `docker exec … pitfall rpc`.
- Online: `/mcp` (Streamable HTTP) + `/api/*` behind bearer tokens (`PITFALL_HUB_TOKEN`); refuses to listen on a
  non-loopback address without one. Agents switch with `pitfall install --url https://… --token …`.
