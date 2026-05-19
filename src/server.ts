import express from "express";
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { SSEServerTransport } from "@modelcontextprotocol/sdk/server/sse.js";
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
  ListResourcesRequestSchema,
  ReadResourceRequestSchema,
  ListPromptsRequestSchema,
  GetPromptRequestSchema,
  ListResourceTemplatesRequestSchema,
} from "@modelcontextprotocol/sdk/types.js";
import type { HubConfig } from "./types.js";
import type { UpstreamPool } from "./upstream.js";
import type { CustomTool } from "./types.js";
import {
  logger,
  logToolCall,
  logToolBlocked,
  logAuthFailure,
} from "./logger.js";
import { createHubStatusTool } from "./tools/hub-status.js";
import { hubLogsTool } from "./tools/hub-logs.js";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function byteSize(value: unknown): number {
  return Buffer.byteLength(JSON.stringify(value) ?? "");
}

function clientIp(req: express.Request): string {
  return (
    (req.headers["x-forwarded-for"] as string | undefined)?.split(",")[0].trim() ??
    req.socket.remoteAddress ??
    "unknown"
  );
}

// ---------------------------------------------------------------------------
// Hub server factory
// ---------------------------------------------------------------------------

export function createHubServer(
  config: HubConfig,
  pool: UpstreamPool,
  customTools: CustomTool[]
): express.Application {
  const app = express();
  app.use(express.json());

  // -------------------------------------------------------------------------
  // Optional bearer-token auth middleware
  // -------------------------------------------------------------------------

  const apiKey = process.env.HUB_API_KEY;
  if (!apiKey) {
    logger.warn("HUB_API_KEY is not set — hub is unauthenticated (any client can connect)");
  }

  function authMiddleware(
    req: express.Request,
    res: express.Response,
    next: express.NextFunction
  ): void {
    if (!apiKey) {
      next();
      return;
    }
    const auth = req.headers.authorization ?? "";
    const token = auth.startsWith("Bearer ") ? auth.slice(7) : "";
    if (token !== apiKey) {
      logAuthFailure(clientIp(req));
      res.status(401).json({ error: "Unauthorized" });
      return;
    }
    next();
  }

  // -------------------------------------------------------------------------
  // Health endpoint (no auth required)
  // -------------------------------------------------------------------------

  app.get("/health", (_req, res) => {
    const upstreams = pool.states.map((s) => ({
      name: s.config.name,
      status: s.status,
      tools: s.tools.length,
      resources: s.resources.length,
      prompts: s.prompts.length,
      connectedAt: s.connectedAt?.toISOString(),
      lastError: s.lastError,
    }));
    res.json({
      status: "ok",
      upstreams,
      totalTools: pool.tools.length + customTools.length,
    });
  });

  // -------------------------------------------------------------------------
  // MCP SSE endpoint — one MCP Server instance per SSE connection
  // -------------------------------------------------------------------------

  // Session registry: sessionId → transport (populated as SSE connections arrive)
  const sessions = new Map<string, SSEServerTransport>();

  // MCP message POST endpoint — routes to the correct SSE session transport
  app.post("/message", authMiddleware, async (req, res) => {
    const sessionId = req.query["sessionId"] as string | undefined;
    if (!sessionId) {
      res.status(400).json({ error: "Missing sessionId" });
      return;
    }
    const transport = sessions.get(sessionId);
    if (!transport) {
      res.status(404).json({ error: `No active session: ${sessionId}` });
      return;
    }
    await transport.handlePostMessage(req, res, req.body);
  });

  app.get("/sse", authMiddleware, (req, res) => {
    const ip = clientIp(req);
    logger.info({ event: "client_connected", clientIp: ip }, `client_connected  ← ${ip}`);

    const mcpServer = buildMcpServer(pool, [...customTools, createHubStatusTool(pool), hubLogsTool], ip);
    const transport = new SSEServerTransport("/message", res);
    sessions.set(transport.sessionId, transport);

    mcpServer.connect(transport).catch((err: unknown) => {
      logger.error({ event: "sse_error", clientIp: ip, err }, String(err));
    });

    req.on("close", () => {
      logger.info({ event: "client_disconnected", clientIp: ip }, `client_disconnected  ← ${ip}`);
      sessions.delete(transport.sessionId);
      mcpServer.close().catch(() => {});
    });
  });

  return app;
}

// ---------------------------------------------------------------------------
// Build an MCP Server instance wired to the current pool state
// ---------------------------------------------------------------------------

function buildMcpServer(
  pool: UpstreamPool,
  customTools: CustomTool[],
  clientIpAddr: string
): Server {
  const server = new Server(
    { name: "tars-hub-mcp", version: "0.1.0" },
    {
      capabilities: {
        tools: {},
        resources: {},
        prompts: {},
      },
    }
  );

  const allCustomToolDefs = customTools.map((ct) => ct.definition);
  const customToolMap = new Map(customTools.map((ct) => [ct.definition.name, ct]));

  // ---- Tools ---------------------------------------------------------------

  server.setRequestHandler(ListToolsRequestSchema, async () => {
    return { tools: [...pool.tools, ...allCustomToolDefs] };
  });

  server.setRequestHandler(CallToolRequestSchema, async (req) => {
    const { name, arguments: args = {} } = req.params;
    const reqBytes = byteSize(args);
    const start = Date.now();

    // Custom tool?
    const custom = customToolMap.get(name);
    if (custom) {
      try {
        const result = await custom.handler(args as Record<string, unknown>);
        const resBytes = byteSize(result);
        logToolCall({
          tool: name,
          upstream: "custom",
          clientIp: clientIpAddr,
          durationMs: Date.now() - start,
          reqBytes,
          resBytes,
          isError: false,
        });
        return result;
      } catch (err) {
        logToolCall({
          tool: name,
          upstream: "custom",
          clientIp: clientIpAddr,
          durationMs: Date.now() - start,
          reqBytes,
          resBytes: 0,
          isError: true,
        });
        return {
          content: [{ type: "text" as const, text: `Error: ${String(err)}` }],
          isError: true,
        };
      }
    }

    // Upstream tool?
    const upstream = pool.findForTool(name);
    if (!upstream) {
      logToolBlocked({
        tool: name,
        upstream: "unknown",
        clientIp: clientIpAddr,
        reason: "not in allowlist or not found",
      });
      return {
        content: [{ type: "text" as const, text: `Tool "${name}" is not available` }],
        isError: true,
      };
    }

    // Log args at debug level only (may contain sensitive data)
    logger.debug({ event: "tool_call_args", tool: name, args }, "tool_call_args");

    try {
      const result = await upstream.callTool(name, args as Record<string, unknown>);
      const resBytes = byteSize(result);
      logToolCall({
        tool: name,
        upstream: upstream.state.config.name,
        clientIp: clientIpAddr,
        durationMs: Date.now() - start,
        reqBytes,
        resBytes,
        isError: result.isError === true,
      });
      return result;
    } catch (err) {
      logToolCall({
        tool: name,
        upstream: upstream.state.config.name,
        clientIp: clientIpAddr,
        durationMs: Date.now() - start,
        reqBytes,
        resBytes: 0,
        isError: true,
      });
      return {
        content: [{ type: "text" as const, text: `Upstream error: ${String(err)}` }],
        isError: true,
      };
    }
  });

  // ---- Resources -----------------------------------------------------------

  server.setRequestHandler(ListResourcesRequestSchema, async () => {
    return { resources: pool.resources };
  });

  server.setRequestHandler(ListResourceTemplatesRequestSchema, async () => {
    return { resourceTemplates: pool.resourceTemplates };
  });

  server.setRequestHandler(ReadResourceRequestSchema, async (req) => {
    const { uri } = req.params;
    const upstream = pool.findForResource(uri);
    if (!upstream) {
      throw new Error(`Resource "${uri}" is not available`);
    }
    return upstream.readResource(uri);
  });

  // ---- Prompts -------------------------------------------------------------

  server.setRequestHandler(ListPromptsRequestSchema, async () => {
    return { prompts: pool.prompts };
  });

  server.setRequestHandler(GetPromptRequestSchema, async (req) => {
    const { name, arguments: args } = req.params;
    const upstream = pool.findForPrompt(name);
    if (!upstream) {
      throw new Error(`Prompt "${name}" is not available`);
    }
    return upstream.getPrompt(name, args as Record<string, string> | undefined);
  });

  return server;
}
