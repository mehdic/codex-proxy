import assert from "node:assert/strict";
import test from "node:test";
import { recordRequest, recordSubprocessExit, renderMetrics, resetMetrics } from "../server/metrics.js";

test("metrics keep user-controlled labels bounded", () => {
  resetMetrics();
  recordRequest({
    endpoint: "chat_completions",
    model: "custom-user-model-id",
    status: "ok",
    durationMs: 42,
  });

  const rendered = renderMetrics();
  assert.match(rendered, /codex_proxy_requests_total\{endpoint="chat_completions",model="other",status="ok"\} 1/);
  assert.doesNotMatch(rendered, /custom-user-model-id/);
});

test("metrics render request duration histogram and subprocess exits", () => {
  resetMetrics();
  recordRequest({
    endpoint: "responses",
    model: "gpt-5.5",
    status: "error",
    durationMs: 1200,
  });
  recordSubprocessExit("signal");

  const rendered = renderMetrics();
  assert.match(rendered, /codex_proxy_request_duration_seconds_bucket\{endpoint="responses",model="gpt-5\.5",status="error",le="2\.500"\} 1/);
  assert.match(rendered, /codex_proxy_subprocess_exits_total\{reason="signal"\} 1/);
});
