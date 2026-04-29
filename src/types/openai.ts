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
}

export interface ChatMessage {
  role: "system" | "user" | "assistant" | "developer";
  content: string | ContentPart[];
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
  message: { role: "assistant"; content: string };
  finish_reason: "stop" | "length" | "tool_calls" | null;
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
  delta: { role?: "assistant"; content?: string };
  finish_reason: "stop" | "length" | null;
}

export interface TokenUsage {
  prompt_tokens: number;
  completion_tokens: number;
  total_tokens: number;
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
}

export interface ResponseInputItem {
  role: "user" | "assistant" | "system" | "developer";
  content: string | ResponseContentPart[];
}

export interface ResponseContentPart {
  type: "input_text" | "output_text";
  text: string;
}

export interface ResponseObject {
  id: string;
  object: "response";
  created_at: number;
  model: string;
  status: "completed" | "failed" | "in_progress";
  output: ResponseOutputItem[];
  usage?: TokenUsage;
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
