import assert from "node:assert/strict";
import test from "node:test";
import { chatMessagesToPrompt, chatRequestToOptions, extractProxyToolCall, extractAllProxyToolCalls, requestedFunctionTool, responsesRequestToOptions, shouldEmulateOperationalTools } from "../adapter/openai-to-codex.js";
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
  turnResultToMultiToolCallChatCompletion,
  turnResultToResponseObject,
  makeChatToolCallChunk,
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
  const { prompt, imageUrls } = responsesRequestToOptions({
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
  assert.deepEqual(imageUrls, ["https://example.com/image.png"]);
  assert.match(prompt, /\[input_file filename=brief\.pdf file_id=file_123\]/);
  assert.match(prompt, /\[input_audio format=mp3 transcript=spoken context data=present\]/);
  assert.match(prompt, /\[unsupported_content_part type=unknown_future_part\]/);
});

test("responsesRequestToOptions preserves Responses function-call context items", () => {
  const { prompt } = responsesRequestToOptions({
    model: "gpt-5.5",
    input: [
      { type: "function_call", call_id: "call_1", name: "lookup_weather", arguments: "{\"city\":\"Zurich\"}" },
      { type: "function_call_output", call_id: "call_1", output: "{\"temp\":12}" },
      { type: "reasoning", summary: [{ type: "summary_text", text: "Need the weather result." }] } as any,
      { type: "summary_text", text: "Prior context summary." },
      { type: "item_reference", item_id: "msg_old" },
      { type: "message", role: "user", content: "Now answer." },
    ],
  });

  assert.match(prompt, /<function_call name="lookup_weather" call_id="call_1">/);
  assert.match(prompt, /\{\"city\":\"Zurich\"\}/);
  assert.match(prompt, /<tool_result call_id="call_1">/);
  assert.match(prompt, /\{\"temp\":12\}/);
  assert.match(prompt, /<reasoning>\nNeed the weather result\.\n<\/reasoning>/);
  assert.match(prompt, /Prior context summary\./);
  assert.match(prompt, /Now answer\./);
  assert.match(prompt, /\[item_reference id=msg_old\]/);
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
  assert.equal(response.output[0].content[0].type, "output_text");
  assert.equal((response.output[0].content[0] as { type: "output_text"; text: string }).text, "OK");
  assert.equal(response.output_text, "OK");
});

test("turnResultToResponseObject echoes metadata and previous_response_id when provided", () => {
  const turn: TurnResult = {
    text: "OK",
    turnId: "turn_meta",
    threadId: "thread_1",
    usage: null,
    durationMs: 10,
    finishReason: "stop",
  };
  const response = turnResultToResponseObject(turn, "gpt-5.5", {
    responseId: "resp_meta",
    outputId: "msg_meta",
    metadata: { scenario: "edge" },
    previousResponseId: "resp_previous",
  });
  assert.equal(response.id, "resp_meta");
  assert.equal(response.output[0].id, "msg_meta");
  assert.deepEqual(response.metadata, { scenario: "edge" });
  assert.equal(response.previous_response_id, "resp_previous");
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

// ── Multi-tool_call tests ────────────────────────────────────────────

test("extractAllProxyToolCalls returns all valid tool calls from text with multiple bridge objects", () => {
  const req = {
    tools: [
      { type: "function" as const, function: { name: "n8n__n8n_list_workflows", parameters: { type: "object" } } },
      { type: "function" as const, function: { name: "search_web", parameters: { type: "object" } } },
    ],
  };
  const text = 'I will call two tools. {"tool_call":{"name":"n8n__n8n_list_workflows","arguments":{"limit":5}}} {"tool_call":{"name":"search_web","arguments":{"query":"hello"}}}';
  const calls = extractAllProxyToolCalls(text, req);
  assert.equal(calls.length, 2);
  assert.equal(calls[0].name, "n8n__n8n_list_workflows");
  assert.deepEqual(calls[0].arguments, { limit: 5 });
  assert.equal(calls[1].name, "search_web");
  assert.deepEqual(calls[1].arguments, { query: "hello" });
});

test("extractAllProxyToolCalls returns single-element array for one bridge object", () => {
  const req = {
    tools: [
      { type: "function" as const, function: { name: "n8n__n8n_list_workflows", parameters: { type: "object" } } },
    ],
  };
  const text = '{"tool_call":{"name":"n8n__n8n_list_workflows","arguments":{"limit":10}}}';
  const calls = extractAllProxyToolCalls(text, req);
  assert.equal(calls.length, 1);
  assert.equal(calls[0].name, "n8n__n8n_list_workflows");
});

test("extractAllProxyToolCalls returns empty array when no valid tool calls found", () => {
  const req = {
    tools: [
      { type: "function" as const, function: { name: "n8n__n8n_list_workflows", parameters: { type: "object" } } },
    ],
  };
  const text = "Just some plain text, no tools needed.";
  const calls = extractAllProxyToolCalls(text, req);
  assert.equal(calls.length, 0);
});

test("extractAllProxyToolCalls filters out tool calls with unknown names", () => {
  const req = {
    tools: [
      { type: "function" as const, function: { name: "search_web", parameters: { type: "object" } } },
    ],
  };
  const text = '{"tool_call":{"name":"evil_tool","arguments":{}}} {"tool_call":{"name":"search_web","arguments":{"q":"test"}}}';
  const calls = extractAllProxyToolCalls(text, req);
  assert.equal(calls.length, 1);
  assert.equal(calls[0].name, "search_web");
});

test("extractAllProxyToolCalls skips non-tool JSON objects interspersed with tool calls", () => {
  const req = {
    tools: [
      { type: "function" as const, function: { name: "tool_a", parameters: { type: "object" } } },
      { type: "function" as const, function: { name: "tool_b", parameters: { type: "object" } } },
    ],
  };
  const text = '{"info":"ctx"} {"tool_call":{"name":"tool_a","arguments":{"x":1}}} some prose {"data":123} {"tool_call":{"name":"tool_b","arguments":{"y":2}}}';
  const calls = extractAllProxyToolCalls(text, req);
  assert.equal(calls.length, 2);
  assert.equal(calls[0].name, "tool_a");
  assert.equal(calls[1].name, "tool_b");
});



test("makeChatToolCallChunk can stream intermediate multi-tool deltas without final finish", () => {
  const chunk = makeChatToolCallChunk(
    "stream_multi",
    "gpt-5.5",
    { id: "call_stream_multi", type: "function", function: { name: "tool_a", arguments: "{}" } },
    1,
    null,
  );
  assert.equal(chunk.choices[0].delta.tool_calls?.[0].index, 1);
  assert.equal(chunk.choices[0].finish_reason, null);
});

test("turnResultToMultiToolCallChatCompletion returns multiple tool_calls in message", () => {
  const turn: TurnResult = {
    text: '{"tool_call":{"name":"tool_a","arguments":{"x":1}}} {"tool_call":{"name":"tool_b","arguments":{"y":2}}}',
    turnId: "turn_multi",
    threadId: "thread_1",
    usage: { inputTokens: 10, outputTokens: 5, totalTokens: 15, cachedInputTokens: 0, reasoningOutputTokens: 0 },
    durationMs: 20,
    finishReason: "stop",
  };
  const toolCalls = [
    { name: "tool_a", arguments: { x: 1 } },
    { name: "tool_b", arguments: { y: 2 } },
  ];
  const response = turnResultToMultiToolCallChatCompletion(turn, "gpt-5.5", toolCalls);
  assert.equal(response.choices[0].finish_reason, "tool_calls");
  assert.equal(response.choices[0].message.content, null);
  assert.equal(response.choices[0].message.tool_calls?.length, 2);
  assert.equal(response.choices[0].message.tool_calls?.[0].function.name, "tool_a");
  assert.deepEqual(JSON.parse(response.choices[0].message.tool_calls?.[0].function.arguments || "{}"), { x: 1 });
  assert.equal(response.choices[0].message.tool_calls?.[1].function.name, "tool_b");
  assert.deepEqual(JSON.parse(response.choices[0].message.tool_calls?.[1].function.arguments || "{}"), { y: 2 });
  // Each tool_call should have a unique id
  assert.notEqual(response.choices[0].message.tool_calls?.[0].id, response.choices[0].message.tool_calls?.[1].id);
});

test("extractProxyToolCall still returns only first match (backward compat)", () => {
  const req = {
    tools: [
      { type: "function" as const, function: { name: "tool_a", parameters: { type: "object" } } },
      { type: "function" as const, function: { name: "tool_b", parameters: { type: "object" } } },
    ],
  };
  const text = '{"tool_call":{"name":"tool_a","arguments":{}}} {"tool_call":{"name":"tool_b","arguments":{}}}';
  const call = extractProxyToolCall(text, req);
  assert.equal(call?.name, "tool_a");
});

// ── Responses API edge cases ─────────────────────────────────────────

test("responsesRequestToOptions converts function_call input items to XML", () => {
  const { prompt } = responsesRequestToOptions({
    model: "gpt-5.5",
    input: [
      { type: "message", role: "user", content: "Call get_weather" },
      { type: "function_call", call_id: "call_abc", name: "get_weather", arguments: '{"city":"Paris"}' },
      { type: "function_call_output", call_id: "call_abc", output: '{"temp":22,"unit":"C"}' },
      { type: "message", role: "user", content: "Now summarize" },
    ] as any,
  });
  assert.match(prompt, /<function_call name="get_weather" call_id="call_abc">/);
  assert.match(prompt, /"city":"Paris"/);
  assert.match(prompt, /<tool_result call_id="call_abc">/);
  assert.match(prompt, /"temp":22/);
  assert.match(prompt, /Now summarize/);
});

test("responsesRequestToOptions handles function_call with id fallback for call_id", () => {
  const { prompt } = responsesRequestToOptions({
    model: "gpt-5.5",
    input: [
      { type: "function_call", id: "fc_legacy_1", name: "lookup", arguments: "{}" },
    ] as any,
  });
  assert.match(prompt, /<function_call name="lookup" call_id="fc_legacy_1">/);
});

test("responsesRequestToOptions handles reasoning input items", () => {
  const { prompt } = responsesRequestToOptions({
    model: "gpt-5.5",
    input: [
      { type: "reasoning", content: "The user probably wants X because of Y." },
      { type: "message", role: "user", content: "Continue" },
    ] as any,
  });
  assert.match(prompt, /<reasoning>/);
  assert.match(prompt, /The user probably wants X/);
  assert.match(prompt, /Continue/);
});

test("responsesRequestToOptions handles summary_text input items", () => {
  const { prompt } = responsesRequestToOptions({
    model: "gpt-5.5",
    input: [
      { type: "summary_text", text: "Previous conversation covered topics A and B." },
      { type: "message", role: "user", content: "What about C?" },
    ] as any,
  });
  assert.match(prompt, /<summary>/);
  assert.match(prompt, /Previous conversation covered topics A and B/);
  assert.match(prompt, /What about C\?/);
});

test("responsesRequestToOptions handles item_reference input items", () => {
  const { prompt } = responsesRequestToOptions({
    model: "gpt-5.5",
    input: [
      { type: "item_reference", item_id: "msg_prev_1" },
      { type: "message", role: "user", content: "Continue from there" },
    ] as any,
  });
  assert.match(prompt, /item_reference/);
  assert.match(prompt, /msg_prev_1/);
  assert.match(prompt, /Continue from there/);
});

test("turnResultToResponseObject echoes metadata and previous_response_id", () => {
  const turn: TurnResult = {
    text: "OK", turnId: "turn_meta", threadId: "thread_1",
    usage: null, durationMs: 10, finishReason: "stop",
  };
  const response = turnResultToResponseObject(turn, "gpt-5.5", {
    metadata: { session: "abc", tag: "test" },
    previousResponseId: "resp_prev_1",
  });
  assert.deepEqual(response.metadata, { session: "abc", tag: "test" });
  assert.equal(response.previous_response_id, "resp_prev_1");
});

test("turnResultToResponseObject omits metadata and previous_response_id when not provided", () => {
  const turn: TurnResult = {
    text: "OK", turnId: "turn_no_meta", threadId: "thread_1",
    usage: null, durationMs: 10, finishReason: "stop",
  };
  const response = turnResultToResponseObject(turn, "gpt-5.5");
  assert.equal("metadata" in response, false);
  assert.equal("previous_response_id" in response, false);
});

test("turnResultToResponseObject echoes null metadata", () => {
  const turn: TurnResult = {
    text: "OK", turnId: "turn_null_meta", threadId: "thread_1",
    usage: null, durationMs: 10, finishReason: "stop",
  };
  const response = turnResultToResponseObject(turn, "gpt-5.5", {
    metadata: null, previousResponseId: null,
  });
  assert.equal(response.metadata, null);
  assert.equal(response.previous_response_id, null);
});

test("responsesRequestToOptions applies response_format json_object instruction", () => {
  const { prompt } = responsesRequestToOptions({
    model: "gpt-5.5",
    input: "Return user info",
    response_format: { type: "json_object" },
  });
  assert.match(prompt, /codex_proxy_structured_output/);
  assert.match(prompt, /Return ONLY a valid JSON object/);
});

test("responsesRequestToOptions applies response_format json_schema instruction", () => {
  const { prompt } = responsesRequestToOptions({
    model: "gpt-5.5",
    input: "Return user info",
    response_format: {
      type: "json_schema",
      json_schema: {
        name: "user_info",
        schema: { type: "object", properties: { name: { type: "string" } } },
      },
    },
  });
  assert.match(prompt, /codex_proxy_structured_output/);
  assert.match(prompt, /Return ONLY a valid JSON object/);
  assert.match(prompt, /"type":"string"/);
});

test("responsesRequestToOptions does not add structured output for text response_format", () => {
  const { prompt } = responsesRequestToOptions({
    model: "gpt-5.5",
    input: "Hello",
    response_format: { type: "text" },
  });
  assert.doesNotMatch(prompt, /codex_proxy_structured_output/);
});

test("responsesRequestToOptions does not add structured output when response_format is absent", () => {
  const { prompt } = responsesRequestToOptions({
    model: "gpt-5.5",
    input: "Hello",
  });
  assert.doesNotMatch(prompt, /codex_proxy_structured_output/);
});

test("responsesRequestToOptions passes refusal content parts through in assistant messages", () => {
  const { prompt } = responsesRequestToOptions({
    model: "gpt-5.5",
    input: [{
      type: "message",
      role: "assistant",
      content: [{ type: "refusal", refusal: "I cannot assist with that request." }],
    }] as any,
  });
  assert.match(prompt, /\[refusal\] I cannot assist with that request\./);
});

test("responsesRequestToOptions preserves unknown future input items as bounded markers", () => {
  const { prompt } = responsesRequestToOptions({
    model: "gpt-5.5",
    input: [
      { type: "future_context_blob", id: "ctx_1", payload: { hidden: true } },
      { type: "message", role: "user", content: "Continue safely." },
    ] as any,
  });
  assert.match(prompt, /\[unsupported_input_item type=future_context_blob\]/);
  assert.match(prompt, /Continue safely\./);
});

// ── ResponseObject instructions/temperature/top_p echo ──────────────

test("turnResultToResponseObject echoes instructions, temperature, and top_p", () => {
  const turn: TurnResult = {
    text: "OK", turnId: "turn_echo_full", threadId: "thread_1",
    usage: null, durationMs: 10, finishReason: "stop",
  };
  const response = turnResultToResponseObject(turn, "gpt-5.5", {
    instructions: "Be concise and accurate",
    temperature: 0.7,
    topP: 0.95,
    metadata: { tag: "test" },
    previousResponseId: "resp_prev_42",
  });
  assert.equal(response.instructions, "Be concise and accurate");
  assert.equal(response.temperature, 0.7);
  assert.equal(response.top_p, 0.95);
  assert.deepEqual(response.metadata, { tag: "test" });
  assert.equal(response.previous_response_id, "resp_prev_42");
});

test("turnResultToResponseObject omits instructions/temperature/top_p when not provided", () => {
  const turn: TurnResult = {
    text: "OK", turnId: "turn_omit_opts", threadId: "thread_1",
    usage: null, durationMs: 10, finishReason: "stop",
  };
  const response = turnResultToResponseObject(turn, "gpt-5.5");
  assert.equal("instructions" in response, false);
  assert.equal("temperature" in response, false);
  assert.equal("top_p" in response, false);
});

// ── Reasoning with content parts array ──────────────────────────────

test("responsesRequestToOptions handles reasoning with content parts array", () => {
  const { prompt } = responsesRequestToOptions({
    model: "gpt-5.5",
    input: [
      {
        type: "reasoning",
        content: [
          { type: "text", text: "Step 1: identify the query." },
          { type: "text", text: "Step 2: formulate response." },
        ],
      },
      { type: "message", role: "user", content: "Go ahead" },
    ] as any,
  });
  assert.match(prompt, /<reasoning>/);
  assert.match(prompt, /Step 1: identify the query\./);
  assert.match(prompt, /Step 2: formulate response\./);
  assert.match(prompt, /Go ahead/);
});

// ── Full multi-turn tool-use conversation ────────────────────────────

test("responsesRequestToOptions handles full multi-turn tool-use conversation", () => {
  const { prompt } = responsesRequestToOptions({
    model: "gpt-5.5",
    input: [
      { type: "message", role: "system", content: "You are a helpful assistant." },
      { type: "message", role: "user", content: "What is the weather in Paris?" },
      { type: "function_call", call_id: "call_001", name: "get_weather", arguments: '{"location":"Paris"}' },
      { type: "function_call_output", call_id: "call_001", output: '{"temp":18,"condition":"cloudy"}' },
      { type: "message", role: "assistant", content: "The weather in Paris is 18C and cloudy." },
      { type: "message", role: "user", content: "And in London?" },
    ] as any,
  });
  assert.match(prompt, /<system>\nYou are a helpful assistant\.\n<\/system>/);
  assert.match(prompt, /What is the weather in Paris\?/);
  assert.match(prompt, /<function_call name="get_weather" call_id="call_001">/);
  assert.match(prompt, /<tool_result call_id="call_001">/);
  assert.match(prompt, /<previous_response>\nThe weather in Paris is 18C and cloudy\.\n<\/previous_response>/);
  assert.match(prompt, /And in London\?/);
});

// ── summary_text content parts inside reasoning ─────────────────────

test("responsesRequestToOptions handles reasoning with summary_text content parts", () => {
  const { prompt } = responsesRequestToOptions({
    model: "gpt-5.5",
    input: [
      {
        type: "reasoning",
        summary: [
          { type: "summary_text", text: "The user needs a weather forecast for multiple cities." },
        ],
      },
      { type: "message", role: "user", content: "Continue" },
    ] as any,
  });
  assert.match(prompt, /<reasoning>/);
  assert.match(prompt, /weather forecast for multiple cities/);
});
