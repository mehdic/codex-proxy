import assert from "node:assert/strict";
import test from "node:test";
import { chatMessagesToPrompt, chatRequestToOptions, extractProxyToolCall, requestedFunctionTool, responsesRequestToOptions, shouldEmulateOperationalTools } from "../adapter/openai-to-codex.js";
import {
  appendAssistantText,
  extractDeltaText,
  makeResponseStreamEvent,
  makeResponseTextDeltaEvent,
  makeResponseTextDoneEvent,
  makeResponseDoneEvent,
  turnResultToChatCompletion,
  turnResultToToolCallChatCompletion,
  turnResultToSpecificToolCallChatCompletion,
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


test("chatMessagesToPrompt preserves tool results for follow-up turns", () => {
  const converted = chatMessagesToPrompt([
    { role: "user", content: "List n8n workflows" },
    { role: "assistant", content: null, tool_calls: [{ id: "call_1", type: "function", function: { name: "n8n__n8n_list_workflows", arguments: "{\"limit\":100}" } }] },
    { role: "tool", tool_call_id: "call_1", name: "n8n__n8n_list_workflows", content: "{\"success\":true,\"data\":{\"returned\":41}}" },
  ]);
  assert.match(converted.prompt, /<tool_result name="n8n__n8n_list_workflows" tool_call_id="call_1">/);
  assert.match(converted.prompt, /returned/);
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

test("responsesRequestToOptions flattens mixed Responses content parts", () => {
  const { prompt } = responsesRequestToOptions({
    model: "gpt-5.5",
    input: [{
      type: "message",
      role: "user",
      content: [
        { type: "input_text", text: "Describe these artifacts." },
        { type: "input_image", image_url: "https://example.com/image.png", detail: "high" },
        { type: "input_file", filename: "brief.pdf", file_id: "file_123" },
        { type: "input_audio", input_audio: { format: "mp3", data: "BASE64_AUDIO" }, transcript: "spoken context" } as any,
        { type: "unknown_future_part", foo: "bar" } as any,
      ],
    }],
  });

  assert.match(prompt, /Describe these artifacts\./);
  assert.match(prompt, /\[input_image url=https:\/\/example\.com\/image\.png detail=high\]/);
  assert.match(prompt, /\[input_file filename=brief\.pdf file_id=file_123\]/);
  assert.match(prompt, /\[input_audio format=mp3 transcript=spoken context data=present\]/);
  assert.match(prompt, /\[unsupported_content_part type=unknown_future_part\]/);
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

test("turnResultToChatCompletion returns OpenAI-compatible response with token details", () => {
  const turn: TurnResult = {
    text: "OK",
    turnId: "turn_1",
    threadId: "thread_1",
    usage: { inputTokens: 8, outputTokens: 3, totalTokens: 11, cachedInputTokens: 5, reasoningOutputTokens: 2 },
    durationMs: 10,
    finishReason: "stop",
  };
  const response = turnResultToChatCompletion(turn, "gpt-5.5");
  assert.equal(response.object, "chat.completion");
  assert.equal(response.choices[0].message.content, "OK");
  assert.equal(response.usage?.prompt_tokens, 8);
  assert.equal(response.usage?.completion_tokens, 3);
  assert.equal(response.usage?.total_tokens, 11);
  assert.equal(response.usage?.prompt_tokens_details?.cached_tokens, 5);
  assert.equal(response.usage?.completion_tokens_details?.reasoning_tokens, 2);
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

test("Responses streaming helpers emit SDK-friendly ids and done alias", () => {
  const delta = makeResponseTextDeltaEvent(0, 0, "O", { responseId: "resp_1", itemId: "msg_1" });
  assert.match(delta, /^event: response\.output_text\.delta\n/);
  assert.match(delta, /"response_id":"resp_1"/);
  assert.match(delta, /"item_id":"msg_1"/);
  assert.match(delta, /"delta":"O"/);

  const doneText = makeResponseTextDoneEvent(0, 0, "OK", { responseId: "resp_1", itemId: "msg_1" });
  assert.match(doneText, /"response_id":"resp_1"/);
  assert.match(doneText, /"item_id":"msg_1"/);
  assert.match(doneText, /"text":"OK"/);

  const responseDone = makeResponseDoneEvent(turnResultToResponseObject({
    text: "OK",
    turnId: "turn_1",
    threadId: "thread_1",
    usage: null,
    durationMs: 1,
    finishReason: "stop",
  }, "gpt-5.5", { responseId: "resp_1", outputId: "msg_1" }));
  assert.match(responseDone, /^event: response\.done\n/);
  assert.match(responseDone, /"type":"response.done"/);
  assert.match(responseDone, /"id":"resp_1"/);
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

test("turnResultToChatCompletion includes token detail fields even without Codex usage", () => {
  const turn: TurnResult = {
    text: "OK",
    turnId: "turn_no_usage",
    threadId: "thread_1",
    usage: null,
    durationMs: 10,
    finishReason: "stop",
  };
  const response = turnResultToChatCompletion(turn, "gpt-5.4-mini");
  assert.equal(response.usage?.prompt_tokens, 0);
  assert.equal(response.usage?.completion_tokens, 0);
  assert.equal(response.usage?.total_tokens, 0);
  assert.equal(response.usage?.prompt_tokens_details?.cached_tokens, 0);
  assert.equal(response.usage?.completion_tokens_details?.reasoning_tokens, 0);
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

test("requestedFunctionTool forces single schema-style structured output but not operational tools", () => {
  const schemaReq = {
    tools: [{
      type: "function" as const,
      function: { name: "Decision", parameters: { type: "object" } },
    }],
  };
  assert.equal(requestedFunctionTool(schemaReq)?.function.name, "Decision");
  assert.equal(requestedFunctionTool({ ...schemaReq, tool_choice: "auto" })?.function.name, "Decision");
  assert.equal(requestedFunctionTool({ ...schemaReq, tool_choice: "none" }), null);
  assert.equal(requestedFunctionTool({ ...schemaReq, tool_choice: "required" })?.function.name, "Decision");

  const operationalReq = {
    tools: [{
      type: "function" as const,
      function: { name: "get_stock_data", parameters: { type: "object" } },
    }],
  };
  assert.equal(requestedFunctionTool(operationalReq), null);
});



test("chatRequestToOptions adds operational tool bridge instructions", () => {
  const { prompt } = chatRequestToOptions({
    model: "gpt-5.4-mini",
    messages: [{ role: "user", content: "List n8n workflows" }],
    tools: [{
      type: "function",
      function: {
        name: "n8n__n8n_list_workflows",
        description: "List workflows",
        parameters: { type: "object", properties: { limit: { type: "number" } } },
      },
    }],
  });
  assert.match(prompt, /codex_proxy_openai_tools/);
  assert.match(prompt, /n8n__n8n_list_workflows/);
  assert.match(prompt, /"tool_call"/);
  // Composability: bridge describes external caller-dispatched tools without suppressing Codex native capabilities.
  assert.match(prompt, /external tool/i);
  assert.match(prompt, /native Codex capabilities/i);
  assert.match(prompt, /in addition to your native Codex capabilities/i);
  assert.match(prompt, /Do not treat this bridge as replacing or disabling Codex-native tools\/capabilities/i);
  assert.doesNotMatch(prompt, /You cannot execute tools yourself/);
});

test("operational tool bridge preserves Codex native capability composability", () => {
  const { prompt } = chatRequestToOptions({
    model: "gpt-5.5",
    messages: [{ role: "user", content: "Read my file and then call n8n" }],
    tools: [
      { type: "function", function: { name: "n8n__n8n_list_workflows", description: "List workflows", parameters: { type: "object" } } },
      { type: "function", function: { name: "search_web", description: "Search the web", parameters: { type: "object" } } },
    ],
  });
  // Should list tools as external
  assert.match(prompt, /External tools:/);
  // Should explicitly preserve and combine the model's own Codex capabilities with caller-dispatched tools.
  assert.match(prompt, /in addition to your native Codex capabilities/);
  assert.match(prompt, /replacing or disabling Codex-native tools\/capabilities/);
  // Should still tell model to use JSON shape for external tools.
  assert.match(prompt, /dispatched by the caller/);
});

test("extractProxyToolCall parses operational tool bridge JSON", () => {
  const req = {
    tools: [{
      type: "function" as const,
      function: { name: "n8n__n8n_list_workflows", parameters: { type: "object" } },
    }],
  };
  assert.equal(shouldEmulateOperationalTools(req), true);
  const call = extractProxyToolCall('{"tool_call":{"name":"n8n__n8n_list_workflows","arguments":{"limit":100}}}', req);
  assert.equal(call?.name, "n8n__n8n_list_workflows");
  assert.deepEqual(call?.arguments, { limit: 100 });
  assert.equal(extractProxyToolCall('{"tool_call":{"name":"evil","arguments":{}}}', req), null);
});

test("extractProxyToolCall handles prose-prefixed tool_call JSON", () => {
  const req = {
    tools: [{
      type: "function" as const,
      function: { name: "n8n__n8n_list_workflows", parameters: { type: "object" } },
    }],
  };
  const text = 'I\'m going to use the n8n tool to list your workflows. {"tool_call":{"name":"n8n__n8n_list_workflows","arguments":{"limit":5}}}';
  const call = extractProxyToolCall(text, req);
  assert.equal(call?.name, "n8n__n8n_list_workflows");
  assert.deepEqual(call?.arguments, { limit: 5 });
});

test("extractProxyToolCall handles duplicate adjacent tool_call JSON objects", () => {
  const req = {
    tools: [
      { type: "function" as const, function: { name: "n8n__n8n_list_workflows", parameters: { type: "object" } } },
      { type: "function" as const, function: { name: "n8n__n8n_get_workflow", parameters: { type: "object" } } },
    ],
  };
  // Model returned prose + two JSON objects back to back
  const text = 'I\'m using the tools now. {"tool_call":{"name":"n8n__n8n_list_workflows","arguments":{"limit":5}}}{"tool_call":{"name":"n8n__n8n_get_workflow","arguments":{"id":42}}}';
  const call = extractProxyToolCall(text, req);
  // Should extract the first valid one
  assert.equal(call?.name, "n8n__n8n_list_workflows");
  assert.deepEqual(call?.arguments, { limit: 5 });
});

test("extractProxyToolCall skips non-tool JSON objects in prose", () => {
  const req = {
    tools: [{
      type: "function" as const,
      function: { name: "n8n__n8n_list_workflows", parameters: { type: "object" } },
    }],
  };
  // First JSON object is not a tool_call, second one is
  const text = 'Here is some context {"info":"stuff"} and now {"tool_call":{"name":"n8n__n8n_list_workflows","arguments":{"limit":10}}}';
  const call = extractProxyToolCall(text, req);
  assert.equal(call?.name, "n8n__n8n_list_workflows");
  assert.deepEqual(call?.arguments, { limit: 10 });
});

test("extractProxyToolCall still works with code-fenced JSON", () => {
  const req = {
    tools: [{
      type: "function" as const,
      function: { name: "n8n__n8n_list_workflows", parameters: { type: "object" } },
    }],
  };
  const text = '```json\n{"tool_call":{"name":"n8n__n8n_list_workflows","arguments":{"limit":3}}}\n```';
  const call = extractProxyToolCall(text, req);
  assert.equal(call?.name, "n8n__n8n_list_workflows");
  assert.deepEqual(call?.arguments, { limit: 3 });
});

test("turnResultToSpecificToolCallChatCompletion wraps explicit operational tool args", () => {
  const turn: TurnResult = {
    text: '{"tool_call":{"name":"n8n__n8n_list_workflows","arguments":{"limit":100}}}',
    turnId: "turn_operational_tool",
    threadId: "thread_1",
    usage: null,
    durationMs: 10,
    finishReason: "stop",
  };
  const response = turnResultToSpecificToolCallChatCompletion(turn, "gpt-5.4-mini", "n8n__n8n_list_workflows", { limit: 100 });
  assert.equal(response.choices[0].finish_reason, "tool_calls");
  assert.equal(response.choices[0].message.tool_calls?.[0].function.name, "n8n__n8n_list_workflows");
  assert.deepEqual(JSON.parse(response.choices[0].message.tool_calls?.[0].function.arguments || "{}"), { limit: 100 });
});

test("turnResultToToolCallChatCompletion wraps JSON as OpenAI tool_calls", () => {
  const turn: TurnResult = {
    text: "```json\n{\"rating\":\"Overweight\"}\n```",
    turnId: "turn_tool",
    threadId: "thread_1",
    usage: { inputTokens: 5, outputTokens: 3, totalTokens: 8, cachedInputTokens: 4, reasoningOutputTokens: 2 },
    durationMs: 10,
    finishReason: "stop",
  };
  const response = turnResultToToolCallChatCompletion(turn, "gpt-5.4-mini", "Decision");
  assert.equal(response.choices[0].finish_reason, "tool_calls");
  assert.equal(response.choices[0].message.content, null);
  assert.equal(response.choices[0].message.tool_calls?.[0].function.name, "Decision");
  assert.deepEqual(JSON.parse(response.choices[0].message.tool_calls?.[0].function.arguments || "{}"), { rating: "Overweight" });
  assert.equal(response.usage?.prompt_tokens_details?.cached_tokens, 4);
  assert.equal(response.usage?.completion_tokens_details?.reasoning_tokens, 2);
});
