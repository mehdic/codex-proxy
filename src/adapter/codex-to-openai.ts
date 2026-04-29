/**
 * Adapter: Codex app-server output → OpenAI API response shapes.
 *
 * Converts TurnResult (and streaming deltas) into OpenAI-compatible
 * chat completion responses, chunks, and Responses API objects.
 */

import { v4 as uuid } from "uuid";
import type {
  ChatCompletionResponse,
  ChatCompletionChunk,
  ResponseObject,
  ResponseOutputItem,
  TokenUsage,
} from "../types/openai.js";
import type { TurnResult } from "../subprocess/manager.js";
import type { TokenUsageBreakdown } from "../types/codex.js";

// ── Helpers ──────────────────────────────────────────────────────────

function codexUsageToOpenAI(usage: TokenUsageBreakdown | null): TokenUsage | undefined {
  if (!usage) return undefined;
  return {
    prompt_tokens: usage.inputTokens,
    completion_tokens: usage.outputTokens,
    total_tokens: usage.totalTokens,
  };
}

/**
 * Tolerant delta text extractor for any Codex notification shape.
 * Handles known fields and falls back gracefully.
 */
export function extractDeltaText(msg: unknown): string | null {
  if (msg == null || typeof msg !== "object") return null;
  const obj = msg as Record<string, unknown>;

  // Standard agentMessage delta
  if (typeof obj.delta === "string") return obj.delta;

  // item/completed with agentMessage text
  if (obj.item && typeof obj.item === "object") {
    const item = obj.item as Record<string, unknown>;
    if (item.type === "agentMessage" && typeof item.text === "string") {
      return item.text;
    }
  }

  // Nested content array
  if (Array.isArray(obj.content)) {
    const texts = obj.content
      .filter((c: unknown) => typeof c === "object" && c !== null && (c as Record<string, unknown>).type === "output_text")
      .map((c: unknown) => (c as Record<string, unknown>).text)
      .filter((t: unknown): t is string => typeof t === "string");
    if (texts.length > 0) return texts.join("");
  }

  // text field directly
  if (typeof obj.text === "string") return obj.text;

  return null;
}

// ── Chat Completions ─────────────────────────────────────────────────

/** Build a non-streaming chat completion response from a TurnResult. */
export function turnResultToChatCompletion(
  result: TurnResult,
  model: string,
): ChatCompletionResponse {
  return {
    id: `chatcmpl-${result.turnId}`,
    object: "chat.completion",
    created: Math.floor(Date.now() / 1000),
    model,
    choices: [
      {
        index: 0,
        message: { role: "assistant", content: result.text },
        finish_reason: result.finishReason === "error" ? "stop" : result.finishReason,
      },
    ],
    usage: codexUsageToOpenAI(result.usage),
  };
}

/** Build a streaming chat completion chunk (delta). */
export function makeChatCompletionChunk(
  id: string,
  model: string,
  delta: string | null,
  finishReason: "stop" | "length" | null = null,
): ChatCompletionChunk {
  return {
    id: `chatcmpl-${id}`,
    object: "chat.completion.chunk",
    created: Math.floor(Date.now() / 1000),
    model,
    choices: [
      {
        index: 0,
        delta: delta !== null ? { role: "assistant", content: delta } : {},
        finish_reason: finishReason,
      },
    ],
  };
}

/** Format a chunk as an SSE data line. */
export function chunkToSSE(chunk: ChatCompletionChunk): string {
  return `data: ${JSON.stringify(chunk)}\n\n`;
}

/** SSE stream terminator. */
export const SSE_DONE = "data: [DONE]\n\n";

// ── Responses API ────────────────────────────────────────────────────

/** Build a non-streaming Responses API object from a TurnResult. */
export function turnResultToResponseObject(
  result: TurnResult,
  model: string,
): ResponseObject {
  const outputItem: ResponseOutputItem = {
    type: "message",
    id: `msg_${uuid()}`,
    role: "assistant",
    status: "completed",
    content: [{ type: "output_text", text: result.text }],
  };

  return {
    id: `resp_${result.turnId}`,
    object: "response",
    created_at: Math.floor(Date.now() / 1000),
    model,
    status: result.finishReason === "error" ? "failed" : "completed",
    output: [outputItem],
    usage: codexUsageToOpenAI(result.usage),
    error: result.finishReason === "error"
      ? { message: "Turn failed", code: "server_error" }
      : null,
  };
}

/** Build a Responses API streaming event. */
export function makeResponseStreamEvent(type: string, data: Record<string, unknown>): string {
  return `event: ${type}\ndata: ${JSON.stringify(data)}\n\n`;
}
