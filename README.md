# codex-proxy

**Use your ChatGPT/Codex subscription through a local OpenAI-compatible API without copying Codex OAuth tokens into another app.**

`codex-proxy` wraps the official `codex app-server` over stdio JSON-RPC and exposes a small localhost HTTP API compatible with OpenAI-style clients.

```text
OpenAI-compatible client
        │ HTTP /v1/chat/completions or /v1/responses
        ▼
codex-proxy 127.0.0.1:3466
        │ stdio JSON-RPC
        ▼
codex app-server
        │ official Codex auth/session
        ▼
ChatGPT/Codex entitlement
```

This follows the same philosophy as [`claude-proxy`](https://github.com/mehdic/claude-proxy): delegate authentication to the official CLI instead of storing subscription tokens in a proxy database.

## Status

v0.4 local proxy. Working locally with:

- non-streaming `/v1/chat/completions`
- streaming `/v1/chat/completions`
- minimal `/v1/responses`
- minimal streaming `/v1/responses`
- `/v1/models`
- `/health`
- `/healthz/deep`
- `/version`
- `/metrics`
- app-server stdio transport
- pooled persistent `codex app-server` workers with one ephemeral thread per request
- opt-in, TTL-limited Codex session/thread pooling
- one-shot fallback mode
- SSE keepalive comments for streaming clients with writable-guard hardening
- env-gated localhost CORS

The implementation intentionally avoids the experimental Codex WebSocket transport.

## Prerequisites

1. Node.js 20+
2. Codex CLI installed and authenticated:

```bash
npm install -g @openai/codex
codex login
codex exec "Reply OK only."
```

## Install and run

```bash
git clone https://github.com/mehdic/codex-proxy.git
cd codex-proxy
npm install
npm run build
npm start
```

Default bind: `127.0.0.1:3466`.

Override port:

```bash
CODEX_PROXY_PORT=3470 npm start
# or
node dist/server/standalone.js 3470
```

The standalone server handles `SIGINT` and `SIGTERM` by closing the HTTP server with a configurable grace period (`CODEX_PROXY_SHUTDOWN_GRACE_MS`, default `10000`).

## Runtime modes

`codex-proxy` supports two Codex app-server runtime modes:

- `pool` (default): keeps warm persistent `codex app-server --listen stdio://` workers and reuses each worker across sequential requests. Every request still starts a fresh ephemeral Codex thread.
- `oneshot`: starts a fresh app-server process per request, matching the original v0.2 behavior.

Configure the default with:

```bash
CODEX_PROXY_RUNTIME=pool npm start
CODEX_PROXY_RUNTIME=oneshot npm start
```

Per-request runtime override is ignored unless explicitly enabled:

```bash
CODEX_PROXY_ALLOW_RUNTIME_OVERRIDE=1 npm start
curl -H 'X-Codex-Proxy-Runtime: oneshot' ...
```

Pool controls:

- `CODEX_PROXY_POOL_MAX` default `2`: maximum live app-server workers.
- `CODEX_PROXY_POOL_TTL_MS` default `600000`: idle worker TTL.
- `CODEX_PROXY_PREWARM_MODELS` default `gpt-5.5,gpt-5.4-mini`: models to prewarm at startup.
- `CODEX_PROXY_INIT_POOL=0`: disables startup prewarm.
- `CODEX_PROXY_FALLBACK_ON_POOL_FAILURE=0`: disables retrying eligible pool transport failures with one-shot before any HTTP response is committed.

## Opt-in sessions

Default behavior is stateless at the Codex thread layer. A client gets Codex thread reuse only when both conditions are true:

1. The server is started with `CODEX_PROXY_SESSIONS=1`.
2. The request includes `X-Codex-Proxy-Session: <id>`.

Session ids must match `[A-Za-z0-9._:-]` and be at most 128 characters. Invalid explicit session headers return a 400 OpenAI-style `invalid_request_error`.

When enabled and requested, the proxy keeps one initialized `codex app-server --listen stdio://` worker and one Codex thread for sequential requests with the same session id, model, cwd hash, and instruction/config fingerprint. Concurrent requests for the same session are serialized. Sessions are evicted by TTL and LRU, and their app-server worker is killed on eviction, client abort, or turn failure. Session requests do not fallback to another worker because that would break thread continuity.

Session controls:

- `CODEX_PROXY_SESSIONS=1`: enables explicit session pooling. Default `0`.
- `CODEX_PROXY_SESSION_TTL_MS` default `600000`: idle session TTL.
- `CODEX_PROXY_SESSION_MAX` default `32`: maximum active session/thread workers.

Session ids are never used as metric labels. Prompts, raw instructions, and raw cwd values are not used in logs, metrics labels, or pool/session keys.

Streaming responses send SSE comment keepalives (`:ok\n\n`) when idle. Configure with `CODEX_PROXY_KEEPALIVE_MS`, default `10000`; set `0` to disable. Comments do not create OpenAI data events and are intended only to keep compatible clients and intermediaries from timing out.

All streaming writes (keepalive, delta, finish, error) are guarded against writing to a closed or ended response stream. When a client disconnects mid-stream, the proxy silently drops remaining writes instead of crashing with EPIPE or ERR_STREAM_WRITE_AFTER_END. Client-close cancellation (`client_closed`) errors are suppressed in both streaming error handlers to avoid emitting invalid SSE error events to a dead connection.

## Smoke tests

```bash
npm run smoke
```

The smoke script uses localhost only and checks `/health`, `/v1/models`, one non-streaming chat request, and one streaming chat request. It requires a running proxy and an authenticated Codex CLI session.

## Endpoints

| Endpoint | Method | Description |
|---|---:|---|
| `/health` | GET | Cheap liveness probe with version and uptime |
| `/version` | GET | Package name and runtime version |
| `/healthz/deep` | GET | Starts Codex and runs a tiny turn with `CODEX_PROXY_HEALTH_MODEL` or the default model |
| `/metrics` | GET | Prometheus-style metrics |
| `/models`, `/v1/models` | GET | OpenAI model list |
| `/chat/completions`, `/v1/chat/completions` | POST | OpenAI chat-completions-compatible API |
| `/responses`, `/v1/responses` | POST | Minimal OpenAI Responses-style API |

Use `/health` for frequent process checks. Use `/healthz/deep` for readiness diagnostics because it starts `codex app-server` and consumes a small live turn.

## Usage metadata

Codex app-server reports latest-turn usage through official `thread/tokenUsage/updated` notifications. The proxy maps those values into OpenAI-compatible fields:

- Chat Completions: `prompt_tokens`, `completion_tokens`, `total_tokens`, `prompt_tokens_details.cached_tokens`, and `completion_tokens_details.reasoning_tokens`.
- Responses: `input_tokens`, `output_tokens`, `total_tokens`, `input_tokens_details.cached_tokens`, and `output_tokens_details.reasoning_tokens`.

Codex does not currently expose Claude-style prompt cache creation/write token counts through app-server, so `cacheWrite`-style accounting is not available here.

## Models

The proxy passes model names to Codex app-server. Current default is `gpt-5.5`.

Advertised models:

- `gpt-5.5`
- `gpt-5.4`
- `gpt-5.4-mini`
- `gpt-5.3-codex`
- `gpt-5.3-codex-spark`
- `gpt-5.2`

## OpenClaw example

```jsonc
{
  "models": {
    "providers": {
      "codex-proxy": {
        "baseUrl": "http://127.0.0.1:3466/v1",
        "apiKey": "local",
        "api": "openai-completions",
        "authHeader": false,
        "models": [
          {
            "id": "gpt-5.5",
            "name": "Codex GPT-5.5 via codex-proxy",
            "api": "openai-completions",
            "reasoning": true,
            "input": ["text"],
            "cost": { "input": 0, "output": 0, "cacheRead": 0, "cacheWrite": 0 },
            "contextWindow": 272000,
            "maxTokens": 65536
          }
        ]
      }
    }
  }
}
```

More detail: [docs/openclaw.md](docs/openclaw.md).

## Environment variables

| Variable | Default | Effect |
|---|---:|---|
| `CODEX_PROXY_PORT` | `3466` | HTTP port |
| `CODEX_PROXY_HOST` | `127.0.0.1` | HTTP bind host. Keep localhost unless you really know what you are doing. |
| `CODEX_PROXY_MAX_BODY` | `8mb` | JSON body limit |
| `CODEX_PROXY_DEFAULT_MODEL` | `gpt-5.5` | Default model when client omits one |
| `CODEX_PROXY_RUNTIME` | `pool` | `pool` or `oneshot` app-server runtime |
| `CODEX_PROXY_ALLOW_RUNTIME_OVERRIDE` | unset | Set `1` to honor `X-Codex-Proxy-Runtime` |
| `CODEX_PROXY_POOL_MAX` | `2` | Maximum live pooled app-server workers |
| `CODEX_PROXY_POOL_TTL_MS` | `600000` | Idle worker TTL |
| `CODEX_PROXY_PREWARM_MODELS` | `gpt-5.5,gpt-5.4-mini` | Comma-separated startup prewarm models |
| `CODEX_PROXY_INIT_POOL` | enabled | Set `0` to disable startup prewarm |
| `CODEX_PROXY_FALLBACK_ON_POOL_FAILURE` | enabled | Set `0` to disable pool-to-oneshot retry before response commit |
| `CODEX_PROXY_KEEPALIVE_MS` | `10000` | SSE comment keepalive interval; `0` disables |
| `CODEX_PROXY_SESSIONS` | `0` | Set `1` to enable explicit `X-Codex-Proxy-Session` thread reuse |
| `CODEX_PROXY_SESSION_TTL_MS` | `600000` | Idle opt-in session TTL |
| `CODEX_PROXY_SESSION_MAX` | `32` | Maximum active opt-in sessions |
| `CODEX_PROXY_CODEX_BIN` | `codex` | Codex binary path |
| `CODEX_PROXY_HEALTH_MODEL` | default model | Model for `/healthz/deep` |
| `CODEX_PROXY_HEALTH_TIMEOUT_MS` | `30000` | Deep health timeout |
| `CODEX_PROXY_SHUTDOWN_GRACE_MS` | `10000` | Grace period for SIGINT/SIGTERM shutdown |
| `CODEX_PROXY_CORS` | unset | Set `1` to allow localhost browser origins |
| `DEBUG` | unset | Logs app-server stderr snippets for debugging |

## Operational docs

- [macOS LaunchAgent](docs/macos-launchagent.md)
- [OpenClaw provider setup](docs/openclaw.md)
- [Model and protocol drift](MODEL_DRIFT.md)

## Security model

- Binds to localhost by default.
- Does **not** read, store, print, or copy Codex OAuth tokens.
- Delegates auth/session refresh to the official Codex CLI/app-server.
- Uses a fresh ephemeral Codex thread per request unless `CODEX_PROXY_SESSIONS=1` and a valid `X-Codex-Proxy-Session` header is present.
- Requests are run with conservative app-server parameters (`approvalPolicy: never`, `sandbox: read-only`) where supported.

Important caveat: Codex is an agent, not merely a text model. Keep this service private and localhost-only unless you add your own authentication, authorization, and sandbox policy review.

## Development

```bash
npm install
npm run build
npm test
```

Run live smoke after starting the server:

```bash
npm run smoke
```

## Roadmap

- Better `/v1/responses` compatibility for additional content parts and event aliases.
- More schema-drift fixtures for Codex app-server notifications and session thread reuse.
- Expanded operational docs for launchd, systemd, and client integrations.
- Optional local auth layer for non-loopback deployments.

## Caveats

- Codex app-server is JSON-RPC and agent-oriented; this proxy maps it into OpenAI-ish response shapes.
- `/v1/responses` is still minimal and text-only.
- Tool calls, images, approvals, and durable cross-process sessions are not implemented yet.
- The proxy uses stdio transport. Codex WebSocket transport is documented as experimental/unsupported, so it is intentionally avoided.

## License

MIT
