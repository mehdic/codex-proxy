# Protocol mapping

## Chat completions

Client request:

```http
POST /v1/chat/completions
```

The proxy converts `messages[]` into:

- first `system`/`developer` message -> Codex `baseInstructions`
- `assistant` messages -> `<previous_response>` blocks
- `user` messages -> prompt text

Then it sends Codex app-server JSON-RPC:

```json
{ "method": "initialize", "id": 1, "params": { "clientInfo": { "name": "codex-proxy" } } }
{ "method": "initialized", "params": {} }
{ "method": "thread/start", "id": 2, "params": { "model": "gpt-5.5", "ephemeral": true } }
{ "method": "turn/start", "id": 3, "params": { "threadId": "...", "input": [{ "type": "text", "text": "..." }] } }
```

In `pool` runtime, `initialize` and `initialized` happen once per app-server worker. `thread/start` and `turn/start` still happen per request with `ephemeral: true`.

In opt-in session mode (`CODEX_PROXY_SESSIONS=1` and a valid `X-Codex-Proxy-Session` header), `initialize`, `initialized`, and `thread/start` happen once per session key. Later sequential requests for that same sanitized session id, model, cwd hash, and instruction/config fingerprint call `turn/start` on the stored thread id. Session workers are killed on TTL/LRU eviction, abort, or failure.

Deltas from `item/agentMessage/delta` become OpenAI streaming chunks:

```text
data: {"object":"chat.completion.chunk", ...}
```

`turn/completed` emits the final stop chunk and `[DONE]`.

Streaming endpoints may include SSE comment keepalives:

```text
:ok

```

These comments do not carry JSON data and should be ignored by SSE clients.

## Responses

`/v1/responses` accepts text input or a minimal input item array. It maps the final Codex turn to:

```json
{
  "object": "response",
  "status": "completed",
  "output": [{ "type": "message", "content": [{ "type": "output_text", "text": "..." }] }]
}
```

Streaming emits minimal Responses-style event names:

- `response.created`
- `response.in_progress`
- `response.output_item.added`
- `response.content_part.added`
- `response.output_text.delta`
- `response.output_text.done`
- `response.content_part.done`
- `response.output_item.done`
- `response.completed`

`response.completed` reuses the same response id emitted by `response.created`. Text-only streams include both `text` and a compatibility `delta` alias on `response.output_text.done`.

## Usage and cache signals

Codex app-server emits official token usage updates through `thread/tokenUsage/updated`. The proxy maps the latest turn usage into OpenAI-compatible response fields.

For Chat Completions, `usage` includes:

- `prompt_tokens`
- `completion_tokens`
- `total_tokens`
- `prompt_tokens_details.cached_tokens` from Codex `cachedInputTokens`
- `completion_tokens_details.reasoning_tokens` from Codex `reasoningOutputTokens`

For Responses, `usage` includes:

- `input_tokens`
- `output_tokens`
- `total_tokens`
- `input_tokens_details.cached_tokens` from Codex `cachedInputTokens`
- `output_tokens_details.reasoning_tokens` from Codex `reasoningOutputTokens`

Codex currently does not expose Claude-style prompt cache creation/write token counts through app-server. Treat cached and reasoning token details as upstream-reported accounting, not independently verified billing data.

## Transport

Only stdio is used. Codex WebSocket app-server transport is intentionally avoided because upstream documents it as experimental/unsupported.
