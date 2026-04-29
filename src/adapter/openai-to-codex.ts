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

  return {
    prompt,
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
    prompt,
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

// ── Helpers ─────────────────────────────────────────────────────────

function extractMessageText(msg: ChatMessage): string {
  if (typeof msg.content === "string") return msg.content;
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
