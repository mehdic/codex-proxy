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

v0.2 local proxy. Working locally with:

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
- Uses a fresh app-server process and ephemeral thread per request in the MVP.
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

## v0.2 roadmap

- Better `/v1/responses` compatibility for additional content parts and event aliases.
- Optional warm worker/session mode once lifecycle and failure handling are well-tested.
- More schema-drift fixtures for Codex app-server notifications.
- Expanded operational docs for launchd, systemd, and client integrations.
- Optional local auth layer for non-loopback deployments.

## Caveats

- Codex app-server is JSON-RPC and agent-oriented; this proxy maps it into OpenAI-ish response shapes.
- `/v1/responses` is still minimal and text-only.
- Tool calls, images, approvals, and persistent sessions are not implemented yet.
- The proxy uses stdio transport. Codex WebSocket transport is documented as experimental/unsupported, so it is intentionally avoided.

## License

MIT
