# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Commands

```bash
npm run build       # compile TypeScript → dist/
npm run dev         # run from source (tsx, no build needed)
npm start           # run compiled output
npm run typecheck   # type-check without emitting
```

No test suite. Type-check is the main correctness gate.

## Environment note

This project runs inside a Docker container. `npm`, `npx`, and `node` are not available in the host shell — do not attempt to run them via Bash. To build, typecheck, or restart the server, ask the user to run the commands inside the container.

## Architecture

`tars-hub-mcp` is an MCP aggregation hub. It connects to multiple **upstream MCP servers** (via stdio, SSE, or Streamable HTTP) and re-exposes their tools, resources, and prompts through a single unified MCP endpoint — with namespacing, allowlisting, logging, and optional bearer-token auth.

### Data flow

1. **`src/index.ts`** — entry point. Loads `config.json`, creates an `UpstreamPool`, starts the Express HTTP server, then triggers upstream connections in the background.
2. **`src/upstream.ts`** — `UpstreamConnection` manages a single upstream: connects via the appropriate transport, loads capabilities (with prefix/filter applied), and proxies calls. `UpstreamPool` aggregates all connections and provides merged capability views + lookup helpers.
3. **`src/server.ts`** — Express app with two MCP server-side transports:
   - `POST /mcp` — Streamable HTTP (MCP 2025-11-25), session-tracked via `mcp-session-id` header
   - `GET /sse` + `POST /message` — legacy SSE transport
   - Each inbound connection gets its own `Server` instance (built by `buildMcpServer`) wired to the current pool state.
4. **`src/config.ts`** — reads `config.json`, validates with Zod, substitutes `${ENV_VAR}` references, filters disabled upstreams. `resolvePrefix()` derives the tool-name prefix (`<name>__` by default, configurable via `namePrefix`).
5. **`src/tools/`** — custom tools implemented directly in TypeScript (not proxied from an upstream). Exported from `index.ts` as `customTools: CustomTool[]`. Built-in tool groups: `google-calendar`, `google-gmail`, `google-sheets`, `health` (InfluxDB), `portracker`, `hub-status`, `hub-logs`. The `hub-status` and `hub-logs` tools are injected at connection time in `server.ts`, not exported from `index.ts`.

### Namespacing

Every upstream's tools/resources/prompts are prefixed (default: `<name>__`, e.g. `github__search_code`). The prefix is stripped before forwarding calls back to the upstream. Set `namePrefix: ""` to disable.

### Allowlisting

Per upstream: `allowAll: true` lets everything through; otherwise use `allowedTools`, `allowedResources`, `allowedPrompts` with exact (pre-prefix) names. Tools not in the allowlist are blocked and logged as `tool_blocked`.

### Custom tools

Implement `CustomTool` (from `src/types.ts`) and add to the array in `src/tools/index.ts`. The interface requires a `definition` (MCP `Tool` schema) and an async `handler`. Rebuild after changes.

### Google OAuth

Gmail, Calendar, and Sheets tools share a single OAuth credential at `~/.google-oauth/credentials.json`. The hub loads this automatically — no stdio upstream needed for these services. See `src/tools/google-oauth.ts` for the auth helper.

### Environment

Configure via `.env` (copy from `env.example`). Key variables:
- `HUB_API_KEY` — bearer token for client auth (unset = unauthenticated)
- `HUB_CONFIG` — path to config file (default: `./config.json`)
- `LOG_LEVEL` — `trace|debug|info|warn|error` (default: `info`; `debug` also logs tool args)
- `NODE_ENV=production` — switches to JSON log output
