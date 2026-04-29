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
- `src/subprocess/session-pool.ts` — disabled-by-default session/thread pool for explicit client session ids.
- `src/subprocess/runtime.ts` — resolves `pool` vs `oneshot` runtime and opt-in session headers.
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

Opt-in session runtime:

1. `CODEX_PROXY_SESSIONS=1` must be set.
2. The request must include a valid `X-Codex-Proxy-Session` header.
3. The session key is the sanitized session id plus model, cwd hash, and instruction/config fingerprint.
4. The session pool starts one app-server worker and one Codex thread for the key.
5. Sequential requests reuse that thread with `turn/start`.
6. Concurrent requests for the same session are serialized through a FIFO promise chain.
7. Expired and LRU sessions are evicted and their workers are killed.
8. Session turns do not use pool-to-oneshot fallback.

## Pool safety

- The pool reuses only app-server processes. It does not persist client prompts or Codex threads.
- Pool keys use bounded hashes for cwd/instructions/config overrides; raw prompts and instructions are not used as logs or metrics labels.
- `CODEX_PROXY_POOL_MAX` caps total live workers. Extra requests wait for a lease.
- Idle workers are evicted by TTL and LRU.
- Eligible pool transport failures retry once through `oneshot` only before the HTTP response is committed.
- Streaming failures after headers/body bytes are committed emit an SSE error event and close.

## Session safety

- Sessions are disabled by default.
- Session ids are accepted only as `[A-Za-z0-9._:-]`, up to 128 characters.
- `CODEX_PROXY_SESSION_TTL_MS` and `CODEX_PROXY_SESSION_MAX` bound retention and process count.
- Session metrics use fixed event labels only; session ids are not labels.
- Raw prompts, raw instructions, and raw cwd values are not logged or included in metrics labels.
- A failed, aborted, expired, or evicted session kills its app-server worker instead of silently continuing on another thread.

## Streaming

Streaming endpoints send SSE comment keepalives (`:ok\n\n`) after `CODEX_PROXY_KEEPALIVE_MS` of output silence. These are not OpenAI data events and should not affect final assistant text.
