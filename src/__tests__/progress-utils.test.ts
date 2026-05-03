import assert from "node:assert/strict";
import test from "node:test";
import { createProgressChunk, hasRenderableAssistantContent } from "../server/progress-utils.js";

test("hasRenderableAssistantContent rejects empty, whitespace, and ZWSP-only text", () => {
  assert.equal(hasRenderableAssistantContent(""), false);
  assert.equal(hasRenderableAssistantContent("   \n\t"), false);
  assert.equal(hasRenderableAssistantContent("\u200B\u200C\u200D\uFEFF"), false);
  assert.equal(hasRenderableAssistantContent("[Working: using shell…]\n"), true);
});

test("createProgressChunk preserves visible progress and assistant role", () => {
  const chunk = createProgressChunk("req_1", "gpt-5.5", "[Working: using shell…]\n");
  assert.equal(chunk.id, "chatcmpl-req_1");
  assert.equal(chunk.choices[0].delta.role, "assistant");
  assert.equal(chunk.choices[0].delta.content, "[Working: using shell…]\n");
  assert.equal(chunk.choices[0].finish_reason, null);
});

test("createProgressChunk refuses non-renderable assistant content", () => {
  assert.throws(() => createProgressChunk("req_1", "gpt-5.5", "\u200B"), /visible assistant text/);
});
