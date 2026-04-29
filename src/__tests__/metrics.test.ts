import assert from "node:assert/strict";
import test from "node:test";
import {
  recordFallback,
  recordPoolEvent,
  recordRequest,
  recordSubprocessExit,
  renderMetrics,
  resetMetrics,
  setPoolSize,
} from "../server/metrics.js";

test("metrics keep user-controlled labels bounded", () => {
  resetMetrics();
  recordRequest({
    endpoint: "chat_completions",
    model: "custom-user-model-id",
    runtime: "pool",
    status: "ok",
    durationMs: 42,
  });

  const rendered = renderMetrics();
  assert.match(rendered, /codex_proxy_requests_total\{endpoint="chat_completions",model="other",runtime="pool",status="ok"\} 1/);
  assert.doesNotMatch(rendered, /custom-user-model-id/);
});

test("metrics render request duration histogram and subprocess exits", () => {
  resetMetrics();
  recordRequest({
    endpoint: "responses",
    model: "gpt-5.5",
    runtime: "oneshot",
    status: "error",
    durationMs: 1200,
  });
  recordSubprocessExit("signal");

  const rendered = renderMetrics();
  assert.match(rendered, /codex_proxy_request_duration_seconds_bucket\{endpoint="responses",model="gpt-5\.5",runtime="oneshot",status="error",le="2\.500"\} 1/);
  assert.match(rendered, /codex_proxy_subprocess_exits_total\{reason="signal"\} 1/);
});

test("metrics render pool counters and gauges with bounded labels", () => {
  resetMetrics();
  recordPoolEvent("warm_hit");
  recordPoolEvent("cold_spawn");
  recordPoolEvent("ttl_eviction");
  recordPoolEvent("lru_eviction");
  recordFallback("pool_failure");
  setPoolSize(3);

  const rendered = renderMetrics();
  assert.match(rendered, /codex_proxy_pool_events_total\{event="warm_hit"\} 1/);
  assert.match(rendered, /codex_proxy_pool_events_total\{event="cold_spawn"\} 1/);
  assert.match(rendered, /codex_proxy_pool_events_total\{event="ttl_eviction"\} 1/);
  assert.match(rendered, /codex_proxy_pool_events_total\{event="lru_eviction"\} 1/);
  assert.match(rendered, /codex_proxy_fallbacks_total\{reason="pool_failure"\} 1/);
  assert.match(rendered, /codex_proxy_pool_size 3/);
});
