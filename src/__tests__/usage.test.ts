import assert from "node:assert/strict";
import test from "node:test";
import { turnResultToChatCompletion } from "../adapter/codex-to-openai.js";
import { estimateCost, normalizeModel } from "../server/pricing.js";
import { annotateTurnUsage, estimateTokenUsage } from "../server/usage.js";
import type { TurnResult } from "../subprocess/manager.js";

test("normalizeModel removes provider prefixes for pricing", () => {
  assert.equal(normalizeModel("codex-proxy/gpt-5.4-mini"), "gpt-5.4-mini");
  assert.equal(normalizeModel("openai-codex/gpt-5.5"), "gpt-5.5");
});

test("estimateCost reports simulated USD pricing without mutating token counts", () => {
  const cost = estimateCost("codex-proxy/gpt-5.4-mini", {
    inputTokens: 1000,
    cachedInputTokens: 100,
    outputTokens: 250,
    reasoningOutputTokens: 50,
    totalTokens: 1250,
  });
  assert.equal(cost.currency, "USD");
  assert.equal(cost.model, "gpt-5.4-mini");
  assert.ok(cost.total_cost_usd > 0);
  assert.equal(cost.pricing.cached_input_per_1m, 0.075);
});

test("annotateTurnUsage preserves Codex usage and adds cost metadata", () => {
  const turn: TurnResult = {
    text: "OK",
    turnId: "turn_usage",
    threadId: "thread_usage",
    usage: { inputTokens: 10, cachedInputTokens: 2, outputTokens: 3, reasoningOutputTokens: 1, totalTokens: 13 },
    durationMs: 5,
    finishReason: "stop",
  };
  annotateTurnUsage(turn, "ignored prompt", "gpt-5.4-mini");
  const response = turnResultToChatCompletion(turn, "gpt-5.4-mini");
  assert.equal(response.usage?.prompt_tokens, 10);
  assert.equal(response.usage?.prompt_tokens_details?.cached_tokens, 2);
  assert.equal(response.usage?.completion_tokens_details?.reasoning_tokens, 1);
  assert.equal(response.usage?.estimated, false);
  assert.equal(response.usage?.estimate_method, "codex_app_server");
  assert.ok((response.usage?.cost_usd || 0) > 0);
});

test("annotateTurnUsage estimates missing Codex usage", () => {
  const turn: TurnResult = {
    text: "short output",
    turnId: "turn_estimated_usage",
    threadId: "thread_estimated_usage",
    usage: null,
    durationMs: 5,
    finishReason: "stop",
  };
  annotateTurnUsage(turn, "This prompt needs an estimate", "gpt-5.4-mini");
  assert.equal(turn.usageEstimated, true);
  assert.equal(turn.usageEstimateMethod, "heuristic_chars_div_4");
  assert.ok((turn.usage?.totalTokens || 0) > 0);
  assert.ok((turn.cost?.total_cost_usd || 0) >= 0);
});

test("estimateTokenUsage uses positive heuristic counts for non-empty text", () => {
  const usage = estimateTokenUsage("one two three four", "five six");
  assert.ok(usage.inputTokens >= 1);
  assert.ok(usage.outputTokens >= 1);
  assert.equal(usage.totalTokens, usage.inputTokens + usage.outputTokens);
});
