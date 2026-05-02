import { makeChatCompletionChunk } from "../adapter/codex-to-openai.js";

const INVISIBLE_ONLY_RE = /[\u200B\u200C\u200D\uFEFF]/g;

export function hasRenderableAssistantContent(text: string | null | undefined): boolean {
  return typeof text === "string" && text.replace(INVISIBLE_ONLY_RE, "").trim().length > 0;
}

export function createProgressChunk(id: string, model: string, content: string, includeRole = false): ReturnType<typeof makeChatCompletionChunk> {
  if (!hasRenderableAssistantContent(content)) {
    throw new Error("progress content must be visible assistant text");
  }
  const chunk = makeChatCompletionChunk(id, model, content);
  if (includeRole) chunk.choices[0].delta.role = "assistant";
  return chunk;
}
