import pino from "pino";
import { Writable } from "stream";

// ---------------------------------------------------------------------------
// In-memory ring buffer — captures the last RING_BUFFER_SIZE log entries
// so the hub__logs tool can surface them via MCP.
// ---------------------------------------------------------------------------

const RING_BUFFER_SIZE = 500;

export interface LogEntry {
  time: number;
  level: number;
  msg: string;
  event?: string;
  [key: string]: unknown;
}

const ringBuffer: LogEntry[] = [];

class RingBufferStream extends Writable {
  override _write(chunk: Buffer | string, _encoding: string, callback: () => void): void {
    const line = (chunk instanceof Buffer ? chunk.toString("utf8") : String(chunk)).trim();
    if (line) {
      try {
        const entry = JSON.parse(line) as LogEntry;
        ringBuffer.push(entry);
        if (ringBuffer.length > RING_BUFFER_SIZE) ringBuffer.shift();
      } catch {
        // pino-pretty output or non-JSON lines — ignore
      }
    }
    callback();
  }
}

/** Returns the last `n` log entries captured by the ring buffer. */
export function getRecentLogs(n: number): LogEntry[] {
  const count = Math.max(1, Math.min(n, RING_BUFFER_SIZE));
  return ringBuffer.slice(-count);
}

// ---------------------------------------------------------------------------
// Logger
// ---------------------------------------------------------------------------

const isDev = process.env.NODE_ENV !== "production";

const streams: pino.StreamEntry[] = [
  { stream: new RingBufferStream() },
  isDev
    ? {
        stream: pino.transport({
          target: "pino-pretty",
          options: {
            colorize: true,
            translateTime: "HH:MM:ss",
            ignore: "pid,hostname",
            messageFormat: "{msg}",
          },
        }),
      }
    : { stream: process.stdout },
];

export const logger = pino(
  {
    level: process.env.LOG_LEVEL ?? "info",
    base: { pid: process.pid },
  },
  pino.multistream(streams)
);

// ---------------------------------------------------------------------------
// Typed log helpers
// ---------------------------------------------------------------------------

export interface ToolCallLogFields {
  tool: string;
  upstream: string;
  clientIp: string;
  durationMs: number;
  reqBytes: number;
  resBytes: number;
  isError: boolean;
}

export interface ToolBlockedLogFields {
  tool: string;
  upstream: string;
  clientIp: string;
  reason: string;
}

export function logToolCall(fields: ToolCallLogFields) {
  const status = fields.isError ? "✗" : "✓";
  logger.info(
    { event: "tool_call", ...fields },
    `tool_call  ${fields.tool}  ← ${fields.clientIp}  ${fields.durationMs}ms ${status}  [${fields.reqBytes}b → ${fields.resBytes}b]`
  );
}

export function logToolBlocked(fields: ToolBlockedLogFields) {
  logger.warn(
    { event: "tool_blocked", ...fields },
    `tool_blocked  ${fields.tool}  ← ${fields.clientIp}  ${fields.reason}`
  );
}

export function logAuthFailure(clientIp: string) {
  logger.warn({ event: "auth_failure", clientIp }, `auth_failure  ← ${clientIp}`);
}

export function logUpstreamEvent(
  event: "connected" | "disconnected" | "reconnecting" | "failed",
  name: string,
  detail?: string
) {
  const msg = `upstream_${event}  ${name}${detail ? `  ${detail}` : ""}`;
  if (event === "connected") {
    logger.info({ event: `upstream_${event}`, upstream: name }, msg);
  } else if (event === "reconnecting") {
    logger.warn({ event: `upstream_${event}`, upstream: name, detail }, msg);
  } else {
    logger.warn({ event: `upstream_${event}`, upstream: name, detail }, msg);
  }
}
