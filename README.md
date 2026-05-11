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

v0.4.8 local proxy. Working locally with:

- non-streaming and streaming `/v1/chat/completions`
- improved `/v1/responses` compatibility for string input, message arrays, mixed content parts, function-call/function-call-output inputs, reasoning/summary/item-reference inputs, and SDK-friendly streaming event aliases
- `/v1/models`, `/health`, `/healthz/deep`, `/version`, `/metrics`, `/pricing`
- app-server stdio transport over the official `codex app-server`
- pooled persistent `codex app-server` workers with one ephemeral thread per request by default
- opt-in, TTL/LRU-limited sticky Codex session/thread pooling via `CODEX_PROXY_STICKY_SESSIONS=1` + `X-Codex-Proxy-Session-Key` or legacy `CODEX_PROXY_SESSIONS=1` + `X-Codex-Proxy-Session`
- one-shot fallback mode for eligible pool transport failures before response bytes are committed
- SSE keepalive comments plus writable-guard hardening for streaming clients and early disconnects
- env-gated localhost CORS
- configurable Codex sandbox/approval policy (`CODEX_PROXY_SANDBOX`, `CODEX_PROXY_APPROVAL_POLICY`)
- usage metadata, cached/reasoning token details where Codex reports them, simulated public API-equivalent cost estimates, and Prometheus metrics
- composable operational tool bridge: external caller-dispatched tools via OpenClaw/LangChain coexist with Codex-native capabilities, and current code supports multiple emitted tool calls in one assistant turn
- macOS LaunchAgent templates, installer, release checklist, smoke tests, and local soak harness

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

- `CODEX_PROXY_POOL_MAX` default `32`: maximum live app-server workers.
- `CODEX_PROXY_POOL_TTL_MS` default `600000`: idle worker TTL.
- `CODEX_PROXY_PREWARM_MODELS` default `gpt-5.5,gpt-5.4-mini`: models to prewarm at startup.
- `CODEX_PROXY_INIT_POOL=0`: disables startup prewarm.
- `CODEX_PROXY_FALLBACK_ON_POOL_FAILURE=0`: disables retrying eligible pool transport failures with one-shot before any HTTP response is committed.

## Opt-in sticky sessions

Default behavior is stateless at the Codex thread layer: pooled workers are reused, but every normal request starts a fresh ephemeral Codex thread. A caller gets Codex thread continuity only by opting in.

Preferred protocol:

1. Start with `CODEX_PROXY_STICKY_SESSIONS=1`.
2. Send `X-Codex-Proxy-Session-Key: <stable-key>`.

Legacy protocol remains supported: `CODEX_PROXY_SESSIONS=1` plus `X-Codex-Proxy-Session: <id>`.

Optional request controls:

- `X-Codex-Proxy-Session-Mode: pool|sticky|stateless` — key without a mode defaults to `sticky`; `stateless` forces one-shot for that request.
- `X-Codex-Proxy-Session-TTL-Seconds: <seconds>` — requested idle TTL, clamped by server config.
- `X-Codex-Proxy-Session-Reset: 1` — evicts the matching idle sticky session before serving the request.
- `X-Codex-Proxy-Session-Policy: strict|compatible` — reserved compatibility policy, default `strict`.

Chat Completions and Responses also accept a body extension:

```json
{
  "codex_proxy": {
    "session_key": "app:user:conversation",
    "session_mode": "sticky",
    "session_ttl_seconds": 86400,
    "session_reset": false,
    "session_policy": "strict"
  }
}
```

When enabled and requested, the proxy keeps one initialized `codex app-server --listen stdio://` worker and one Codex thread for sequential requests with the same hashed session key and compatible model/cwd/instruction/config/sandbox/approval fingerprint. Concurrent requests for the same session are serialized. Sessions are evicted by idle TTL, absolute TTL, LRU, reset, client abort, dead worker, or turn failure. Sticky requests do not fallback to another worker because that would break thread continuity.

Sticky controls:

- `CODEX_PROXY_STICKY_SESSIONS=1`: enables the preferred sticky protocol. `CODEX_PROXY_SESSIONS=1` is still accepted as a legacy enable flag.
- `CODEX_PROXY_STICKY_DEFAULT_TTL_SECONDS` default derives from `CODEX_PROXY_SESSION_TTL_MS` (`600`).
- `CODEX_PROXY_STICKY_MIN_TTL_SECONDS` default `60`.
- `CODEX_PROXY_STICKY_MAX_TTL_SECONDS` default `86400`.
- `CODEX_PROXY_STICKY_ABSOLUTE_TTL_SECONDS` default `86400`, `0` disables absolute expiry.
- `CODEX_PROXY_STICKY_MAX_SESSIONS` default derives from `CODEX_PROXY_SESSION_MAX` (`32`).
- `CODEX_PROXY_STICKY_QUEUE_TIMEOUT_MS` default `120000`.
- `CODEX_PROXY_STICKY_ALLOW_BODY_OPTIONS` default enabled; set `0` to ignore `codex_proxy` body fields.
- `CODEX_PROXY_STICKY_KEY_MAX_LENGTH` default `256`.

Raw session keys are hashed before use in diagnostics and are never used as metric labels. Long TTL preserves local Codex app-server/thread continuity only; it is not a guarantee of remote server-side cache warmth.

### Streaming keepalives and visible progress

Streaming responses send two kinds of keepalive signal:

1. **Transport-only SSE comments** — an initial `:ok\n\n` on connection, then idle `:keepalive req_id=... count=...\n\n` comments at the `CODEX_PROXY_KEEPALIVE_MS` interval (default `10000`; `0` disables). These are SSE comments, not `data:` events, so they keep the connection alive without producing OpenAI chunks or visible assistant text.

2. **Visible progress chunks** — when Codex app-server emits truthful long-running work notifications (command execution, file changes), the keepalive path emits newline-terminated assistant content instead of a comment. Chat Completions streams send standard `data:` deltas such as `[Working: using shell…]\n` or `[Working: waiting for shell, 12s…]\n`; Responses streams send equivalent `response.output_text.delta` events. These are real assistant text so that OpenClaw streaming previews and Telegram message previews show that Codex is still working. The proxy never uses zero-width characters, empty deltas, or other invisible padding as fake progress.

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
| `/pricing`, `/v1/pricing` | GET | Public fallback pricing book used for local cost estimates |
| `/models`, `/v1/models` | GET | OpenAI model list |
| `/chat/completions`, `/v1/chat/completions` | POST | OpenAI chat-completions-compatible API |
| `/responses`, `/v1/responses` | POST | OpenAI Responses-style API with text, mixed content markers, function-call context items, streaming aliases, usage, and metadata echoes |

Use `/health` for frequent process checks. Use `/healthz/deep` for readiness diagnostics because it starts `codex app-server` and consumes a small live turn.

## Usage metadata

Codex app-server reports latest-turn usage through official `thread/tokenUsage/updated` notifications. The proxy maps those values into OpenAI-compatible fields:

- Chat Completions: `prompt_tokens`, `completion_tokens`, `total_tokens`, `prompt_tokens_details.cached_tokens`, and `completion_tokens_details.reasoning_tokens`.
- Responses: `input_tokens`, `output_tokens`, `total_tokens`, `input_tokens_details.cached_tokens`, and `output_tokens_details.reasoning_tokens`.
- Local cost estimates: `usage.cost`, `usage.cost_usd`, `usage.estimated`, and `usage.estimate_method`.
- Non-streaming response headers: `X-Codex-Proxy-Prompt-Tokens`, `X-Codex-Proxy-Completion-Tokens`, `X-Codex-Proxy-Total-Tokens`, `X-Codex-Proxy-Usage-Estimated`, and `X-Codex-Proxy-Estimated-Cost-Usd`.

If Codex does not report usage, the proxy falls back to a conservative local token estimate (`chars / 4` with a word-count floor). Cost is a simulated normal API-cost estimate from public pricing, not actual billing for the Codex subscription/app-server path. Codex does not currently expose Claude-style prompt cache creation/write token counts through app-server, so `cacheWrite`-style accounting is not available here.

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
| `CODEX_PROXY_POOL_MAX` | `32` | Maximum live pooled app-server workers |
| `CODEX_PROXY_POOL_TTL_MS` | `600000` | Idle worker TTL |
| `CODEX_PROXY_PREWARM_MODELS` | `gpt-5.5,gpt-5.4-mini` | Comma-separated startup prewarm models |
| `CODEX_PROXY_INIT_POOL` | enabled | Set `0` to disable startup prewarm |
| `CODEX_PROXY_FALLBACK_ON_POOL_FAILURE` | enabled | Set `0` to disable pool-to-oneshot retry before response commit |
| `CODEX_PROXY_KEEPALIVE_MS` | `10000` | SSE comment keepalive interval; `0` disables |
| `CODEX_PROXY_SESSIONS` | `0` | Legacy enable flag for `X-Codex-Proxy-Session` sticky thread reuse |
| `CODEX_PROXY_SESSION_TTL_MS` | `600000` | Legacy idle opt-in session TTL fallback |
| `CODEX_PROXY_SESSION_MAX` | `32` | Legacy maximum active opt-in sessions fallback |
| `CODEX_PROXY_STICKY_SESSIONS` | `0` | Preferred enable flag for sticky sessions |
| `CODEX_PROXY_STICKY_DEFAULT_TTL_SECONDS` | `600` | Default sticky idle TTL, derived from `CODEX_PROXY_SESSION_TTL_MS` if unset |
| `CODEX_PROXY_STICKY_MIN_TTL_SECONDS` | `60` | Minimum requested sticky TTL |
| `CODEX_PROXY_STICKY_MAX_TTL_SECONDS` | `86400` | Maximum requested sticky TTL |
| `CODEX_PROXY_STICKY_ABSOLUTE_TTL_SECONDS` | `86400` | Hard max sticky lifetime; `0` disables absolute expiry |
| `CODEX_PROXY_STICKY_MAX_SESSIONS` | `32` | Maximum active sticky sessions, derived from `CODEX_PROXY_SESSION_MAX` if unset |
| `CODEX_PROXY_STICKY_QUEUE_TIMEOUT_MS` | `120000` | Maximum wait behind an active turn on the same sticky session |
| `CODEX_PROXY_STICKY_ALLOW_BODY_OPTIONS` | enabled | Set `0` to ignore `codex_proxy` body extension fields |
| `CODEX_PROXY_STICKY_KEY_MAX_LENGTH` | `256` | Maximum preferred sticky session key length |
| `CODEX_PROXY_CODEX_BIN` | `codex` | Codex binary path |
| `CODEX_PROXY_HEALTH_MODEL` | default model | Model for `/healthz/deep` |
| `CODEX_PROXY_HEALTH_TIMEOUT_MS` | `30000` | Deep health timeout |
| `CODEX_PROXY_SHUTDOWN_GRACE_MS` | `10000` | Grace period for SIGINT/SIGTERM shutdown |
| `CODEX_PROXY_CORS` | unset | Set `1` to allow localhost browser origins |
| `CODEX_PROXY_SANDBOX` | `read-only` | Codex app-server thread sandbox: `read-only`, `workspace-write`, or `danger-full-access` |
| `CODEX_PROXY_APPROVAL_POLICY` | `never` | Codex app-server approval policy: `never`, `on-request`, `on-failure`, or `untrusted` |
| `DEBUG` | unset | Logs app-server stderr snippets for debugging |

### Codex app-server sandbox / approval

Codex Proxy starts Codex app-server threads with explicit sandbox and approval settings. Defaults are intentionally conservative:

```bash
CODEX_PROXY_SANDBOX=read-only
CODEX_PROXY_APPROVAL_POLICY=never
```

Supported sandbox values:

| Value | Meaning | Recommended use |
|---|---|---|
| `read-only` | Codex-native tools can inspect but should not write; local network/socket access may be restricted by Codex. | Default for shared, public, or uncertain deployments. |
| `workspace-write` | Codex may write inside the active workspace while staying constrained outside it. | Coding work where edits are expected but broad host access is not. |
| `danger-full-access` | Codex runs without the Codex sandbox boundary. | Trusted localhost-only agents where native shell/network/filesystem access is desired. |

Supported approval values: `never`, `on-request`, `on-failure`, `untrusted`.

For this Mac mini trusted local OpenClaw/Codex instance, the LaunchAgent can intentionally run full access:

```xml
<key>CODEX_PROXY_SANDBOX</key>
<string>danger-full-access</string>
<key>CODEX_PROXY_APPROVAL_POLICY</key>
<string>never</string>
```

That affects Codex-native tool execution inside the Codex app-server session. It does not change the OpenClaw external tool bridge: external OpenAI/OpenClaw tools are still emitted as `tool_calls` and dispatched by OpenClaw.

## Operational docs

- [macOS LaunchAgent](docs/macos-launchagent.md)
- [OpenClaw provider setup](docs/openclaw.md)
- [Model and protocol drift](MODEL_DRIFT.md)
- [Release & soak checklist](scripts/release-checklist.sh)

## Security model

- Binds to localhost by default.
- Does **not** read, store, print, or copy Codex OAuth tokens.
- Delegates auth/session refresh to the official Codex CLI/app-server.
- Uses a fresh ephemeral Codex thread per request unless sticky sessions are explicitly enabled and requested with `X-Codex-Proxy-Session-Key` or legacy `X-Codex-Proxy-Session`.
- Requests default to conservative app-server parameters (`approvalPolicy: never`, `sandbox: read-only`) where supported. These are configurable via `CODEX_PROXY_APPROVAL_POLICY` and `CODEX_PROXY_SANDBOX` for trusted deployments that need more capability.

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

## Tool calling

The proxy supports two tool-calling modes:

1. **Structured output** (single schema-style function, e.g. LangChain `with_structured_output`): the proxy injects a JSON-schema conformance instruction and returns the result as a standard `tool_calls` response.
2. **Operational tool bridge** (multi-tool agent loops, e.g. OpenClaw MCP tools): the proxy describes caller-dispatched external tools in the prompt and instructs the model to return `{"tool_call":{...}}` JSON when one of those external tools is needed. The proxy does **not** execute these tools — the caller (OpenClaw, LangChain, etc.) dispatches them and sends results back as `tool` messages. Codex keeps its native capabilities/tools as provided by the Codex app-server session and may use them alongside or instead of external tool calls when they are sufficient.

Operational bridge responses may contain multiple `tool_call` JSON objects in one assistant turn. The proxy preserves their order and returns them as multiple OpenAI-style `message.tool_calls` entries, or as streaming `delta.tool_calls` chunks with `finish_reason: "tool_calls"` on the final tool chunk.

This composable design ensures OpenClaw-dispatched tools and Codex-native capabilities are combined into a larger effective tool range rather than one suppressing or replacing the other.

## Next features / plan

The complete project plan lives in [`docs/OCTO_FEATURE_PLAN.md`](docs/OCTO_FEATURE_PLAN.md).

Implemented through v0.4.8 plus the sticky-session implementation branch:

- pooled/oneshot runtimes, opt-in sticky sessions, pricing/usage reporting, release checklist, LaunchAgent support, and local soak harness
- configurable Codex sandbox/approval policy for trusted localhost deployments
- composable external-tool bridge with multiple `tool_calls` in one assistant turn
- practical Responses compatibility for string/message inputs, mixed content markers, function-call context, reasoning/summary/item references, metadata echoes, and streaming aliases
- live validation: release checklist, Responses edge-case smoke, multi-tool smoke, raw HTTP fanout, and OpenClaw sub-agent fanout

Recommended next work, in order:

1. **Minimal durable response/thread state** — optional TTL-bounded filesystem/SQLite state for practical `previous_response_id` and restart-safe session metadata, without storing prompts or OAuth material.
2. **Security and policy layer** — optional virtual API keys, per-key model/runtime/session/sandbox limits, origin validation, rate limits, and refusal/warnings for non-loopback bind without auth.
3. **Approval and sandbox bridge** — expose Codex approval waits/decisions clearly instead of letting agent flows hang mysteriously.
4. **Tool trace/replay** — request trace IDs, recent redacted traces, multi-tool-call replay data, app-server event class, fallback path, and tool-result reinjection records.
5. **Thin observability export** — optional OpenTelemetry/Langfuse-style spans with redaction, disabled by default.

Ongoing hygiene: keep README, package version, tags, `/health`, and infra docs synchronized. This project has enough moving parts now that stale docs are an actual production risk, because of course they are.

Deprioritized unless a real client demands them: model routing, semantic caching, batch APIs, and WebSocket transport. Those are attractive traps. The proxy should remain a trustworthy bridge, not a second platform.

## Caveats

- Codex app-server is JSON-RPC and agent-oriented; this proxy maps it into OpenAI-ish response shapes.
- `/v1/responses` is improved and useful, but still not full durable OpenAI Responses parity.
- `previous_response_id` is not yet backed by durable state.
- Image/audio/file inputs are flattened or represented as placeholders; real multimodal transport is not implemented yet.
- Approval UI/bridge support is not implemented yet.
- The proxy uses stdio transport. Codex WebSocket transport is documented as experimental/unsupported, so it is intentionally avoided.

## License

MIT
