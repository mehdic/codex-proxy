/**
 * OpenAI-compatible API types for chat completions and responses.
 */

// ── Chat Completions ────────────────────────────────────────────────

export interface ChatCompletionRequest {
  model?: string;
  messages: ChatMessage[];
  stream?: boolean;
  temperature?: number;
  max_tokens?: number;
  max_completion_tokens?: number;
  top_p?: number;
  stop?: string | string[];
  user?: string;
  tools?: ChatCompletionTool[];
  tool_choice?: "none" | "auto" | "required" | ChatCompletionNamedToolChoice;
  response_format?: ResponseFormat;
}

export interface ChatCompletionTool {
  type: "function";
  function: {
    name: string;
    description?: string;
    parameters?: Record<string, unknown>;
    strict?: boolean;
  };
}

export interface ChatCompletionNamedToolChoice {
  type: "function";
  function: { name: string };
}

export type ResponseFormat =
  | { type: "text" }
  | { type: "json_object" }
  | { type: "json_schema"; json_schema: { name?: string; schema?: Record<string, unknown>; strict?: boolean } };

export interface ChatMessage {
  role: "system" | "user" | "assistant" | "developer" | "tool";
  content: string | ContentPart[] | null;
  tool_calls?: ChatCompletionToolCall[];
  tool_call_id?: string;
  name?: string;
}

export interface ContentPart {
  type: "text" | "image_url";
  text?: string;
  image_url?: { url: string; detail?: string };
}

export interface ChatCompletionResponse {
  id: string;
  object: "chat.completion";
  created: number;
  model: string;
  choices: ChatCompletionChoice[];
  usage?: TokenUsage;
}

export interface ChatCompletionChoice {
  index: number;
  message: { role: "assistant"; content: string | null; tool_calls?: ChatCompletionToolCall[] };
  finish_reason: "stop" | "length" | "tool_calls" | null;
}

export interface ChatCompletionToolCall {
  id: string;
  type: "function";
  function: {
    name: string;
    arguments: string;
  };
}

export interface ChatCompletionChunk {
  id: string;
  object: "chat.completion.chunk";
  created: number;
  model: string;
  choices: ChatCompletionChunkChoice[];
  usage?: TokenUsage | null;
}

export interface ChatCompletionChunkChoice {
  index: number;
  delta: { role?: "assistant"; content?: string; tool_calls?: Array<ChatCompletionToolCall & { index: number }> };
  finish_reason: "stop" | "length" | "tool_calls" | null;
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

export interface TokenUsage {
  prompt_tokens: number;
  completion_tokens: number;
  total_tokens: number;
  prompt_tokens_details?: {
    cached_tokens?: number;
  };
  completion_tokens_details?: {
    reasoning_tokens?: number;
  };
  estimated?: boolean;
  estimate_method?: string;
  cost?: UsageCostEstimate;
  cost_usd?: number;
}

export interface ResponseUsage {
  input_tokens: number;
  output_tokens: number;
  total_tokens: number;
  input_tokens_details?: {
    cached_tokens?: number;
  };
  output_tokens_details?: {
    reasoning_tokens?: number;
  };
  estimated?: boolean;
  estimate_method?: string;
  cost?: UsageCostEstimate;
  cost_usd?: number;
}

// ── Responses API ───────────────────────────────────────────────────

export interface ResponseRequest {
  model?: string;
  input: string | ResponseInputItem[];
  stream?: boolean;
  instructions?: string;
  temperature?: number;
  max_output_tokens?: number;
  user?: string;
  tools?: ChatCompletionTool[];
  tool_choice?: "none" | "auto" | "required" | ChatCompletionNamedToolChoice;
  response_format?: ResponseFormat;
}

export interface ResponseInputItem {
  type?: "message" | string;
  role: "user" | "assistant" | "system" | "developer" | string;
  content: string | ResponseContentPart[];
}

export type ResponseContentPart =
  | { type: "input_text" | "output_text" | "text"; text: string }
  | { type: "input_image" | "image_url"; image_url?: string | { url?: string; detail?: string }; file_id?: string; detail?: string }
  | { type: "input_file" | "file"; file_id?: string; filename?: string; file_data?: string; file_url?: string }
  | { type: "input_audio" | "audio"; input_audio?: { data?: string; format?: string }; transcript?: string; text?: string }
  | { type: "refusal"; refusal?: string; text?: string }
  | { type: string; [key: string]: unknown };

export interface ResponseObject {
  id: string;
  object: "response";
  created_at: number;
  model: string;
  status: "completed" | "failed" | "in_progress";
  output: ResponseOutputItem[];
  output_text?: string;
  usage?: ResponseUsage;
  error?: { message: string; code: string } | null;
}

export interface ResponseOutputItem {
  type: "message";
  id: string;
  role: "assistant";
  status: "completed";
  content: { type: "output_text"; text: string }[];
}

// ── Streaming events for Responses API ──────────────────────────────

export interface ResponseStreamEvent {
  type: string;
  // Various shapes depending on event type
  [key: string]: unknown;
}

// ── Models ──────────────────────────────────────────────────────────

export interface ModelObject {
  id: string;
  object: "model";
  created: number;
  owned_by: string;
}

export interface ModelListResponse {
  object: "list";
  data: ModelObject[];
}
