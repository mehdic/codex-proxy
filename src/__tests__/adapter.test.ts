import assert from "node:assert/strict";
import test from "node:test";
import { chatMessagesToPrompt, chatRequestToOptions, responsesRequestToOptions } from "../adapter/openai-to-codex.js";
import { extractDeltaText, turnResultToChatCompletion, chunkToSSE } from "../adapter/codex-to-openai.js";
import type { TurnResult } from "../subprocess/manager.js";

test("chatMessagesToPrompt separates first system instruction", () => {
  const converted = chatMessagesToPrompt([
    { role: "system", content: "Be precise." },
    { role: "user", content: "Hello" },
    { role: "assistant", content: "Hi" },
    { role: "user", content: [{ type: "text", text: "Continue" }] },
  ]);

  assert.equal(converted.systemInstruction, "Be precise.");
  assert.match(converted.prompt, /Hello/);
  assert.match(converted.prompt, /<previous_response>\nHi\n<\/previous_response>/);
  assert.match(converted.prompt, /Continue/);
});

test("chatRequestToOptions uses requested model", () => {
  const { prompt, options } = chatRequestToOptions({
    model: "gpt-5.4-mini",
    messages: [{ role: "user", content: "Reply OK" }],
  });
  assert.equal(prompt, "Reply OK");
  assert.equal(options.model, "gpt-5.4-mini");
});

test("responsesRequestToOptions handles string input", () => {
  const { prompt, options } = responsesRequestToOptions({ model: "gpt-5.5", input: "Summarize" });
  assert.equal(prompt, "Summarize");
  assert.equal(options.model, "gpt-5.5");
});

test("extractDeltaText is tolerant", () => {
  assert.equal(extractDeltaText({ delta: "abc" }), "abc");
  assert.equal(extractDeltaText({ text: "direct" }), "direct");
  assert.equal(extractDeltaText({ item: { type: "agentMessage", text: "done" } }), "done");
  assert.equal(extractDeltaText(null), null);
});

test("turnResultToChatCompletion returns OpenAI-compatible response", () => {
  const turn: TurnResult = {
    text: "OK",
    turnId: "turn_1",
    threadId: "thread_1",
    usage: { inputTokens: 2, outputTokens: 1, totalTokens: 3, cachedInputTokens: 0, reasoningOutputTokens: 0 },
    durationMs: 10,
    finishReason: "stop",
  };
  const response = turnResultToChatCompletion(turn, "gpt-5.5");
  assert.equal(response.object, "chat.completion");
  assert.equal(response.choices[0].message.content, "OK");
  assert.equal(response.usage?.total_tokens, 3);
});

test("chunkToSSE formats data line", () => {
  const sse = chunkToSSE({
    id: "chatcmpl-1",
    object: "chat.completion.chunk",
    created: 1,
    model: "gpt-5.5",
    choices: [{ index: 0, delta: { content: "O" }, finish_reason: null }],
  });
  assert.match(sse, /^data: /);
  assert.match(sse, /chat\.completion\.chunk/);
  assert.match(sse, /\n\n$/);
});
