import assert from "node:assert/strict";
import test from "node:test";
import { AVAILABLE_MODELS, canonicalModelLabel, resolveModel } from "../adapter/openai-to-codex.js";
import { incCounter, observeHistogram, renderMetrics, resetMetrics } from "../server/metrics.js";

test("model list includes current Codex models", () => {
  assert.ok(AVAILABLE_MODELS.includes("gpt-5.5"));
  assert.ok(AVAILABLE_MODELS.includes("gpt-5.4"));
  assert.ok(AVAILABLE_MODELS.includes("gpt-5.3-codex"));
});

test("resolveModel falls back to default", () => {
  assert.equal(resolveModel(null), process.env.CODEX_PROXY_DEFAULT_MODEL || "gpt-5.5");
  assert.equal(resolveModel("gpt-5.4"), "gpt-5.4");
});

test("canonicalModelLabel bounds metric cardinality", () => {
  assert.equal(canonicalModelLabel("codex-proxy/gpt-5.5"), "gpt-5.5");
  assert.equal(canonicalModelLabel("unknown-model"), "other");
});

test("metrics render counters and summaries", () => {
  resetMetrics();
  incCounter("codex_proxy_requests_total", { endpoint: "chat", model: "gpt-5.5" });
  observeHistogram("codex_proxy_turn_duration_ms", 42, { model: "gpt-5.5" });
  const rendered = renderMetrics();
  assert.match(rendered, /codex_proxy_requests_total\{endpoint="chat",model="gpt-5\.5"\} 1/);
  assert.match(rendered, /codex_proxy_turn_duration_ms\{model="gpt-5\.5"\}_sum 42/);
});
