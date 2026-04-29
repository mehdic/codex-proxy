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

Early MVP. Working locally with:

- non-streaming `/v1/chat/completions`
- streaming `/v1/chat/completions`
- `/v1/models`
- `/health`
- `/metrics`
- app-server stdio transport

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

## Smoke tests

```bash
curl -s http://127.0.0.1:3466/health
curl -s http://127.0.0.1:3466/v1/models | jq

curl -s -X POST http://127.0.0.1:3466/v1/chat/completions \
  -H 'Content-Type: application/json' \
  -d '{"model":"gpt-5.5","messages":[{"role":"user","content":"Reply OK only."}]}'

curl -N -X POST http://127.0.0.1:3466/v1/chat/completions \
  -H 'Content-Type: application/json' \
  -d '{"model":"gpt-5.5","stream":true,"messages":[{"role":"user","content":"Reply HI only."}]}'
```

## Endpoints

| Endpoint | Method | Description |
|---|---:|---|
| `/health` | GET | Cheap liveness probe |
| `/healthz/deep` | GET | Runs a tiny Codex turn |
| `/metrics` | GET | Prometheus-style metrics |
| `/models`, `/v1/models` | GET | OpenAI model list |
| `/chat/completions`, `/v1/chat/completions` | POST | OpenAI chat-completions-compatible API |
| `/responses`, `/v1/responses` | POST | Minimal OpenAI Responses-style API |

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
| `DEBUG` | unset | Logs app-server stderr snippets for debugging |

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

## Caveats

- Codex app-server is JSON-RPC and agent-oriented; this proxy maps it into OpenAI-ish response shapes.
- `/v1/responses` is minimal text-only MVP.
- Tool calls, images, approvals, and persistent sessions are not implemented yet.
- The proxy uses stdio transport. Codex WebSocket transport is documented as experimental/unsupported, so it is intentionally avoided.

## License

MIT
