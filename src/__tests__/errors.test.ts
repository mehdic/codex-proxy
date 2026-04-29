import assert from "node:assert/strict";
import test from "node:test";
import { CodexProxyError, mapErrorToHttp } from "../server/errors.js";

test("mapErrorToHttp maps timeout and spawn failures", () => {
  assert.deepEqual(mapErrorToHttp(new CodexProxyError("timeout", "Turn timed out")).status, 504);
  assert.deepEqual(mapErrorToHttp(new CodexProxyError("spawn", "Codex CLI not found")).body.error.code, "codex_spawn_failed");
});

test("mapErrorToHttp does not leak stderr by default", () => {
  const mapped = mapErrorToHttp(new CodexProxyError("protocol", "JSON-RPC error", { detail: "secret-like detail" }));
  assert.equal(mapped.body.error.message, "Codex app-server protocol error");
  assert.equal("detail" in mapped.body.error, false);
});
