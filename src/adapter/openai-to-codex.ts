/**
 * Adapter: OpenAI API request → Codex app-server input.
 *
 * Translates OpenAI chat completion and responses API shapes into
 * the flat user-text + options format that the subprocess manager
 * accepts.
 */

import type {
  ChatCompletionRequest,
  ChatMessage,
  ResponseRequest,
  ResponseInputItem,
  ChatCompletionTool,
} from "../types/openai.js";
import type { CodexSubprocessOptions } from "../subprocess/manager.js";

// ── Default and known models ────────────────────────────────────────

const DEFAULT_MODEL = process.env.CODEX_PROXY_DEFAULT_MODEL || "gpt-5.5";

export const AVAILABLE_MODELS = [
  "gpt-5.5",
  "gpt-5.4",
  "gpt-5.4-mini",
  "gpt-5.3-codex",
  "gpt-5.3-codex-spark",
  "gpt-5.2",
] as const;

/** Resolve model: use provided or fall back to default. */
export function resolveModel(model?: string | null): string {
  return model || DEFAULT_MODEL;
}

// ── Chat Completions → Codex ────────────────────────────────────────

/**
 * Flatten an OpenAI messages array into a single prompt string for Codex.
 * System/developer messages become XML-tagged context; assistant messages
 * become <previous_response> blocks; user messages are bare.
 */
export function chatMessagesToPrompt(messages: ChatMessage[]): {
  prompt: string;
  systemInstruction: string | null;
} {
  let systemInstruction: string | null = null;
  const parts: string[] = [];

  for (const msg of messages) {
    const text = extractMessageText(msg);

    switch (msg.role) {
      case "system":
      case "developer":
        // Capture first system message as instruction, rest inline
        if (!systemInstruction) {
          systemInstruction = text;
        } else {
          parts.push(`<system>\n${text}\n</system>\n`);
        }
        break;
      case "assistant":
        parts.push(`<previous_response>\n${text}\n</previous_response>\n`);
        break;
      case "user":
        parts.push(text);
        break;
    }
  }

  return {
    prompt: parts.join("\n"),
    systemInstruction,
  };
}

/**
 * Build CodexSubprocessOptions from a chat completion request.
 */
export function chatRequestToOptions(
  req: ChatCompletionRequest,
  defaults?: Partial<CodexSubprocessOptions>,
): { prompt: string; options: CodexSubprocessOptions } {
  const model = resolveModel(req.model);
  const { prompt, systemInstruction } = chatMessagesToPrompt(req.messages);
  const finalPrompt = appendStructuredOutputInstruction(prompt, req);

  return {
    prompt: finalPrompt,
    options: {
      model,
      instructions: systemInstruction || defaults?.instructions,
      timeoutMs: defaults?.timeoutMs,
      initTimeoutMs: defaults?.initTimeoutMs,
      turnStartTimeoutMs: defaults?.turnStartTimeoutMs,
      cwd: defaults?.cwd,
      configOverrides: defaults?.configOverrides,
    },
  };
}

// ── Responses API → Codex ───────────────────────────────────────────

/**
 * Build CodexSubprocessOptions from a responses API request.
 */
export function responsesRequestToOptions(
  req: ResponseRequest,
  defaults?: Partial<CodexSubprocessOptions>,
): { prompt: string; options: CodexSubprocessOptions } {
  const model = resolveModel(req.model);
  let prompt: string;

  if (typeof req.input === "string") {
    prompt = req.input;
  } else {
    prompt = responsesInputToPrompt(req.input);
  }

  return {
    prompt: appendStructuredOutputInstruction(prompt, req),
    options: {
      model,
      instructions: req.instructions || defaults?.instructions,
      timeoutMs: defaults?.timeoutMs,
      initTimeoutMs: defaults?.initTimeoutMs,
      turnStartTimeoutMs: defaults?.turnStartTimeoutMs,
      cwd: defaults?.cwd,
      configOverrides: defaults?.configOverrides,
    },
  };
}

function responsesInputToPrompt(items: ResponseInputItem[]): string {
  const parts: string[] = [];
  for (const item of items) {
    const text =
      typeof item.content === "string"
        ? item.content
        : item.content
            .map((p) => p.text)
            .filter(Boolean)
            .join("\n");

    switch (item.role) {
      case "system":
      case "developer":
        parts.push(`<system>\n${text}\n</system>\n`);
        break;
      case "assistant":
        parts.push(`<previous_response>\n${text}\n</previous_response>\n`);
        break;
      case "user":
        parts.push(text);
        break;
    }
  }
  return parts.join("\n");
}

export function requestedFunctionTool(req: Pick<ChatCompletionRequest, "tools" | "tool_choice">): ChatCompletionTool | null {
  const tools = (req.tools || []).filter((tool) => tool.type === "function" && tool.function?.name);
  if (tools.length === 0) return null;

  const choice = req.tool_choice;
  if (choice && typeof choice === "object" && choice.type === "function") {
    return tools.find((tool) => tool.function.name === choice.function.name) || null;
  }

  if (choice === "none") return null;
  if (choice === "required" || choice === "auto" || choice === undefined) return tools[0];
  return null;
}

function appendStructuredOutputInstruction(
  prompt: string,
  req: Pick<ChatCompletionRequest, "tools" | "tool_choice" | "response_format">,
): string {
  const tool = requestedFunctionTool(req);
  if (tool) {
    const schema = JSON.stringify(tool.function.parameters || { type: "object" });
    return `${prompt}

<codex_proxy_structured_output>
You must satisfy an OpenAI function/tool call request.
Return ONLY a valid JSON object for function ${JSON.stringify(tool.function.name)}.
Do not include markdown, prose, code fences, or any text outside the JSON object.
The JSON object must conform to this JSON Schema:
${schema}
</codex_proxy_structured_output>`;
  }

  if (req.response_format?.type === "json_object") {
    return `${prompt}

<codex_proxy_structured_output>
Return ONLY a valid JSON object. Do not include markdown, prose, code fences, or any text outside the JSON object.
</codex_proxy_structured_output>`;
  }

  if (req.response_format?.type === "json_schema") {
    const schema = JSON.stringify(req.response_format.json_schema?.schema || { type: "object" });
    return `${prompt}

<codex_proxy_structured_output>
Return ONLY a valid JSON object. Do not include markdown, prose, code fences, or any text outside the JSON object.
The JSON object must conform to this JSON Schema:
${schema}
</codex_proxy_structured_output>`;
  }

  return prompt;
}

// ── Helpers ─────────────────────────────────────────────────────────

function extractMessageText(msg: ChatMessage): string {
  if (typeof msg.content === "string") return msg.content;
  if (!msg.content) {
    if (msg.tool_calls && msg.tool_calls.length > 0) {
      return msg.tool_calls
        .map((call) => `<tool_call name="${call.function.name}">${call.function.arguments}</tool_call>`)
        .join("\n");
    }
    return "";
  }
  return msg.content
    .filter((p) => p.type === "text" && p.text)
    .map((p) => p.text!)
    .join("\n");
}

// ── Model label canonicalization for metrics ────────────────────────

const MODEL_LABEL_SET = new Set<string>(AVAILABLE_MODELS);

export function canonicalModelLabel(model: string): string {
  if (MODEL_LABEL_SET.has(model)) return model;
  // Strip provider prefix if present (e.g. "codex-proxy/gpt-5.5")
  const slashIdx = model.indexOf("/");
  if (slashIdx !== -1) {
    const bare = model.slice(slashIdx + 1);
    if (MODEL_LABEL_SET.has(bare)) return bare;
  }
  return "other";
}
