import assert from "node:assert/strict";
import test from "node:test";
import { parseConfig } from "../server/config.js";
import { resolveRuntime } from "../subprocess/runtime.js";

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
