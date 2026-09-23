# Plan: Modular Tool Groups as npm Workspace Packages

## Context

Built-in tool groups (Google Calendar/Gmail/Sheets, Health, PortTracker) are currently hard-coded into `src/tools/index.ts` and always loaded. Different deployments of the hub need different tools — a home server might want Health+PortTracker but not Google tools, a work machine the reverse. The goal is to make tool groups independently installable packages so each deployment only ships the code and dependencies it actually uses.

## Approach: npm Workspaces Monorepo + Dynamic Import

Convert the repo to an **npm workspaces monorepo**. Each tool group becomes a workspace package under `packages/`. The hub reads a `tools` array from `config.json` containing package names and dynamically imports them at startup. No code change needed to add or remove a tool group — just edit `config.json` (and optionally `npm install`/uninstall the package).

---

## Folder Structure (after)

```
packages/
  types/                        # canonical CustomTool interface
    package.json                # name: @tars-hub/types
    src/index.ts                # re-exports CustomTool, delegates Tool from @mcp/sdk
  tools-google/                 # Calendar + Gmail + Sheets + OAuth
    package.json                # name: @tars-hub/tools-google, deps: googleapis, google-auth-library
    tsconfig.json
    src/
      index.ts                  # export const tools: CustomTool[]
      google-oauth.ts           # moved from src/tools/
      google-calendar.ts        # moved from src/tools/
      google-gmail.ts           # moved from src/tools/
      google-sheets.ts          # moved from src/tools/
  tools-health/                 # Health (InfluxDB fetch)
    package.json                # name: @tars-hub/tools-health, no external deps
    tsconfig.json
    src/
      index.ts                  # export const tools: CustomTool[]
      health.ts                 # moved from src/tools/
  tools-portracker/             # PortTracker (fetch-based)
    package.json                # name: @tars-hub/tools-portracker, no external deps
    tsconfig.json
    src/
      index.ts                  # export const tools: CustomTool[]
      portracker.ts             # moved from src/tools/
src/
  tools/
    index.ts                    # replaced: async buildCustomTools(pkgNames?)
    hub-status.ts               # stays (uses UpstreamPool — internal)
    hub-logs.ts                 # stays (uses logger — internal)
  types.ts                      # add tools?: string[] to HubConfig
  config.ts                     # add tools?: string[] to Zod schema
  index.ts                      # await buildCustomTools(config.tools)
package.json                    # add "workspaces": ["packages/*"]
```

---

## Package Contracts

### `packages/types/src/index.ts`
```ts
export type { Tool } from "@modelcontextprotocol/sdk/types.js";

export interface CustomTool {
  definition: Tool;
  handler: (args: Record<string, unknown>) => Promise<{
    content: Array<{ type: "text"; text: string }>;
  }>;
}
```

### Each tool package `src/index.ts`
```ts
// e.g. packages/tools-health/src/index.ts
import type { CustomTool } from "@tars-hub/types";
import { healthTools } from "./health.js";

export const tools: CustomTool[] = healthTools;
```

### Each tool package `package.json`
```json
{
  "name": "@tars-hub/tools-health",
  "version": "0.1.0",
  "type": "module",
  "exports": { ".": { "import": "./dist/index.js" } },
  "dependencies": { "@tars-hub/types": "*" },
  "devDependencies": { "typescript": "*" }
}
```

---

## Hub Changes

### `package.json`
Add `"workspaces": ["packages/*"]` so npm links all packages locally.

### `src/tools/index.ts` (replace static array)
```ts
import type { CustomTool } from "@tars-hub/types";

const currentTimeTool: CustomTool = { /* unchanged */ };

const DEFAULT_TOOLS = [
  "@tars-hub/tools-google",
  "@tars-hub/tools-health",
  "@tars-hub/tools-portracker",
];

export async function buildCustomTools(pkgNames?: string[] | null): Promise<CustomTool[]> {
  const names = pkgNames ?? DEFAULT_TOOLS;
  const all: CustomTool[] = [currentTimeTool];
  for (const pkg of names) {
    try {
      const mod = await import(pkg);
      all.push(...(mod.tools ?? []));
    } catch (err) {
      console.warn(`[tars-hub] Failed to load tool package "${pkg}": ${err}`);
    }
  }
  return all;
}
```

### `src/index.ts`
```ts
import { buildCustomTools } from "./tools/index.js";
// ...
const customTools = await buildCustomTools(config.tools);
const app = createHubServer(config, pool, customTools);
```

### `src/config.ts`
Add to `HubConfigSchema`:
```ts
tools: z.array(z.string()).nullable().optional(),
```

### `src/types.ts`
Add to `HubConfig`:
```ts
tools?: string[] | null;
```

---

## config.json Usage

```json
{
  "port": 3000,
  "tools": ["@tars-hub/tools-google", "@tars-hub/tools-health"],
  "upstreams": [...]
}
```

Omit `tools` entirely → all default packages load (backward compatible).

---

## Build Changes

Each package needs its own `tsconfig.json` (extending root) and a build step. Add to root `package.json` scripts:
```json
"build:packages": "npm run build --workspaces --if-present",
"build": "npm run build:packages && tsc"
```

Each package tsconfig:
```json
{
  "extends": "../../tsconfig.json",
  "compilerOptions": {
    "rootDir": "src",
    "outDir": "dist"
  },
  "include": ["src"]
}
```

---

## Files Modified / Created

| File | Action |
|---|---|
| `package.json` | Add `"workspaces"` |
| `src/config.ts` | Add `tools` field to Zod schema |
| `src/types.ts` | Add `tools` field to `HubConfig` |
| `src/tools/index.ts` | Replace static export with async `buildCustomTools()` |
| `src/index.ts` | Await `buildCustomTools(config.tools)` |
| `packages/types/` | New package — canonical `CustomTool` type |
| `packages/tools-google/` | New package — move 4 files from `src/tools/` |
| `packages/tools-health/` | New package — move `src/tools/health.ts` |
| `packages/tools-portracker/` | New package — move `src/tools/portracker.ts` |
| `src/tools/google-*.ts` | Deleted (moved to packages) |
| `src/tools/health.ts` | Deleted (moved to package) |
| `src/tools/portracker.ts` | Deleted (moved to package) |

---

## Verification

1. `npm install` — links workspace packages
2. `npm run build` — builds packages first, then hub
3. `npm run typecheck` — no errors across all packages
4. Run hub with full `config.json` (all tools) — all tools available
5. Run hub with `"tools": ["@tars-hub/tools-health"]` — only health tools exposed
6. Run hub with `"tools": []` — only `hub__current_time` tool available
7. Remove `@tars-hub/tools-google` from hub's dependencies → warn on startup, gracefully skipped
