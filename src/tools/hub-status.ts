import type { CustomTool } from "../types.js";
import type { UpstreamPool } from "../upstream.js";

/**
 * Returns a custom MCP tool that reports the live state of every upstream
 * connection managed by the hub.
 */
export function createHubStatusTool(pool: UpstreamPool): CustomTool {
  return {
    definition: {
      name: "hub__status",
      description:
        "Returns the live state of the MCP hub: each upstream connection status, " +
        "how many tools / resources / prompts it exposes, when it last connected, " +
        "and any recent error. Useful for diagnosing connectivity issues.",
      inputSchema: {
        type: "object",
        properties: {},
        required: [],
      },
    },
    handler: async () => {
      const upstreams = pool.states.map((s) => ({
        name: s.config.name,
        transport: s.config.transport,
        status: s.status,
        tools: s.tools.map((t) => t.name),
        toolCount: s.tools.length,
        resourceCount: s.resources.length,
        promptCount: s.prompts.length,
        connectedAt: s.connectedAt?.toISOString() ?? null,
        lastError: s.lastError ?? null,
      }));

      const summary = {
        totalUpstreams: upstreams.length,
        connected: upstreams.filter((u) => u.status === "connected").length,
        upstreams,
      };

      return {
        content: [{ type: "text" as const, text: JSON.stringify(summary, null, 2) }],
      };
    },
  };
}
