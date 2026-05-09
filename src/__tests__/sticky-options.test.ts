import assert from "node:assert/strict";
import test from "node:test";
import { parseConfig } from "../server/config.js";
import { resolveSessionOptions, type StickyOptionsRequest } from "../server/sticky-options.js";

function req(headers: Record<string, string | string[] | undefined> = {}, body?: unknown): StickyOptionsRequest {
  const normalized = new Map(Object.entries(headers).map(([key, value]) => [key.toLowerCase(), value]));
  return {
    body,
    header: (name: string) => normalized.get(name.toLowerCase()),
  };
}

test("no headers or body resolves to pool mode", () => {
  const resolved = resolveSessionOptions(req(), parseConfig({}));

  assert.deepEqual(resolved, { kind: "ok", options: { mode: "pool", explicit: false } });
});

test("preferred session key header opts into sticky when enabled", () => {
  const resolved = resolveSessionOptions(req({ "x-codex-proxy-session-key": "caller:one" }), parseConfig({
    CODEX_PROXY_STICKY_SESSIONS: "1",
  }));

  assert.equal(resolved.kind, "ok");
  assert.equal(resolved.options.mode, "sticky");
  assert.equal(resolved.options.explicit, true);
  assert.equal(resolved.options.sticky?.rawKey, "caller:one");
  assert.match(resolved.options.sticky?.keyHash || "", /^[a-f0-9]{64}$/);
  assert.match(resolved.options.sticky?.keyHashShort || "", /^[a-f0-9]{12}$/);
});

test("legacy session header remains an alias", () => {
  const resolved = resolveSessionOptions(req({ "x-codex-proxy-session": "legacy-1" }), parseConfig({
    CODEX_PROXY_SESSIONS: "1",
  }));

  assert.equal(resolved.kind, "ok");
  assert.equal(resolved.options.mode, "sticky");
  assert.equal(resolved.options.sticky?.rawKey, "legacy-1");
  assert.equal(resolved.options.sticky?.legacyHeader, true);
});

test("headers beat body extension aliases", () => {
  const resolved = resolveSessionOptions(req({
    "x-codex-proxy-session-key": "header-key",
    "x-codex-proxy-session-ttl-seconds": "120",
  }, {
    codex_proxy: {
      session_key: "body-key",
      session_ttl_seconds: 600,
    },
  }), parseConfig({ CODEX_PROXY_STICKY_SESSIONS: "1" }));

  assert.equal(resolved.kind, "ok");
  assert.equal(resolved.options.sticky?.rawKey, "header-key");
  assert.equal(resolved.options.sticky?.ttlSeconds, 120);
});

test("body aliases work when body options are allowed", () => {
  const resolved = resolveSessionOptions(req({}, {
    codex_proxy: {
      sessionKey: "body-key",
      mode: "sticky",
      ttl_seconds: 90,
      reset: "true",
      policy: "compatible",
    },
  }), parseConfig({ CODEX_PROXY_STICKY_SESSIONS: "1" }));

  assert.equal(resolved.kind, "ok");
  assert.equal(resolved.options.mode, "sticky");
  assert.equal(resolved.options.sticky?.rawKey, "body-key");
  assert.equal(resolved.options.sticky?.ttlSeconds, 90);
  assert.equal(resolved.options.sticky?.reset, true);
  assert.equal(resolved.options.sticky?.policy, "compatible");
});

test("body options can be disabled", () => {
  const resolved = resolveSessionOptions(req({}, {
    codex_proxy: { session_key: "body-key", session_mode: "sticky" },
  }), parseConfig({
    CODEX_PROXY_STICKY_SESSIONS: "1",
    CODEX_PROXY_STICKY_ALLOW_BODY_OPTIONS: "0",
  }));

  assert.deepEqual(resolved, { kind: "ok", options: { mode: "pool", explicit: false } });
});

test("stateless mode works without a key", () => {
  const resolved = resolveSessionOptions(req({ "x-codex-proxy-session-mode": "stateless" }), parseConfig({}));

  assert.deepEqual(resolved, { kind: "ok", options: { mode: "stateless", explicit: true } });
});

test("sticky mode without a key returns invalid_session_key", () => {
  const resolved = resolveSessionOptions(req({ "x-codex-proxy-session-mode": "sticky" }), parseConfig({
    CODEX_PROXY_STICKY_SESSIONS: "1",
  }));

  assert.equal(resolved.kind, "invalid");
  assert.equal(resolved.code, "invalid_session_key");
});

test("sticky disabled returns sticky_sessions_disabled", () => {
  const resolved = resolveSessionOptions(req({ "x-codex-proxy-session-key": "caller" }), parseConfig({}));

  assert.equal(resolved.kind, "invalid");
  assert.equal(resolved.code, "sticky_sessions_disabled");
});

test("ttl seconds clamps to min and max", () => {
  const low = resolveSessionOptions(req({
    "x-codex-proxy-session-key": "caller",
    "x-codex-proxy-session-ttl-seconds": "1",
  }), parseConfig({
    CODEX_PROXY_STICKY_SESSIONS: "1",
    CODEX_PROXY_STICKY_MIN_TTL_SECONDS: "60",
  }));
  const high = resolveSessionOptions(req({
    "x-codex-proxy-session-key": "caller",
    "x-codex-proxy-session-ttl-seconds": "999999",
  }), parseConfig({
    CODEX_PROXY_STICKY_SESSIONS: "1",
    CODEX_PROXY_STICKY_MAX_TTL_SECONDS: "300",
  }));

  assert.equal(low.options.sticky?.ttlSeconds, 60);
  assert.equal(high.options.sticky?.ttlSeconds, 300);
});

test("reset truthy and falsy values parse predictably", () => {
  const truthy = resolveSessionOptions(req({
    "x-codex-proxy-session-key": "caller",
    "x-codex-proxy-session-reset": "yes",
  }), parseConfig({ CODEX_PROXY_STICKY_SESSIONS: "1" }));
  const falsy = resolveSessionOptions(req({
    "x-codex-proxy-session-key": "caller",
    "x-codex-proxy-session-reset": "0",
  }), parseConfig({ CODEX_PROXY_STICKY_SESSIONS: "1" }));

  assert.equal(truthy.options.sticky?.reset, true);
  assert.equal(falsy.options.sticky?.reset, false);
});

test("policy accepts only strict or compatible", () => {
  const compatible = resolveSessionOptions(req({
    "x-codex-proxy-session-key": "caller",
    "x-codex-proxy-session-policy": "compatible",
  }), parseConfig({ CODEX_PROXY_STICKY_SESSIONS: "1" }));
  const invalid = resolveSessionOptions(req({
    "x-codex-proxy-session-key": "caller",
    "x-codex-proxy-session-policy": "loose",
  }), parseConfig({ CODEX_PROXY_STICKY_SESSIONS: "1" }));

  assert.equal(compatible.options.sticky?.policy, "compatible");
  assert.equal(invalid.kind, "invalid");
  assert.equal(invalid.code, "invalid_session_policy");
});

test("key hash short is metrics-safe and raw key is not reused as hash", () => {
  const rawKey = "private-user-session";
  const resolved = resolveSessionOptions(req({ "x-codex-proxy-session-key": rawKey }), parseConfig({
    CODEX_PROXY_STICKY_SESSIONS: "1",
  }));

  assert.equal(resolved.kind, "ok");
  assert.match(resolved.options.sticky?.keyHashShort || "", /^[a-f0-9]{12}$/);
  assert.notEqual(resolved.options.sticky?.keyHashShort, rawKey);
  assert.notEqual(resolved.options.sticky?.keyHash, rawKey);
});
