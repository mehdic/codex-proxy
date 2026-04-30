import type { TurnResult } from "../subprocess/manager.js";
import type { TokenUsageBreakdown } from "../types/codex.js";
import { estimateCost } from "./pricing.js";
import { recordTokenUsage } from "./metrics.js";

export function annotateTurnUsage(result: TurnResult, prompt: string, model: string): TurnResult {
  const hadCodexUsage = usableUsage(result.usage);
  const usage = hadCodexUsage ? result.usage! : estimateTokenUsage(prompt, result.text);
  result.usage = usage;
  result.usageEstimated = !hadCodexUsage;
  result.usageEstimateMethod = hadCodexUsage ? "codex_app_server" : "heuristic_chars_div_4";
  result.cost = estimateCost(model, usage);
  recordTokenUsage(model, usage, result.cost, Boolean(result.usageEstimated));
  return result;
}

export function estimateTokenUsage(prompt: string, output: string): TokenUsageBreakdown {
  const inputTokens = estimateTextTokens(prompt);
  const outputTokens = estimateTextTokens(output);
  return {
    totalTokens: inputTokens + outputTokens,
    inputTokens,
    cachedInputTokens: 0,
    outputTokens,
    reasoningOutputTokens: 0,
  };
}

function estimateTextTokens(text: string): number {
  const s = String(text || "");
  if (!s) return 0;
  // Public API tokenizers vary by model. chars/4 is the common operational
  // approximation; the word floor prevents undercounting terse numeric/text data.
  const charEstimate = Math.ceil(s.length / 4);
  const wordEstimate = Math.ceil(s.trim().split(/\s+/).filter(Boolean).length * 1.33);
  return Math.max(1, charEstimate, wordEstimate);
}

function usableUsage(usage: TokenUsageBreakdown | null | undefined): boolean {
  return Boolean(usage && (usage.totalTokens > 0 || usage.inputTokens > 0 || usage.outputTokens > 0));
}
