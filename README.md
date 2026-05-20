# mcp-hub

Plug-and-play MCP gateway — connect any MCP server, expose unified tools to your AI assistant.

## What it does

- **Aggregates** multiple upstream MCP servers (stdio, SSE, or Streamable HTTP) into one endpoint
- **Gates** — only the tools/resources/prompts you explicitly allow are exposed to clients
- **Logs** every tool call with client IP, upstream, duration, and request/response byte sizes
- **Custom tools** — built-in tools for Gmail, Google Calendar, health metrics, hub status/logs
- **Resilient** — failed upstreams are skipped and retried automatically in the background
- **Health endpoint** — `GET /health` shows upstream connection states and tool counts
- **Bearer token auth** — optional `HUB_API_KEY` to restrict access

## Quick start

```bash
cp config.example.json config.json    # edit to your upstreams
cp env.example .env                   # fill in secrets
npm install
npm run build
npm start
```

Configure VS Code / Claude Desktop to connect to `http://localhost:3000/sse`.

## Configuration (`config.json`)

```json
{
  "port": 3000,
  "upstreams": [
    {
      "name": "slack",
      "transport": "stdio",
      "command": "npx",
      "args": ["-y", "@modelcontextprotocol/server-slack"],
      "env": {
        "SLACK_BOT_TOKEN": "${SLACK_BOT_TOKEN}",
        "SLACK_TEAM_ID": "${SLACK_TEAM_ID}"
      },
      "namePrefix": "slack__",
      "allowAll": true
    },
    {
      "name": "github",
      "transport": "streamable-http",
      "url": "https://api.githubcopilot.com/mcp/",
      "headers": { "Authorization": "Bearer ${GITHUB_PERSONAL_ACCESS_TOKEN}" },
      "namePrefix": "github__",
      "allowAll": true
    }
  ]
}
```

### Upstream options

| Field | Required | Description |
|---|---|---|
| `name` | ✅ | Unique name, used in logs and as default prefix |
| `transport` | ✅ | `"stdio"`, `"sse"`, or `"streamable-http"` |
| `command` | stdio only | Command to spawn |
| `args` | stdio only | Arguments to command |
| `env` | stdio only | Extra env vars for child process |
| `url` | sse/streamable-http | Full URL of upstream endpoint |
| `headers` | sse/streamable-http | Extra HTTP headers (supports `${ENV_VAR}`) |
| `namePrefix` | | Prefix for tool names (default: `"<name>__"`) |
| `allowAll` | | `true` to allow all tools/resources/prompts |
| `allowedTools` | | Explicit list of allowed tool names |
| `allowedResources` | | Explicit list of allowed resource names |
| `allowedPrompts` | | Explicit list of allowed prompt names |
| `enabled` | | Set to `false` to disable without removing |

Values containing `${VAR_NAME}` are substituted from environment variables at startup.

## Environment variables

| Variable | Description |
|---|---|
| `HUB_API_KEY` | Bearer token clients must send. Unset = no auth (warns on startup) |
| `HUB_CONFIG` | Path to config file (default: `./config.json`) |
| `LOG_LEVEL` | `trace` \| `debug` \| `info` \| `warn` \| `error` (default: `info`) |
| `NODE_ENV` | `production` for JSON logs; any other value → pretty-printed |

> **Tip:** Set `LOG_LEVEL=debug` to also log tool call arguments. Avoid in production — sensitive data may appear in logs.

## Logging

Pretty-printed in dev:
```
[10:23:11] INFO  tool_call     slack__list_channels  ← 192.168.1.5  42ms ✓  [24b → 3841b]
[10:23:19] WARN  tool_blocked  slack__delete_channel ← 192.168.1.5  not in allowlist or not found
```

JSON in production (pipe through `pino-pretty` for human viewing):
```bash
node dist/index.js | npx pino-pretty
```

## Built-in custom tools

The hub includes built-in tools implemented directly in TypeScript:

| Tool prefix | Description |
|---|---|
| `gmail__` | List messages, get full email body, create draft emails (plain text or HTML) |
| `google_calendar__` | List, create, update, delete calendar events |
| `gsheets__` | Read/write spreadsheet values, append rows, clear ranges |
| `hub__` | Hub status, upstream health, log viewer |
| `health__` | Heart rate, steps, sleep metrics (via InfluxDB) |

These require Google OAuth credentials — see [Google services setup](#google-services-gmail--calendar) below.

## Adding custom tools

Edit `src/tools/index.ts`:

```typescript
import type { CustomTool } from "../types.js";

const myTool: CustomTool = {
  definition: {
    name: "hub__my_tool",
    description: "Does something useful",
    inputSchema: {
      type: "object",
      properties: { input: { type: "string" } },
      required: ["input"],
    },
  },
  handler: async ({ input }) => ({
    content: [{ type: "text", text: `Result: ${input}` }],
  }),
};

export const customTools: CustomTool[] = [myTool];
```

Rebuild with `npm run build`.

## Connecting clients

### VS Code (`.vscode/mcp.json`)
```json
{
  "servers": {
    "mcp-hub": {
      "type": "sse",
      "url": "http://localhost:3000/sse",
      "headers": { "Authorization": "Bearer your-api-key" }
    }
  }
}
```

### Claude Desktop
Add to your `claude_desktop_config.json`:
```json
{
  "mcpServers": {
    "mcp-hub": {
      "url": "http://localhost:3000/sse"
    }
  }
}
```

## Service-specific setup

### Google services (Gmail, Calendar & Sheets)

Gmail, Calendar, and Sheets tools are built into the hub and share a single set of OAuth2 credentials stored in `~/.google-oauth/`.

**1. Create a Google Cloud project & OAuth credentials**

1. Go to [Google Cloud Console](https://console.cloud.google.com/) and create a project
2. Enable the **Gmail API**, **Google Calendar API**, and **Google Sheets API**
3. Go to **APIs & Services → Credentials → Create Credentials → OAuth client ID**
4. Choose **Desktop app**, download the JSON, rename it `gcp-oauth.keys.json`

**2. Authenticate (once)**

```bash
mkdir -p ~/.google-oauth
cp gcp-oauth.keys.json ~/.google-oauth/
npx @gongrzhe/server-gmail-autoauth-mcp auth
```

> The auth command opens a browser, asks you to sign in, and saves `credentials.json` in `~/.google-oauth/`. The hub loads it automatically on startup — no further interaction needed.
>
> Make sure your OAuth consent screen includes all required scopes: Gmail, Calendar, and Sheets.

---

### GitHub

Uses the hosted GitHub MCP server via Streamable HTTP. Requires a GitHub Personal Access Token with `repo` and `read:org` scopes.

```env
GITHUB_PERSONAL_ACCESS_TOKEN=your_pat_here
```

---

### Home Assistant

**1. Generate a Long-Lived Access Token**

In Home Assistant: **Profile → Long-Lived Access Tokens → Create Token**.

**2. Set env vars**

```env
HASS_HOST=http://homeassistant.local:8123
HASS_TOKEN=your_long_lived_access_token
```

Set `"enabled": true` on the `home-assistant` upstream in `config.json` to activate it.

---

## Docker

```bash
cp config.example.json config.json   # edit to your upstreams
cp env.example .env                  # fill in secrets

docker compose up -d
```

The `docker-compose.yml` mounts `config.json` read-only and persists the npm cache so stdio upstreams (launched via `npx`) don't re-download on every restart.

> **Note on stdio upstreams in Docker:** paths in `args` refer to paths *inside* the container. Mount host directories as volumes if needed.


## What it does

- **Aggregates** multiple upstream MCP servers (stdio or HTTP/SSE) into one endpoint
- **Gates** — only the tools/resources/prompts you explicitly allow are exposed to clients
- **Logs** every tool call with client IP, upstream, duration, and request/response byte sizes
- **Custom tools** — add your own tools directly in TypeScript (`src/tools/index.ts`)
- **Resilient** — failed upstreams are skipped and retried automatically in the background
- **Health endpoint** — `GET /health` shows upstream connection states and tool counts
- **Bearer token auth** — optional `HUB_API_KEY` to restrict access

## Quick start

```bash
cp config.example.json config.json    # edit to your upstreams
cp env.example .env                   # fill in secrets
npm install
npm run build
npm start
```

Configure VS Code / OpenClaw / Claude Desktop to connect to `http://localhost:3000/sse`.

## Configuration (`config.json`)

```json
{
  "port": 3000,
  "upstreams": [
    {
      "name": "gmail",
      "transport": "stdio",
      "command": "npx",
      "args": ["-y", "@gongrzhe/server-gmail-autoauth-mcp"],
      "namePrefix": "gmail__",
      "allowedTools": ["search_emails", "send_email", "draft_email"]
    },
    {
      "name": "github",
      "transport": "sse",
      "url": "${GITHUB_MCP_URL}",
      "headers": { "Authorization": "Bearer ${GITHUB_MCP_TOKEN}" },
      "namePrefix": "github__",
      "allowedTools": ["create_issue", "search_code"]
    }
  ]
}
```

### Upstream options

| Field | Required | Description |
|---|---|---|
| `name` | ✅ | Unique name, used in logs and as default prefix |
| `transport` | ✅ | `"stdio"` or `"sse"` |
| `command` | stdio only | Command to spawn |
| `args` | stdio only | Arguments to command |
| `env` | stdio only | Extra env vars for child process |
| `url` | sse only | Full URL of upstream SSE endpoint |
| `headers` | sse only | Extra HTTP headers (supports `${ENV_VAR}`) |
| `namePrefix` | | Prefix for tool names (default: `"<name>__"`) |
| `allowAll` | | `true` to allow all tools/resources/prompts |
| `allowedTools` | | List of allowed tool names |
| `allowedResources` | | List of allowed resource names |
| `allowedPrompts` | | List of allowed prompt names |

Values containing `${VAR_NAME}` are substituted from environment variables at startup.

## Environment variables

| Variable | Description |
|---|---|
| `HUB_API_KEY` | Bearer token clients must send. Unset = no auth (warns on startup) |
| `HUB_CONFIG` | Path to config file (default: `./config.json`) |
| `LOG_LEVEL` | `trace` \| `debug` \| `info` \| `warn` \| `error` (default: `info`) |
| `NODE_ENV` | `production` for JSON logs; any other value → pretty-printed |

> **Tip:** Set `LOG_LEVEL=debug` to also log tool call arguments. Avoid in production — email contents may appear in logs.

## Logging

Pretty-printed in dev:
```
[10:23:11] INFO  tool_call     gmail__list_messages  ← 192.168.1.5  42ms ✓  [24b → 3841b]
[10:23:14] INFO  tool_call     gmail__create_draft   ← 192.168.1.5  91ms ✓  [312b → 88b]
[10:23:19] WARN  tool_blocked  gmail__send_message   ← 192.168.1.5  not in allowlist or not found
```

JSON in production (pipe through `pino-pretty` for human viewing):
```bash
node dist/index.js | npx pino-pretty
```

## Adding custom tools

Edit `src/tools/index.ts`:

```typescript
import type { CustomTool } from "../types.js";

const myTool: CustomTool = {
  definition: {
    name: "hub__my_tool",
    description: "Does something useful",
    inputSchema: {
      type: "object",
      properties: { input: { type: "string" } },
      required: ["input"],
    },
  },
  handler: async ({ input }) => ({
    content: [{ type: "text", text: `Result: ${input}` }],
  }),
};

export const customTools: CustomTool[] = [myTool];
```

Rebuild with `npm run build`.

## Connecting clients

### VS Code (`.vscode/mcp.json`)
```json
{
  "servers": {
    "tars-hub": {
      "type": "sse",
      "url": "http://localhost:3000/sse",
      "headers": { "Authorization": "Bearer your-api-key" }
    }
  }
}
```

### OpenClaw
```bash
openclaw mcp set tars-hub --url http://localhost:3000/sse --header "Authorization: Bearer your-api-key"
```

## Service-specific setup

### Google services (Gmail, Calendar, Tasks)

These upstreams use OAuth2 with credentials stored on disk. You need to do a **one-time auth** per service before starting the hub.

**1. Create a Google Cloud project & OAuth credentials**

1. Go to [Google Cloud Console](https://console.cloud.google.com/) and create a project (or select an existing one)
2. Enable the APIs you need: **Gmail API**, **Google Calendar API**, **Tasks API**
3. Go to **APIs & Services → Credentials → Create Credentials → OAuth client ID**
4. Choose **Desktop app**, download the JSON, rename it `gcp-oauth.keys.json`

**2. Authenticate each service (once)**

```bash
# Gmail
mkdir -p ~/.gmail-mcp && cp gcp-oauth.keys.json ~/.gmail-mcp/
npx @gongrzhe/server-gmail-autoauth-mcp auth

# Google Calendar
mkdir -p ~/.calendar-mcp && cp gcp-oauth.keys.json ~/.calendar-mcp/
volta run --node 20 npx --yes @gongrzhe/server-calendar-autoauth-mcp auth

# Google Tasks
npx @scottie-will/google-tasks-mcp auth
```

Each command opens a browser, asks you to sign in, and saves `credentials.json` in the service's config folder. After that the hub starts the servers automatically — no further interaction needed.

**Tools exposed (prefix shown)**

| Service | Prefix | Example tools |
|---|---|---|
| Gmail | `gmail__` | `gmail__search_emails`, `gmail__send_email`, `gmail__list_email_labels` |
| Calendar | `google_calendar__` | `google_calendar__list_events`, `google_calendar__create_event` |
| Tasks | `google_tasks__` | `google_tasks__list_tasks`, `google_tasks__create_task` |

> **Note:** `read_email` (full body) is intentionally excluded from the Gmail allowlist. Use the custom `gmail__list_messages_summary` tool to browse your inbox — it returns only sender and subject.

---

### Home Assistant

**1. Generate a Long-Lived Access Token**

In Home Assistant: **Profile → Long-Lived Access Tokens → Create Token**. Copy the token — it's only shown once.

**2. Set env vars**

```env
HASS_HOST=http://homeassistant.local:8123
HASS_TOKEN=your_long_lived_access_token
```

That's it. The hub connects automatically on start.

**Tools exposed (prefix `hass__`)**

Examples of what you can do:

- `hass__get_entities` — list all entities (lights, sensors, switches, …)
- `hass__control_device` — turn lights on/off, set brightness/color, lock doors, …
- `hass__get_history` — sensor readings over a time range
- `hass__trigger_automation` — fire an automation
- `hass__activate_scene` — activate a scene ("movie mode", "goodnight", …)
- `hass__send_notification` — push a notification through HA
- `hass__get_states` — snapshot of all current entity states

---

## Docker

```bash
cp config.example.json config.json   # edit to your upstreams
cp env.example .env                  # fill in HUB_API_KEY and upstream secrets

docker compose up -d
```

The `docker-compose.yml` mounts `config.json` read-only and persists the npm cache so stdio upstreams (launched via `npx`) don't re-download on every restart.

> **Note on stdio upstreams in Docker:** paths in `args` (e.g. `/tmp`) refer to paths *inside* the container. Mount host directories as volumes if your upstream needs access to host files.
