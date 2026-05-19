import type { Tool, Resource, ResourceTemplate, Prompt } from "@modelcontextprotocol/sdk/types.js";

// ---------------------------------------------------------------------------
// Upstream configuration
// ---------------------------------------------------------------------------

export interface AllowList {
  /** Allow all tools/resources/prompts from this upstream (overrides explicit lists). */
  allowAll?: boolean;
  allowedTools?: string[];
  allowedResources?: string[];
  allowedPrompts?: string[];
}

interface UpstreamBase extends AllowList {
  /** Unique name for this upstream, used in log messages and default prefix. */
  name: string;
  /**
   * Prefix prepended to every tool/resource/prompt name from this upstream.
   * Defaults to `"<name>__"`. Set to `""` to disable.
   */
  namePrefix?: string;
  /** Set to false to disable this upstream without removing it. Defaults to true. */
  enabled?: boolean;
}

export interface StdioUpstreamConfig extends UpstreamBase {
  transport: "stdio";
  command: string;
  args?: string[];
  /** Extra environment variables passed to the child process. */
  env?: Record<string, string>;
}

export interface SseUpstreamConfig extends UpstreamBase {
  transport: "sse" | "streamable-http";
  /** Full URL of the upstream MCP endpoint */
  url: string;
  /** Extra HTTP headers sent with every request (values may contain ${ENV_VAR} refs). */
  headers?: Record<string, string>;
}

export type UpstreamConfig = StdioUpstreamConfig | SseUpstreamConfig;

// ---------------------------------------------------------------------------
// Hub configuration (top-level config.json)
// ---------------------------------------------------------------------------

export interface HubConfig {
  /** Port the hub HTTP server listens on. Default: 3000. */
  port?: number;
  upstreams: UpstreamConfig[];
}

// ---------------------------------------------------------------------------
// Runtime upstream state
// ---------------------------------------------------------------------------

export type UpstreamStatus = "connecting" | "connected" | "disconnected" | "failed";

export interface UpstreamState {
  config: UpstreamConfig;
  status: UpstreamStatus;
  /** Resolved (prefixed) tool names this upstream exposes after filtering. */
  tools: Tool[];
  resources: Resource[];
  resourceTemplates: ResourceTemplate[];
  prompts: Prompt[];
  /** Timestamp of last successful connection. */
  connectedAt?: Date;
  /** Last error message if status is failed/disconnected. */
  lastError?: string;
}

// ---------------------------------------------------------------------------
// Custom tool definition (for tools defined directly in this project)
// ---------------------------------------------------------------------------

export interface CustomTool {
  definition: Tool;
  handler: (args: Record<string, unknown>) => Promise<{ content: Array<{ type: "text"; text: string }> }>;
}
