import { readFileSync } from "fs";
import { z } from "zod";
import type { HubConfig } from "./types.js";

// ---------------------------------------------------------------------------
// Zod schemas
// ---------------------------------------------------------------------------

const AllowListSchema = z.object({
  allowAll: z.boolean().optional(),
  allowedTools: z.array(z.string()).optional(),
  allowedResources: z.array(z.string()).optional(),
  allowedPrompts: z.array(z.string()).optional(),
});

const StdioUpstreamSchema = AllowListSchema.extend({
  name: z.string().min(1),
  namePrefix: z.string().optional(),
  enabled: z.boolean().optional(),
  transport: z.literal("stdio"),
  command: z.string().min(1),
  args: z.array(z.string()).optional(),
  env: z.record(z.string()).optional(),
});

const SseUpstreamSchema = AllowListSchema.extend({
  name: z.string().min(1),
  namePrefix: z.string().optional(),
  enabled: z.boolean().optional(),
  transport: z.enum(["sse", "streamable-http"]),
  url: z.string().url(),
  headers: z.record(z.string()).optional(),
});

const UpstreamSchema = z.discriminatedUnion("transport", [
  StdioUpstreamSchema,
  SseUpstreamSchema,
]);

const HubConfigSchema = z.object({
  port: z.number().int().min(1).max(65535).optional(),
  upstreams: z.array(UpstreamSchema),
});

// ---------------------------------------------------------------------------
// Env var substitution  —  replaces ${VAR_NAME} with process.env.VAR_NAME
// ---------------------------------------------------------------------------

function substituteEnvVars(value: string): string {
  return value.replace(/\$\{([^}]+)\}/g, (match, varName: string) => {
    const envValue = process.env[varName];
    if (envValue === undefined) {
      throw new Error(`Config references undefined env var: ${varName}`);
    }
    return envValue;
  });
}

function substituteInObject(obj: unknown): unknown {
  if (typeof obj === "string") return substituteEnvVars(obj);
  if (Array.isArray(obj)) return obj.map(substituteInObject);
  if (obj !== null && typeof obj === "object") {
    return Object.fromEntries(
      Object.entries(obj as Record<string, unknown>).map(([k, v]) => [k, substituteInObject(v)])
    );
  }
  return obj;
}

// ---------------------------------------------------------------------------
// Loader
// ---------------------------------------------------------------------------

export function loadConfig(configPath: string): HubConfig {
  let raw: unknown;
  try {
    raw = JSON.parse(readFileSync(configPath, "utf8"));
  } catch (err) {
    throw new Error(`Failed to read config file "${configPath}": ${String(err)}`);
  }

  const substituted = substituteInObject(raw);
  const result = HubConfigSchema.safeParse(substituted);

  if (!result.success) {
    const issues = result.error.issues.map((i) => `  ${i.path.join(".")}: ${i.message}`).join("\n");
    throw new Error(`Invalid config:\n${issues}`);
  }

  return {
    ...result.data,
    upstreams: result.data.upstreams.filter((u) => u.enabled !== false),
  } as HubConfig;
}

// ---------------------------------------------------------------------------
// Helper: resolve namePrefix for an upstream
// ---------------------------------------------------------------------------

export function resolvePrefix(upstreamName: string, namePrefix?: string): string {
  if (namePrefix !== undefined) return namePrefix;
  return `${upstreamName}__`;
}
