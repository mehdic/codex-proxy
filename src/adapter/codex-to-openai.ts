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
  ResponseUsage,
  ChatCompletionToolCall,
} from "../types/openai.js";
import type { TurnResult } from "../subprocess/manager.js";
import type { TokenUsageBreakdown } from "../types/codex.js";

// ── Helpers ──────────────────────────────────────────────────────────

export function turnResultUsageToOpenAI(result: TurnResult): TokenUsage {
  const usage = result.usage;
  const input = usage?.inputTokens ?? 0;
  const output = usage?.outputTokens ?? 0;
  return {
    prompt_tokens: input,
    completion_tokens: output,
    total_tokens: usage?.totalTokens ?? input + output,
    prompt_tokens_details: { cached_tokens: usage?.cachedInputTokens ?? 0 },
    completion_tokens_details: { reasoning_tokens: usage?.reasoningOutputTokens ?? 0 },
    estimated: Boolean(result.usageEstimated),
    estimate_method: result.usageEstimateMethod,
    cost: result.cost,
    cost_usd: result.cost?.total_cost_usd,
  };
}

function turnResultUsageToResponseUsage(result: TurnResult): ResponseUsage {
  const usage = result.usage;
  const input = usage?.inputTokens ?? 0;
  const output = usage?.outputTokens ?? 0;
  return {
    input_tokens: input,
    output_tokens: output,
    total_tokens: usage?.totalTokens ?? input + output,
    input_tokens_details: { cached_tokens: usage?.cachedInputTokens ?? 0 },
    output_tokens_details: { reasoning_tokens: usage?.reasoningOutputTokens ?? 0 },
    estimated: Boolean(result.usageEstimated),
    estimate_method: result.usageEstimateMethod,
    cost: result.cost,
    cost_usd: result.cost?.total_cost_usd,
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
    if (item.type === "agentMessage" && Array.isArray(item.content)) {
      return textFromContentParts(item.content);
    }
  }

  // Nested content array
  if (Array.isArray(obj.content)) {
    return textFromContentParts(obj.content);
  }

  // text field directly
  if (typeof obj.text === "string") return obj.text;

  return null;
}

function textFromContentParts(content: unknown[]): string | null {
  const texts = content
    .filter((c: unknown) => typeof c === "object" && c !== null)
    .map((c: unknown) => c as Record<string, unknown>)
    .filter((c) => c.type === "output_text" || c.type === "text")
    .map((c) => c.text)
    .filter((t: unknown): t is string => typeof t === "string");
  return texts.length > 0 ? texts.join("") : null;
}

/**
 * Append a Codex text event while tolerating app-server schema drift.
 *
 * Some versions emit token deltas and later repeat the whole final text in an
 * item/completed agentMessage. If the candidate starts with the accumulated
 * text, treat it as authoritative final text instead of appending a duplicate.
 */
export function appendAssistantText(current: string, candidate: string | null): string {
  if (!candidate) return current;
  if (!current) return candidate;
  if (candidate === current) return current;
  if (candidate.startsWith(current)) return candidate;
  return current + candidate;
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
    usage: turnResultUsageToOpenAI(result),
  };
}

/** Build a non-streaming chat completion response containing a function tool call. */
export function turnResultToToolCallChatCompletion(
  result: TurnResult,
  model: string,
  toolName: string,
): ChatCompletionResponse {
  const args = extractJsonObjectString(result.text) || "{}";
  return {
    id: `chatcmpl-${result.turnId}`,
    object: "chat.completion",
    created: Math.floor(Date.now() / 1000),
    model,
    choices: [
      {
        index: 0,
        message: {
          role: "assistant",
          content: null,
          tool_calls: [
            {
              id: `call_${result.turnId.replace(/[^a-zA-Z0-9_-]/g, "").slice(0, 32) || uuid()}`,
              type: "function",
              function: { name: toolName, arguments: args },
            },
          ],
        },
        finish_reason: "tool_calls",
      },
    ],
    usage: turnResultUsageToOpenAI(result),
  };
}


/** Build a non-streaming chat completion response containing a specific function tool call. */
export function turnResultToSpecificToolCallChatCompletion(
  result: TurnResult,
  model: string,
  toolName: string,
  args: Record<string, unknown>,
): ChatCompletionResponse {
  return {
    id: `chatcmpl-${result.turnId}`,
    object: "chat.completion",
    created: Math.floor(Date.now() / 1000),
    model,
    choices: [
      {
        index: 0,
        message: {
          role: "assistant",
          content: null,
          tool_calls: [makeToolCall(result.turnId, toolName, args)],
        },
        finish_reason: "tool_calls",
      },
    ],
    usage: turnResultUsageToOpenAI(result),
  };
}

export function turnResultToMultiToolCallChatCompletion(
  result: TurnResult,
  model: string,
  toolCalls: Array<{ name: string; arguments: Record<string, unknown> }>,
): ChatCompletionResponse {
  return {
    id: `chatcmpl-${result.turnId}`,
    object: "chat.completion",
    created: Math.floor(Date.now() / 1000),
    model,
    choices: [
      {
        index: 0,
        message: {
          role: "assistant",
          content: null,
          tool_calls: toolCalls.map((call, index) => makeToolCall(result.turnId, call.name, call.arguments, index)),
        },
        finish_reason: "tool_calls",
      },
    ],
    usage: turnResultUsageToOpenAI(result),
  };
}

export function makeToolCall(seed: string, toolName: string, args: Record<string, unknown>, index = 0): ChatCompletionToolCall {
  const cleanSeed = seed.replace(/[^a-zA-Z0-9_-]/g, "").slice(0, 28);
  const suffix = index > 0 ? `_${index}` : "";
  return {
    id: `call_${cleanSeed || uuid()}${suffix}`,
    type: "function",
    function: { name: toolName, arguments: JSON.stringify(args || {}) },
  };
}

function extractJsonObjectString(text: string): string | null {
  const trimmed = text.trim();
  if (!trimmed) return null;
  const fenced = trimmed.match(/```(?:json)?\s*([\s\S]*?)```/i);
  const candidate = (fenced ? fenced[1] : trimmed).trim();
  const start = candidate.indexOf("{");
  const end = candidate.lastIndexOf("}");
  if (start === -1 || end === -1 || end < start) return null;
  const json = candidate.slice(start, end + 1);
  try {
    return JSON.stringify(JSON.parse(json));
  } catch {
    return null;
  }
}

/** Build a streaming chat completion chunk (delta). */
export function makeChatCompletionChunk(
  id: string,
  model: string,
  delta: string | null,
  finishReason: "stop" | "length" | null = null,
  usage: TokenUsage | null = null,
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
    ...(usage ? { usage } : {}),
  };
}


export function makeChatToolCallChunk(
  id: string,
  model: string,
  toolCall: ChatCompletionToolCall,
  toolIndex: number = 0,
  finishReason: "tool_calls" | null = "tool_calls",
): ChatCompletionChunk {
  return {
    id: `chatcmpl-${id}`,
    object: "chat.completion.chunk",
    created: Math.floor(Date.now() / 1000),
    model,
    choices: [
      {
        index: 0,
        delta: {
          role: "assistant",
          tool_calls: [{ index: toolIndex, ...toolCall }],
        },
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
  ids: { responseId?: string; outputId?: string } = {},
): ResponseObject {
  const outputItem: ResponseOutputItem = {
    type: "message",
    id: ids.outputId || `msg_${uuid()}`,
    role: "assistant",
    status: "completed",
    content: [{ type: "output_text", text: result.text }],
  };

  return {
    id: ids.responseId || `resp_${result.turnId}`,
    object: "response",
    created_at: Math.floor(Date.now() / 1000),
    model,
    status: result.finishReason === "error" ? "failed" : "completed",
    output: [outputItem],
    output_text: result.text,
    usage: turnResultUsageToResponseUsage(result),
    error: result.finishReason === "error"
      ? { message: "Turn failed", code: "server_error" }
      : null,
  };
}

/** Build a Responses API streaming event. */
export function makeResponseStreamEvent(type: string, data: Record<string, unknown>): string {
  return `event: ${type}\ndata: ${JSON.stringify({ type, ...data })}\n\n`;
}

export interface ResponseStreamIds {
  responseId?: string;
  itemId?: string;
}

/** Build a Responses text delta event with common SDK-friendly aliases. */
export function makeResponseTextDeltaEvent(
  outputIndex: number,
  contentIndex: number,
  delta: string,
  ids: ResponseStreamIds = {},
): string {
  return makeResponseStreamEvent("response.output_text.delta", {
    ...(ids.responseId ? { response_id: ids.responseId } : {}),
    ...(ids.itemId ? { item_id: ids.itemId } : {}),
    output_index: outputIndex,
    content_index: contentIndex,
    delta,
  });
}

/** Build final Responses text event with compatibility aliases. */
export function makeResponseTextDoneEvent(
  outputIndex: number,
  contentIndex: number,
  text: string,
  ids: ResponseStreamIds = {},
): string {
  return makeResponseStreamEvent("response.output_text.done", {
    ...(ids.responseId ? { response_id: ids.responseId } : {}),
    ...(ids.itemId ? { item_id: ids.itemId } : {}),
    output_index: outputIndex,
    content_index: contentIndex,
    text,
    delta: text,
  });
}

/** Build the newer response.done alias in addition to response.completed. */
export function makeResponseDoneEvent(response: ResponseObject): string {
  return makeResponseStreamEvent("response.done", { response });
}
