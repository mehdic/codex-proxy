#!/usr/bin/env node
import { startServer } from "./index.js";

const cliPort = process.argv[2] ? Number(process.argv[2]) : undefined;

if (cliPort !== undefined && (!Number.isInteger(cliPort) || cliPort <= 0 || cliPort > 65535)) {
  console.error(`Invalid port: ${process.argv[2]}`);
  process.exit(1);
}

try {
  const { host, port } = await startServer({ port: cliPort });
  console.log(`codex-proxy listening on http://${host}:${port}`);
  console.log(`health: http://${host}:${port}/health`);
} catch (err) {
  console.error("Failed to start codex-proxy:", err instanceof Error ? err.message : err);
  process.exit(1);
}
