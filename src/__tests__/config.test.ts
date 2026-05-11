import assert from "node:assert/strict";
import test from "node:test";
import { parseConfig } from "../server/config.js";

test("parseConfig applies safe defaults", () => {
  const cfg = parseConfig({});
  assert.equal(cfg.host, "127.0.0.1");
  assert.equal(cfg.port, 3466);
  assert.equal(cfg.defaultTimeoutMs, 120_000);
  assert.equal(cfg.shutdownGraceMs, 10_000);
  assert.equal(cfg.runtime, "pool");
  assert.equal(cfg.allowRuntimeOverride, false);
  assert.equal(cfg.poolMax, 32);
  assert.equal(cfg.poolTtlMs, 600_000);
  assert.deepEqual(cfg.prewarmModels, ["gpt-5.5", "gpt-5.4-mini"]);
  assert.equal(cfg.initPool, true);
  assert.equal(cfg.fallbackOnPoolFailure, true);
  assert.equal(cfg.keepaliveMs, 10_000);
  assert.equal(cfg.sessionsEnabled, false);
  assert.equal(cfg.sessionTtlMs, 600_000);
  assert.equal(cfg.sessionMax, 32);
  assert.equal(cfg.debug, false);
  assert.equal(cfg.cors, false);
  assert.equal(cfg.codexSandbox, "read-only");
  assert.equal(cfg.codexApprovalPolicy, "never");
});

test("parseConfig reads env overrides and clamps invalid numbers", () => {
  const cfg = parseConfig({
    CODEX_PROXY_HOST: "0.0.0.0",
    CODEX_PROXY_PORT: "3470",
    CODEX_PROXY_TIMEOUT_MS: "90000",
    CODEX_PROXY_TURN_START_TIMEOUT_MS: "bad",
    CODEX_PROXY_SHUTDOWN_GRACE_MS: "-1",
    CODEX_PROXY_RUNTIME: "oneshot",
    CODEX_PROXY_ALLOW_RUNTIME_OVERRIDE: "1",
    CODEX_PROXY_POOL_MAX: "4",
    CODEX_PROXY_POOL_TTL_MS: "5000",
    CODEX_PROXY_PREWARM_MODELS: "gpt-5.4-mini, custom-model, gpt-5.5",
    CODEX_PROXY_INIT_POOL: "0",
    CODEX_PROXY_FALLBACK_ON_POOL_FAILURE: "0",
    CODEX_PROXY_KEEPALIVE_MS: "0",
    CODEX_PROXY_SESSIONS: "1",
    CODEX_PROXY_SESSION_TTL_MS: "12345",
    CODEX_PROXY_SESSION_MAX: "7",
    CODEX_PROXY_DEBUG: "1",
    CODEX_PROXY_CORS: "1",
    CODEX_PROXY_SANDBOX: "danger-full-access",
    CODEX_PROXY_APPROVAL_POLICY: "on-request",
  });

  assert.equal(cfg.host, "0.0.0.0");
  assert.equal(cfg.port, 3470);
  assert.equal(cfg.defaultTimeoutMs, 90_000);
  assert.equal(cfg.turnStartTimeoutMs, 10_000);
  assert.equal(cfg.shutdownGraceMs, 10_000);
  assert.equal(cfg.runtime, "oneshot");
  assert.equal(cfg.allowRuntimeOverride, true);
  assert.equal(cfg.poolMax, 4);
  assert.equal(cfg.poolTtlMs, 5000);
  assert.deepEqual(cfg.prewarmModels, ["gpt-5.4-mini", "custom-model", "gpt-5.5"]);
  assert.equal(cfg.initPool, false);
  assert.equal(cfg.fallbackOnPoolFailure, false);
  assert.equal(cfg.keepaliveMs, 0);
  assert.equal(cfg.sessionsEnabled, true);
  assert.equal(cfg.sessionTtlMs, 12345);
  assert.equal(cfg.sessionMax, 7);
  assert.equal(cfg.debug, true);
  assert.equal(cfg.cors, true);
  assert.equal(cfg.codexSandbox, "danger-full-access");
  assert.equal(cfg.codexApprovalPolicy, "on-request");
});

test("parseConfig falls back for invalid Codex sandbox and approval values", () => {
  const cfg = parseConfig({
    CODEX_PROXY_SANDBOX: "root-mode",
    CODEX_PROXY_APPROVAL_POLICY: "always-yes",
  });

  assert.equal(cfg.codexSandbox, "read-only");
  assert.equal(cfg.codexApprovalPolicy, "never");
});
