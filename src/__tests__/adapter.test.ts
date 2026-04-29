import assert from "node:assert/strict";
import test from "node:test";
import { chatMessagesToPrompt, chatRequestToOptions, requestedFunctionTool, responsesRequestToOptions } from "../adapter/openai-to-codex.js";
import {
  appendAssistantText,
  extractDeltaText,
  makeResponseStreamEvent,
  makeResponseTextDoneEvent,
  turnResultToChatCompletion,
  turnResultToToolCallChatCompletion,
  turnResultToResponseObject,
  chunkToSSE,
} from "../adapter/codex-to-openai.js";
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

test("request option builders preserve subprocess timeout defaults", () => {
  const defaults = {
    timeoutMs: 90_000,
    initTimeoutMs: 12_000,
    turnStartTimeoutMs: 3000,
  };

  const chat = chatRequestToOptions({
    model: "gpt-5.5",
    messages: [{ role: "user", content: "Reply OK" }],
  }, defaults);
  assert.equal(chat.options.timeoutMs, 90_000);
  assert.equal(chat.options.initTimeoutMs, 12_000);
  assert.equal(chat.options.turnStartTimeoutMs, 3000);

  const responses = responsesRequestToOptions({ model: "gpt-5.5", input: "Reply OK" }, defaults);
  assert.equal(responses.options.timeoutMs, 90_000);
  assert.equal(responses.options.initTimeoutMs, 12_000);
  assert.equal(responses.options.turnStartTimeoutMs, 3000);
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
  assert.equal(extractDeltaText({ item: { type: "agentMessage", content: [{ type: "output_text", text: "nested" }] } }), "nested");
  assert.equal(extractDeltaText(null), null);
});

test("appendAssistantText suppresses duplicate completed agent message text", () => {
  assert.equal(appendAssistantText("", "HEL"), "HEL");
  assert.equal(appendAssistantText("HEL", "HELLO"), "HELLO");
  assert.equal(appendAssistantText("HELLO", "HELLO"), "HELLO");
  assert.equal(appendAssistantText("HELLO", " world"), "HELLO world");
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

test("turnResultToResponseObject includes output_text and output_text convenience field", () => {
  const turn: TurnResult = {
    text: "OK",
    turnId: "turn_1",
    threadId: "thread_1",
    usage: null,
    durationMs: 10,
    finishReason: "stop",
  };
  const response = turnResultToResponseObject(turn, "gpt-5.5");
  assert.equal(response.status, "completed");
  assert.equal(response.output[0].content[0].text, "OK");
  assert.equal(response.output_text, "OK");
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

test("makeResponseStreamEvent includes event type in data payload", () => {
  const event = makeResponseStreamEvent("response.completed", { response: { id: "resp_1" } });
  assert.match(event, /^event: response\.completed\n/);
  assert.match(event, /"type":"response\.completed"/);
});

test("makeResponseTextDoneEvent emits Responses-compatible aliases", () => {
  const event = makeResponseTextDoneEvent(0, 0, "OK");
  assert.match(event, /^event: response\.output_text\.done\n/);
  assert.match(event, /"text":"OK"/);
  assert.match(event, /"delta":"OK"/);
});

test("turnResultToResponseObject includes Responses API token fields even without Codex usage", () => {
  const turn: TurnResult = {
    text: "OK",
    turnId: "turn_no_usage",
    threadId: "thread_1",
    usage: null,
    durationMs: 10,
    finishReason: "stop",
  };
  const response = turnResultToResponseObject(turn, "gpt-5.4-mini");
  assert.equal(response.usage?.input_tokens, 0);
  assert.equal(response.usage?.output_tokens, 0);
  assert.equal(response.usage?.total_tokens, 0);
});

test("chatRequestToOptions adds structured tool JSON instruction for explicit tool choice", () => {
  const { prompt } = chatRequestToOptions({
    model: "gpt-5.4-mini",
    messages: [{ role: "user", content: "Decide" }],
    tools: [{
      type: "function",
      function: {
        name: "Decision",
        parameters: {
          type: "object",
          properties: { rating: { type: "string" } },
          required: ["rating"],
        },
      },
    }],
    tool_choice: { type: "function", function: { name: "Decision" } },
  });
  assert.match(prompt, /Return ONLY a valid JSON object/);
  assert.match(prompt, /Decision/);
  assert.match(prompt, /rating/);
});

test("requestedFunctionTool does not force tool calls for auto or omitted tool_choice", () => {
  const req = {
    tools: [{
      type: "function" as const,
      function: { name: "Decision", parameters: { type: "object" } },
    }],
  };
  assert.equal(requestedFunctionTool(req), null);
  assert.equal(requestedFunctionTool({ ...req, tool_choice: "auto" }), null);
  assert.equal(requestedFunctionTool({ ...req, tool_choice: "none" }), null);
  assert.equal(requestedFunctionTool({ ...req, tool_choice: "required" })?.function.name, "Decision");
});


test("turnResultToToolCallChatCompletion wraps JSON as OpenAI tool_calls", () => {
  const turn: TurnResult = {
    text: "```json\n{\"rating\":\"Overweight\"}\n```",
    turnId: "turn_tool",
    threadId: "thread_1",
    usage: { inputTokens: 5, outputTokens: 3, totalTokens: 8, cachedInputTokens: 0, reasoningOutputTokens: 0 },
    durationMs: 10,
    finishReason: "stop",
  };
  const response = turnResultToToolCallChatCompletion(turn, "gpt-5.4-mini", "Decision");
  assert.equal(response.choices[0].finish_reason, "tool_calls");
  assert.equal(response.choices[0].message.content, null);
  assert.equal(response.choices[0].message.tool_calls?.[0].function.name, "Decision");
  assert.deepEqual(JSON.parse(response.choices[0].message.tool_calls?.[0].function.arguments || "{}"), { rating: "Overweight" });
});
