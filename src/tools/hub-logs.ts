import type { CustomTool } from "../types.js";
import { getRecentLogs } from "../logger.js";

const LEVEL_NAMES: Record<number, string> = {
  10: "trace",
  20: "debug",
  30: "info",
  40: "warn",
  50: "error",
  60: "fatal",
};

/** Returns a custom MCP tool that surfaces recent hub log entries. */
export const hubLogsTool: CustomTool = {
  definition: {
    name: "hub__logs",
    description:
      "Returns the last N log entries emitted by the hub (default 50, max 500). " +
      "Useful for diagnosing errors, tracing tool calls, and monitoring upstream events.",
    inputSchema: {
      type: "object",
      properties: {
        n: {
          type: "number",
          description: "Number of log entries to return (1–500). Defaults to 50.",
        },
        level: {
          type: "string",
          enum: ["trace", "debug", "info", "warn", "error", "fatal"],
          description: "Minimum log level to include. Defaults to 'info'.",
        },
      },
      required: [],
    },
  },
  handler: async (args) => {
    const n = typeof args.n === "number" ? args.n : 50;
    const minLevelName = typeof args.level === "string" ? args.level : "info";
    const minLevel = Object.entries(LEVEL_NAMES).find(([, v]) => v === minLevelName)?.[0];
    const minLevelNum = minLevel !== undefined ? Number(minLevel) : 30;

    const entries = getRecentLogs(n).filter((e) => e.level >= minLevelNum);

    const lines = entries.map((e) => {
      const ts = new Date(e.time).toISOString();
      const levelName = LEVEL_NAMES[e.level] ?? String(e.level);
      return `[${ts}] ${levelName.toUpperCase().padEnd(5)} ${e.msg}`;
    });

    return {
      content: [
        {
          type: "text" as const,
          text: lines.length > 0 ? lines.join("\n") : "(no log entries matching criteria)",
        },
      ],
    };
  },
};
