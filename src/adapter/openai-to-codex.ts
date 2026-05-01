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
  ResponseContentPart,
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
      case "tool": {
        const toolName = msg.name || "unknown";
        const toolCallId = msg.tool_call_id || "unknown";
        parts.push(`<tool_result name="${escapeXmlAttribute(toolName)}" tool_call_id="${escapeXmlAttribute(toolCallId)}">\n${text}\n</tool_result>\n`);
        break;
      }
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
  const finalPrompt = appendToolInstructions(appendStructuredOutputInstruction(prompt, req), req);

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
    prompt: appendToolInstructions(appendStructuredOutputInstruction(prompt, req), req),
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
    const text = typeof item.content === "string"
      ? item.content
      : responseContentPartsToText(item.content);

    switch (item.role) {
      case "system":
      case "developer":
        parts.push(`<system>\n${text}\n</system>\n`);
        break;
      case "assistant":
        parts.push(`<previous_response>\n${text}\n</previous_response>\n`);
        break;
      case "user":
      default:
        parts.push(text);
        break;
    }
  }
  return parts.join("\n");
}

function responseContentPartsToText(parts: ResponseContentPart[]): string {
  return parts
    .map((part) => responseContentPartToText(part))
    .filter(Boolean)
    .join("\n");
}

function responseContentPartToText(part: ResponseContentPart): string {
  if (!part || typeof part !== "object") return "";
  const p = part as Record<string, unknown>;

  if ((p.type === "input_text" || p.type === "output_text" || p.type === "text") && typeof p.text === "string") {
    return p.text;
  }

  if ((p.type === "input_image" || p.type === "image_url")) {
    const imageUrl = p.image_url;
    const url = typeof imageUrl === "string"
      ? imageUrl
      : imageUrl && typeof imageUrl === "object" && typeof (imageUrl as Record<string, unknown>).url === "string"
        ? String((imageUrl as Record<string, unknown>).url)
        : undefined;
    const fileId = typeof p.file_id === "string" ? p.file_id : undefined;
    const detail = typeof p.detail === "string"
      ? p.detail
      : imageUrl && typeof imageUrl === "object" && typeof (imageUrl as Record<string, unknown>).detail === "string"
        ? String((imageUrl as Record<string, unknown>).detail)
        : undefined;
    const source = url ? `url=${url}` : fileId ? `file_id=${fileId}` : "source=unavailable";
    return `[input_image ${source}${detail ? ` detail=${detail}` : ""}]`;
  }

  if (p.type === "input_file" || p.type === "file") {
    const fields = ["filename", "file_id", "file_url"]
      .map((key) => typeof p[key] === "string" ? `${key}=${p[key]}` : "")
      .filter(Boolean)
      .join(" ");
    return `[input_file ${fields || "metadata=unavailable"}]`;
  }

  if (p.type === "input_audio" || p.type === "audio") {
    const audio = p.input_audio && typeof p.input_audio === "object"
      ? p.input_audio as Record<string, unknown>
      : {};
    const format = typeof audio.format === "string" ? audio.format : undefined;
    const transcript = typeof p.transcript === "string"
      ? p.transcript
      : typeof p.text === "string"
        ? p.text
        : undefined;
    const fields = [
      format ? `format=${format}` : "",
      transcript ? `transcript=${transcript}` : "",
      audio.data ? "data=present" : "",
    ].filter(Boolean).join(" ");
    return `[input_audio ${fields || "metadata=unavailable"}]`;
  }

  if (p.type === "refusal") {
    if (typeof p.refusal === "string") return `[refusal] ${p.refusal}`;
    if (typeof p.text === "string") return `[refusal] ${p.text}`;
  }

  return `[unsupported_content_part type=${typeof p.type === "string" ? p.type : "unknown"}]`;
}

export function requestedFunctionTool(req: Pick<ChatCompletionRequest, "tools" | "tool_choice">): ChatCompletionTool | null {
  const tools = (req.tools || []).filter((tool) => tool.type === "function" && tool.function?.name);
  if (tools.length === 0) return null;

  const choice = req.tool_choice;
  if (choice && typeof choice === "object" && choice.type === "function") {
    return tools.find((tool) => tool.function.name === choice.function.name) || null;
  }

  if (choice === "required") return tools[0];

  // LangChain structured-output calls commonly provide exactly one synthetic
  // schema function and omit tool_choice / use auto. Ordinary agent tool loops
  // usually expose operational tools such as get_stock_data/get_news. Force the
  // single schema-style function so with_structured_output can parse, but do not
  // force operational tools or multi-tool agent loops.
  if ((choice === "auto" || choice === undefined) && tools.length === 1 && isSchemaStyleTool(tools[0])) {
    return tools[0];
  }

  return null;
}

function isSchemaStyleTool(tool: ChatCompletionTool): boolean {
  const name = tool.function.name || "";
  if (name.includes("__")) return false;
  if (/^(get|fetch|search|query|list|read|write|update|delete|create)_/i.test(name)) return false;
  if (/^(get|fetch|search|query|list|read|write|update|delete|create)[A-Z]/.test(name)) return false;
  return true;
}

export interface ProxyToolCallRequest {
  name: string;
  arguments: Record<string, unknown>;
}

export function shouldEmulateOperationalTools(req: Pick<ChatCompletionRequest, "tools" | "tool_choice">): boolean {
  if (requestedFunctionTool(req)) return false;
  if (req.tool_choice === "none") return false;
  return (req.tools || []).some((tool) => tool.type === "function" && tool.function?.name);
}

export function extractProxyToolCall(text: string, req: Pick<ChatCompletionRequest, "tools" | "tool_choice">): ProxyToolCallRequest | null {
  const all = extractAllProxyToolCalls(text, req);
  return all.length > 0 ? all[0] : null;
}

/** Extract ALL valid operational tool call bridge objects from text. */
export function extractAllProxyToolCalls(text: string, req: Pick<ChatCompletionRequest, "tools" | "tool_choice">): ProxyToolCallRequest[] {
  if (!shouldEmulateOperationalTools(req)) return [];
  const allowed = new Set((req.tools || []).filter((tool) => tool.type === "function").map((tool) => tool.function.name));

  const results: ProxyToolCallRequest[] = [];
  for (const obj of iterJsonObjects(text)) {
    const candidate = obj.tool_call;
    if (!candidate || typeof candidate !== "object") continue;
    const call = candidate as Record<string, unknown>;
    if (typeof call.name !== "string" || !allowed.has(call.name)) continue;
    const args = call.arguments && typeof call.arguments === "object" && !Array.isArray(call.arguments)
      ? call.arguments as Record<string, unknown>
      : {};
    results.push({ name: call.name, arguments: args });
  }
  return results;
}

function appendToolInstructions(
  prompt: string,
  req: Pick<ChatCompletionRequest, "tools" | "tool_choice">,
): string {
  if (!shouldEmulateOperationalTools(req)) return prompt;
  const tools = (req.tools || [])
    .filter((tool) => tool.type === "function" && tool.function?.name)
    .map((tool) => ({
      name: tool.function.name,
      description: tool.function.description || "",
      parameters: tool.function.parameters || { type: "object" },
    }));

  return `${prompt}

<codex_proxy_openai_tools>
The following external OpenAI/OpenClaw tools are available in addition to your native Codex capabilities.
These external tools are dispatched by the caller (e.g. OpenClaw); the proxy will not execute them for you.
To request external tools, return a valid JSON object in this exact shape for each tool:
{"tool_call":{"name":"tool_name","arguments":{}}}
You may emit multiple tool_call objects in a single response to invoke several tools in parallel. Place each on its own line or separate them with whitespace.
Use one of the external tool names listed below and fill arguments according to its schema.
Do not treat this bridge as replacing or disabling Codex-native tools/capabilities. Use your native Codex capabilities whenever they are useful, and request an external OpenAI/OpenClaw tool only when the caller-dispatched tool is the right source or action.
If a <tool_result> is present, consume it to answer the user's request; do NOT repeat the same external tool call unless the user explicitly asks for another call.
If no external tool is needed, answer normally and do not use this JSON shape.
External tools:
${JSON.stringify(tools)}
</codex_proxy_openai_tools>`;
}

/**
 * Yield every top-level JSON object found in `text`, scanning left-to-right.
 * Handles prose surrounding objects, adjacent objects without whitespace, and
 * code-fenced blocks.  Brace-balances to find each object boundary rather than
 * relying on lastIndexOf("}").
 */
function* iterJsonObjects(text: string): Generator<Record<string, unknown>> {
  // Strip code fences so the scanner sees raw JSON.
  const stripped = text.replace(/```(?:json)?\s*([\s\S]*?)```/gi, "$1");
  let pos = 0;
  while (pos < stripped.length) {
    const start = stripped.indexOf("{", pos);
    if (start === -1) break;

    // Brace-balance scan: track depth, respecting JSON strings.
    let depth = 0;
    let end = -1;
    let inString = false;
    let escape = false;
    for (let i = start; i < stripped.length; i++) {
      const ch = stripped[i];
      if (escape) { escape = false; continue; }
      if (ch === "\\" && inString) { escape = true; continue; }
      if (ch === '"') { inString = !inString; continue; }
      if (inString) continue;
      if (ch === "{") depth++;
      else if (ch === "}") {
        depth--;
        if (depth === 0) { end = i; break; }
      }
    }
    if (end === -1) break; // unbalanced — give up

    const slice = stripped.slice(start, end + 1);
    try {
      const parsed = JSON.parse(slice);
      if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
        yield parsed as Record<string, unknown>;
      }
    } catch { /* not valid JSON despite balanced braces — skip */ }
    pos = end + 1;
  }
}

function parseJsonObject(text: string): Record<string, unknown> | null {
  const trimmed = text.trim();
  if (!trimmed) return null;
  const fenced = trimmed.match(/```(?:json)?\s*([\s\S]*?)```/i);
  const candidate = (fenced ? fenced[1] : trimmed).trim();
  const start = candidate.indexOf("{");
  const end = candidate.lastIndexOf("}");
  if (start === -1 || end === -1 || end < start) return null;
  try {
    const parsed = JSON.parse(candidate.slice(start, end + 1));
    return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed as Record<string, unknown> : null;
  } catch {
    return null;
  }
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


function escapeXmlAttribute(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/"/g, "&quot;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");
}

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
