import assert from "node:assert/strict";
import test from "node:test";
import { CodexProxyError } from "../server/errors.js";
import { isPoolTransportFault } from "../subprocess/fallback.js";

test("recognizes pool worker transport faults", () => {
  assert.equal(isPoolTransportFault(new CodexProxyError("codex", "app-server process is dead")), true);
  assert.equal(isPoolTransportFault(new CodexProxyError("protocol", "JSON-RPC error -32000: broken pipe")), true);
  assert.equal(isPoolTransportFault(new CodexProxyError("timeout", "thread/start timed out after 100ms")), true);
});

test("does not fallback real Codex/auth/quota/model errors", () => {
  assert.equal(isPoolTransportFault(new CodexProxyError("codex", "Codex error: authentication required")), false);
  assert.equal(isPoolTransportFault(new CodexProxyError("codex", "Codex error: rate_limit_exceeded")), false);
  assert.equal(isPoolTransportFault(new CodexProxyError("codex", "Codex error: model not found")), false);
});

test("non-error throws are not pool transport faults", () => {
  assert.equal(isPoolTransportFault("process is dead"), false);
  assert.equal(isPoolTransportFault(null), false);
});
