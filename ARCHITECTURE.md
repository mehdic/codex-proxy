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
- `src/subprocess/pool.ts` — bounded warm worker pool for initialized stdio app-server processes.
- `src/subprocess/runtime.ts` — resolves `pool` vs `oneshot` runtime, with env-gated header override.
- `src/subprocess/fallback.ts` — classifies pool transport failures that can safely retry through one-shot before response commit.
- `src/types/*` — small typed subset of OpenAI and Codex app-server protocol shapes.

## Runtime model

Default runtime is `pool`:

1. Spawn `codex app-server --listen stdio://`.
2. Send `initialize`.
3. Send `initialized`.
4. Keep the initialized worker idle in a bounded pool keyed by model/cwd/instruction fingerprint.
5. For each request, lease one worker and call `thread/start` with `ephemeral: true`.
6. Call `turn/start` with flattened user input.
7. Collect `item/agentMessage/delta` notifications.
8. Finish on `turn/completed`.
9. Return the worker to the pool, or kill it on failure/TTL/LRU eviction.

`CODEX_PROXY_RUNTIME=oneshot` preserves the original behavior: spawn, initialize, run one ephemeral thread, then kill the child process.

## Pool safety

- The pool reuses only app-server processes. It does not persist client prompts or Codex threads.
- Pool keys use bounded hashes for cwd/instructions/config overrides; raw prompts and instructions are not used as logs or metrics labels.
- `CODEX_PROXY_POOL_MAX` caps total live workers. Extra requests wait for a lease.
- Idle workers are evicted by TTL and LRU.
- Eligible pool transport failures retry once through `oneshot` only before the HTTP response is committed.
- Streaming failures after headers/body bytes are committed emit an SSE error event and close.

## Streaming

Streaming endpoints send SSE comment keepalives (`:ok\n\n`) after `CODEX_PROXY_KEEPALIVE_MS` of output silence. These are not OpenAI data events and should not affect final assistant text.
