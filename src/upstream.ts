import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { SSEClientTransport } from "@modelcontextprotocol/sdk/client/sse.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import type {
  Tool,
  Resource,
  ResourceTemplate,
  Prompt,
  CallToolResult,
  ReadResourceResult,
  GetPromptResult,
} from "@modelcontextprotocol/sdk/types.js";
import { resolvePrefix } from "./config.js";
import { logUpstreamEvent } from "./logger.js";
import type { UpstreamConfig, UpstreamState } from "./types.js";

// ---------------------------------------------------------------------------
// Filtering helpers
// ---------------------------------------------------------------------------

function isAllowed(name: string, allowAll: boolean, allowList?: string[]): boolean {
  if (allowAll) return true;
  return allowList?.includes(name) ?? false;
}

function prefixed(prefix: string, name: string): string {
  return `${prefix}${name}`;
}

function unprefixed(prefix: string, name: string): string {
  if (prefix && name.startsWith(prefix)) return name.slice(prefix.length);
  return name;
}

// ---------------------------------------------------------------------------
// Single upstream connection
// ---------------------------------------------------------------------------

const RECONNECT_DELAYS_MS = [1_000, 3_000, 10_000, 30_000, 60_000];

export class UpstreamConnection {
  readonly state: UpstreamState;
  private client: Client | null = null;
  private reconnectAttempt = 0;
  private stopped = false;

  constructor(config: UpstreamConfig) {
    this.state = {
      config,
      status: "connecting",
      tools: [],
      resources: [],
      resourceTemplates: [],
      prompts: [],
    };
  }

  async connect(): Promise<void> {
    this.stopped = false;
    await this.tryConnect();
  }

  private async tryConnect(): Promise<void> {
    const cfg = this.state.config;
    this.state.status = "connecting";

    let transport;
    try {
      if (cfg.transport === "stdio") {
        transport = new StdioClientTransport({
          command: cfg.command,
          args: cfg.args ?? [],
          env: cfg.env,
        });
      } else if (cfg.transport === "streamable-http") {
        transport = new StreamableHTTPClientTransport(new URL(cfg.url), {
          requestInit: cfg.headers ? { headers: cfg.headers } : undefined,
        });
      } else {
        transport = new SSEClientTransport(new URL(cfg.url), {
          requestInit: cfg.headers ? { headers: cfg.headers } : undefined,
        });
      }

      this.client = new Client({ name: "tars-hub-mcp", version: "0.1.0" }, { capabilities: {} });

      await this.client.connect(transport);
      await this.loadCapabilities();

      this.state.status = "connected";
      this.state.connectedAt = new Date();
      this.state.lastError = undefined;
      this.reconnectAttempt = 0;
      logUpstreamEvent("connected", cfg.name, `${this.state.tools.length} tools, ${this.state.resources.length} resources, ${this.state.prompts.length} prompts`);

      // Watch for close
      this.client.onclose = () => {
        if (!this.stopped) {
          this.state.status = "disconnected";
          logUpstreamEvent("disconnected", cfg.name);
          void this.scheduleReconnect();
        }
      };
    } catch (err) {
      this.state.status = "failed";
      this.state.lastError = String(err);
      logUpstreamEvent("failed", cfg.name, this.state.lastError);
      if (!this.stopped) void this.scheduleReconnect();
    }
  }

  private async scheduleReconnect(): Promise<void> {
    const delayMs =
      RECONNECT_DELAYS_MS[Math.min(this.reconnectAttempt, RECONNECT_DELAYS_MS.length - 1)];
    this.reconnectAttempt++;
    logUpstreamEvent("reconnecting", this.state.config.name, `attempt ${this.reconnectAttempt}, delay ${delayMs}ms`);
    await new Promise((r) => setTimeout(r, delayMs));
    if (!this.stopped) await this.tryConnect();
  }

  async stop(): Promise<void> {
    this.stopped = true;
    if (this.client) {
      try {
        await this.client.close();
      } catch {
        // ignore
      }
      this.client = null;
    }
  }

  // ---------------------------------------------------------------------------
  // Capability loading with filtering + namespacing
  // ---------------------------------------------------------------------------

  private async loadCapabilities(): Promise<void> {
    const cfg = this.state.config;
    const prefix = resolvePrefix(cfg.name, cfg.namePrefix);
    const allowAll = cfg.allowAll ?? false;

    // Tools
    try {
      const { tools } = await this.client!.listTools();
      this.state.tools = tools
        .filter((t) => isAllowed(t.name, allowAll, cfg.allowedTools))
        .map((t) => ({
          name: prefixed(prefix, t.name),
          description: t.description || `${cfg.name} tool: ${t.name}`,
          inputSchema: t.inputSchema,
          ...(t.annotations ? { annotations: t.annotations } : {}),
        }));
    } catch {
      this.state.tools = [];
    }

    // Resources
    try {
      const { resources } = await this.client!.listResources();
      this.state.resources = resources
        .filter((r) => isAllowed(r.name, allowAll, cfg.allowedResources))
        .map((r) => ({
          uri: prefixed(prefix, r.uri),
          name: prefixed(prefix, r.name),
          ...(r.description ? { description: r.description } : {}),
          ...(r.mimeType ? { mimeType: r.mimeType } : {}),
        }));
    } catch {
      this.state.resources = [];
    }

    // Resource templates
    try {
      const { resourceTemplates } = await this.client!.listResourceTemplates();
      this.state.resourceTemplates = resourceTemplates
        .filter((rt) => isAllowed(rt.name, allowAll, cfg.allowedResources))
        .map((rt) => ({
          uriTemplate: prefixed(prefix, rt.uriTemplate),
          name: prefixed(prefix, rt.name),
          ...(rt.description ? { description: rt.description } : {}),
          ...(rt.mimeType ? { mimeType: rt.mimeType } : {}),
        }));
    } catch {
      this.state.resourceTemplates = [];
    }

    // Prompts
    try {
      const { prompts } = await this.client!.listPrompts();
      this.state.prompts = prompts
        .filter((p) => isAllowed(p.name, allowAll, cfg.allowedPrompts))
        .map((p) => ({
          name: prefixed(prefix, p.name),
          ...(p.description ? { description: p.description } : {}),
          ...(p.arguments ? { arguments: p.arguments } : {}),
        }));
    } catch {
      this.state.prompts = [];
    }
  }

  // ---------------------------------------------------------------------------
  // Proxying calls
  // ---------------------------------------------------------------------------

  async callTool(prefixedName: string, args: Record<string, unknown>): Promise<CallToolResult> {
    if (!this.client || this.state.status !== "connected") {
      throw new Error(`Upstream "${this.state.config.name}" is not connected`);
    }
    const prefix = resolvePrefix(this.state.config.name, this.state.config.namePrefix);
    const originalName = unprefixed(prefix, prefixedName);
    return this.client.callTool({ name: originalName, arguments: args }) as Promise<CallToolResult>;
  }

  async readResource(prefixedUri: string): Promise<ReadResourceResult> {
    if (!this.client || this.state.status !== "connected") {
      throw new Error(`Upstream "${this.state.config.name}" is not connected`);
    }
    const prefix = resolvePrefix(this.state.config.name, this.state.config.namePrefix);
    const originalUri = unprefixed(prefix, prefixedUri);
    return this.client.readResource({ uri: originalUri });
  }

  async getPrompt(prefixedName: string, args?: Record<string, string>): Promise<GetPromptResult> {
    if (!this.client || this.state.status !== "connected") {
      throw new Error(`Upstream "${this.state.config.name}" is not connected`);
    }
    const prefix = resolvePrefix(this.state.config.name, this.state.config.namePrefix);
    const originalName = unprefixed(prefix, prefixedName);
    return this.client.getPrompt({ name: originalName, arguments: args });
  }
}

// ---------------------------------------------------------------------------
// Pool of upstream connections
// ---------------------------------------------------------------------------

export class UpstreamPool {
  private connections: UpstreamConnection[] = [];

  constructor(configs: UpstreamConfig[]) {
    this.connections = configs.map((c) => new UpstreamConnection(c));
  }

  async connectAll(): Promise<void> {
    await Promise.allSettled(this.connections.map((c) => c.connect()));
  }

  async stopAll(): Promise<void> {
    await Promise.allSettled(this.connections.map((c) => c.stop()));
  }

  // Merged views of all connected upstreams
  get tools(): Tool[] {
    return this.connections.flatMap((c) => c.state.tools);
  }

  get resources(): Resource[] {
    return this.connections.flatMap((c) => c.state.resources);
  }

  get resourceTemplates(): ResourceTemplate[] {
    return this.connections.flatMap((c) => c.state.resourceTemplates);
  }

  get prompts(): Prompt[] {
    return this.connections.flatMap((c) => c.state.prompts);
  }

  get states(): UpstreamState[] {
    return this.connections.map((c) => c.state);
  }

  /** Find the upstream that owns a prefixed tool name. */
  findForTool(name: string): UpstreamConnection | undefined {
    return this.connections.find((c) => c.state.tools.some((t) => t.name === name));
  }

  findForResource(uri: string): UpstreamConnection | undefined {
    return this.connections.find(
      (c) =>
        c.state.resources.some((r) => r.uri === uri) ||
        c.state.resourceTemplates.some((rt) => uri.startsWith(rt.uriTemplate.split("{")[0]))
    );
  }

  findForPrompt(name: string): UpstreamConnection | undefined {
    return this.connections.find((c) => c.state.prompts.some((p) => p.name === name));
  }
}
