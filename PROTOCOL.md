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

Deltas from `item/agentMessage/delta` become OpenAI streaming chunks:

```text
data: {"object":"chat.completion.chunk", ...}
```

`turn/completed` emits the final stop chunk and `[DONE]`.

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
- `response.output_item.added`
- `response.output_text.delta`
- `response.output_text.done`
- `response.output_item.done`
- `response.completed`

## Transport

Only stdio is used. Codex WebSocket app-server transport is intentionally avoided because upstream documents it as experimental/unsupported.
