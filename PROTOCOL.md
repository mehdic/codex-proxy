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

## Transport

Only stdio is used. Codex WebSocket app-server transport is intentionally avoided because upstream documents it as experimental/unsupported.
