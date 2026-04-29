#!/usr/bin/env node
import { startServer, stopServer } from "./index.js";
import { CONFIG, parseConfig } from "./config.js";

const cliPort = process.argv[2] ? Number(process.argv[2]) : undefined;

if (cliPort !== undefined && (!Number.isInteger(cliPort) || cliPort <= 0 || cliPort > 65535)) {
  console.error(`Invalid port: ${process.argv[2]}`);
  process.exit(1);
}

try {
  const { host, port } = await startServer({ port: cliPort });
  console.log(`codex-proxy listening on http://${host}:${port}`);
  console.log(`health: http://${host}:${port}/health`);
  console.log(`bind: ${host} (default is localhost-only)`);
} catch (err) {
  console.error("Failed to start codex-proxy:", err instanceof Error ? err.message : err);
  process.exit(1);
}

let shuttingDown = false;
const shutdown = async (signal: NodeJS.Signals) => {
  if (shuttingDown) return;
  shuttingDown = true;
  const cfg = parseConfig(process.env);
  console.log(`\nReceived ${signal}; shutting down with ${cfg.shutdownGraceMs}ms grace...`);
  try {
    await stopServer(cfg.shutdownGraceMs);
    process.exit(0);
  } catch (err) {
    console.error("Shutdown failed:", err instanceof Error ? err.message : err);
    process.exit(1);
  }
};

process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);
