# Architecture

`codex-proxy` is a local compatibility bridge:

```text
Client -> HTTP OpenAI-compatible API -> codex-proxy -> stdio JSON-RPC -> codex app-server -> Codex auth/session
```

## Components

- `src/server/*` — Express app, routes, standalone entrypoint, metrics.
- `src/adapter/openai-to-codex.ts` — flattens OpenAI chat/responses requests into Codex turn input and options.
- `src/adapter/codex-to-openai.ts` — maps Codex turn results and deltas into OpenAI response/chunk shapes.
- `src/subprocess/manager.ts` — owns the `codex app-server` child process and JSON-RPC lifecycle.
- `src/types/*` — small typed subset of OpenAI and Codex app-server protocol shapes.

## Runtime model

The MVP is one-shot per request:

1. Spawn `codex app-server --listen stdio://`.
2. Send `initialize`.
3. Send `initialized`.
4. Call `thread/start` with `ephemeral: true`.
5. Call `turn/start` with flattened user input.
6. Collect `item/agentMessage/delta` notifications.
7. Finish on `turn/completed`.
8. Kill the child process.

This is slower than a pool, but clean and safe: no shared mutable session state, no token copying, and fewer lifecycle edge cases.

## Future persistent mode

A later version can add a session/pool layer similar to `claude-proxy`:

- warm app-server workers
- thread mapping by client/session id
- idle TTL eviction
- fallback to one-shot on worker failure

The current `CodexSubprocess` interface is deliberately small so that pool can wrap it later.
