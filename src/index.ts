#!/usr/bin/env node
import "dotenv/config";
import { resolve } from "path";
import { loadConfig } from "./config.js";
import { UpstreamPool } from "./upstream.js";
import { createHubServer } from "./server.js";
import { customTools } from "./tools/index.js";
import { logger } from "./logger.js";

const configPath = resolve(process.env.HUB_CONFIG ?? "config.json");

async function main() {
  // Load config
  let config;
  try {
    config = loadConfig(configPath);
  } catch (err) {
    logger.error({ err }, `Failed to load config from "${configPath}"`);
    process.exit(1);
  }

  const port = config.port ?? 3000;

  logger.info({ event: "startup", configPath, upstreams: config.upstreams.length }, `Starting tars-hub-mcp on port ${port}`);

  const pool = new UpstreamPool(config.upstreams);

  // Start HTTP server immediately — upstreams connect in background
  const app = createHubServer(config, pool, customTools);
  const httpServer = app.listen(port, () => {
    logger.info(
      { event: "listening", port },
      `Hub listening on http://localhost:${port}  (SSE: /sse  Health: /health)`
    );
  });

  // Connect upstreams in background (failures are handled with retry internally)
  pool.connectAll().then(() => {
    const connectedCount = pool.states.filter((s) => s.status === "connected").length;
    logger.info(
      { event: "upstreams_ready", connected: connectedCount, total: config.upstreams.length },
      `Upstreams: ${connectedCount}/${config.upstreams.length} connected — ${pool.tools.length} upstream tools + ${customTools.length} custom tools`
    );
  }).catch(() => {});

  // Graceful shutdown
  async function shutdown(signal: string) {
    logger.info({ event: "shutdown", signal }, `Received ${signal}, shutting down…`);
    httpServer.close();
    await pool.stopAll();
    process.exit(0);
  }

  process.on("SIGINT", () => void shutdown("SIGINT"));
  process.on("SIGTERM", () => void shutdown("SIGTERM"));
}

main().catch((err) => {
  logger.error({ err }, "Fatal error");
  process.exit(1);
});
