import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import type { TokenUsageBreakdown } from "../types/codex.js";

export interface ModelPrice {
  inputPer1M: number;
  cachedInputPer1M?: number;
  outputPer1M: number;
  currency?: "USD";
  source?: string;
  updatedAt?: string;
  note?: string;
}

export interface PricingBook {
  updatedAt?: string;
  source?: string;
  models: Record<string, ModelPrice>;
}

export interface UsageCostEstimate {
  currency: "USD";
  total_cost_usd: number;
  input_cost_usd: number;
  cached_input_cost_usd: number;
  output_cost_usd: number;
  model: string;
  pricing: {
    input_per_1m: number;
    cached_input_per_1m: number;
    output_per_1m: number;
    source: string;
    updated_at: string;
    note?: string;
  };
}

const DEFAULT_UPDATED_AT = "2026-04-30";

// Local reporting estimates only. The proxy still uses Codex subscription/app-server
// auth and does not bill or meter requests itself.
const FALLBACK_PRICING: PricingBook = {
  updatedAt: DEFAULT_UPDATED_AT,
  source: "static fallback from public OpenAI/OpenRouter pricing pages; refresh with scripts/update-pricing.mjs",
  models: {
    "gpt-5.5": {
      inputPer1M: 5.0,
      cachedInputPer1M: 0.5,
      outputPer1M: 30.0,
      source: "OpenRouter public model page snippet for openai/gpt-5.5; cached input estimated at 10% input",
      updatedAt: DEFAULT_UPDATED_AT,
    },
    "gpt-5.4": {
      inputPer1M: 4.0,
      cachedInputPer1M: 0.4,
      outputPer1M: 16.0,
      source: "OpenAI public pricing page snippet; cached input listed at 10% input",
      updatedAt: DEFAULT_UPDATED_AT,
    },
    "gpt-5.4-mini": {
      inputPer1M: 0.75,
      cachedInputPer1M: 0.075,
      outputPer1M: 6.0,
      source: "OpenAI public model comparison snippet for GPT-5.4 mini; output inferred from same family ratio",
      updatedAt: DEFAULT_UPDATED_AT,
      note: "estimated fallback until refreshed from a machine-readable public source",
    },
    "gpt-5.3-codex": {
      inputPer1M: 4.0,
      cachedInputPer1M: 0.4,
      outputPer1M: 16.0,
      source: "family fallback aligned to GPT-5.4 text pricing",
      updatedAt: DEFAULT_UPDATED_AT,
      note: "estimated fallback",
    },
    "gpt-5.3-codex-spark": {
      inputPer1M: 0.75,
      cachedInputPer1M: 0.075,
      outputPer1M: 6.0,
      source: "family fallback aligned to mini tier",
      updatedAt: DEFAULT_UPDATED_AT,
      note: "estimated fallback",
    },
    "gpt-5.2": {
      inputPer1M: 4.0,
      cachedInputPer1M: 0.4,
      outputPer1M: 16.0,
      source: "family fallback aligned to GPT text pricing",
      updatedAt: DEFAULT_UPDATED_AT,
      note: "estimated fallback",
    },
  },
};

let cachedBook: PricingBook | null = null;
let cachedPath: string | null = null;

export function pricingFilePath(): string {
  return process.env.CODEX_PROXY_PRICING_FILE || join(homedir(), ".codex-proxy", "pricing.json");
}

export function loadPricingBook(): PricingBook {
  const path = pricingFilePath();
  if (cachedBook && cachedPath === path) return cachedBook;

  cachedPath = path;
  cachedBook = mergePricing(FALLBACK_PRICING, readExternalBook(path));
  return cachedBook;
}

export function pricingSnapshot(): PricingBook {
  return loadPricingBook();
}

export function priceForModel(model: string): ModelPrice {
  const book = loadPricingBook();
  const key = normalizeModel(model);
  return book.models[key] || book.models[model] || inferPrice(key, book);
}

export function estimateCost(model: string, usage: TokenUsageBreakdown): UsageCostEstimate {
  const price = priceForModel(model);
  const inputTokens = Math.max(0, usage.inputTokens || 0);
  const cachedTokens = Math.max(0, Math.min(usage.cachedInputTokens || 0, inputTokens));
  const uncachedInputTokens = Math.max(0, inputTokens - cachedTokens);
  const outputTokens = Math.max(0, usage.outputTokens || 0);
  const inputRate = price.inputPer1M;
  const cachedRate = price.cachedInputPer1M ?? price.inputPer1M;
  const outputRate = price.outputPer1M;
  const inputCost = uncachedInputTokens / 1_000_000 * inputRate;
  const cachedCost = cachedTokens / 1_000_000 * cachedRate;
  const outputCost = outputTokens / 1_000_000 * outputRate;
  const total = inputCost + cachedCost + outputCost;
  return {
    currency: "USD",
    total_cost_usd: roundUsd(total),
    input_cost_usd: roundUsd(inputCost),
    cached_input_cost_usd: roundUsd(cachedCost),
    output_cost_usd: roundUsd(outputCost),
    model: normalizeModel(model),
    pricing: {
      input_per_1m: inputRate,
      cached_input_per_1m: cachedRate,
      output_per_1m: outputRate,
      source: price.source || loadPricingBook().source || "unknown",
      updated_at: price.updatedAt || loadPricingBook().updatedAt || DEFAULT_UPDATED_AT,
      ...(price.note ? { note: price.note } : {}),
    },
  };
}

export function normalizeModel(model: string): string {
  return String(model || "gpt-5.5")
    .replace(/^openai\//, "")
    .replace(/^openai-codex\//, "")
    .replace(/^codex-proxy\//, "")
    .replace(/^openrouter\/openai\//, "")
    .trim();
}

function readExternalBook(path: string): PricingBook | null {
  try {
    const parsed = JSON.parse(readFileSync(path, "utf-8")) as PricingBook;
    if (!parsed || typeof parsed !== "object" || !parsed.models || typeof parsed.models !== "object") return null;
    return parsed;
  } catch {
    return null;
  }
}

function mergePricing(base: PricingBook, external: PricingBook | null): PricingBook {
  if (!external) return base;
  return {
    updatedAt: external.updatedAt || base.updatedAt,
    source: external.source || base.source,
    models: { ...base.models, ...external.models },
  };
}

function inferPrice(model: string, book: PricingBook): ModelPrice {
  if (model.includes("mini") || model.includes("spark")) return book.models["gpt-5.4-mini"];
  return book.models["gpt-5.4"] || book.models["gpt-5.5"];
}

function roundUsd(value: number): number {
  return Math.round(value * 1_000_000) / 1_000_000;
}
