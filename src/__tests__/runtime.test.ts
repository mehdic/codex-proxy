import assert from "node:assert/strict";
import test from "node:test";
import { parseConfig } from "../server/config.js";
import { resolveRuntime, resolveSessionRequest } from "../subprocess/runtime.js";

test("runtime defaults to pool", () => {
  const cfg = parseConfig({});
  assert.equal(resolveRuntime(undefined, cfg), "pool");
});

test("runtime header override is ignored unless explicitly enabled", () => {
  const cfg = parseConfig({ CODEX_PROXY_RUNTIME: "pool" });
  const req = { header: (name: string) => name === "x-codex-proxy-runtime" ? "oneshot" : undefined };
  assert.equal(resolveRuntime(req, cfg), "pool");
});

test("runtime header override accepts only bounded modes when enabled", () => {
  const cfg = parseConfig({ CODEX_PROXY_ALLOW_RUNTIME_OVERRIDE: "1" });

  assert.equal(resolveRuntime({ header: () => "oneshot" }, cfg), "oneshot");
  assert.equal(resolveRuntime({ header: () => "pool" }, cfg), "pool");
  assert.equal(resolveRuntime({ header: () => "prompt-text-is-not-a-mode" }, cfg), "pool");
});

test("session routing is disabled by default even when a session header is present", () => {
  const cfg = parseConfig({});
  const req = { header: (name: string) => name === "x-codex-proxy-session" ? "client-a" : undefined };

  assert.deepEqual(resolveSessionRequest(req, cfg), { kind: "none" });
});

test("session routing accepts only explicit bounded ascii ids when enabled", () => {
  const cfg = parseConfig({ CODEX_PROXY_SESSIONS: "1" });

  assert.deepEqual(resolveSessionRequest({ header: () => "client-a_1:two.three" }, cfg), {
    kind: "session",
    sessionId: "client-a_1:two.three",
  });
  assert.deepEqual(resolveSessionRequest({ header: () => "client a" }, cfg), {
    kind: "invalid",
    message: "X-Codex-Proxy-Session must match [A-Za-z0-9._:-] and be at most 128 characters",
  });
  assert.deepEqual(resolveSessionRequest({ header: () => "x".repeat(129) }, cfg).kind, "invalid");
});
