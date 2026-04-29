import assert from "node:assert/strict";
import test from "node:test";
import { parseConfig } from "../server/config.js";

test("parseConfig applies safe defaults", () => {
  const cfg = parseConfig({});
  assert.equal(cfg.host, "127.0.0.1");
  assert.equal(cfg.port, 3466);
  assert.equal(cfg.defaultTimeoutMs, 120_000);
  assert.equal(cfg.shutdownGraceMs, 10_000);
  assert.equal(cfg.debug, false);
  assert.equal(cfg.cors, false);
});

test("parseConfig reads env overrides and clamps invalid numbers", () => {
  const cfg = parseConfig({
    CODEX_PROXY_HOST: "0.0.0.0",
    CODEX_PROXY_PORT: "3470",
    CODEX_PROXY_TIMEOUT_MS: "90000",
    CODEX_PROXY_TURN_START_TIMEOUT_MS: "bad",
    CODEX_PROXY_SHUTDOWN_GRACE_MS: "-1",
    CODEX_PROXY_DEBUG: "1",
    CODEX_PROXY_CORS: "1",
  });

  assert.equal(cfg.host, "0.0.0.0");
  assert.equal(cfg.port, 3470);
  assert.equal(cfg.defaultTimeoutMs, 90_000);
  assert.equal(cfg.turnStartTimeoutMs, 10_000);
  assert.equal(cfg.shutdownGraceMs, 10_000);
  assert.equal(cfg.debug, true);
  assert.equal(cfg.cors, true);
});
