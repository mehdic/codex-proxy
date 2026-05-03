# OpenClaw

`codex-proxy` (v0.4.8) can be used as a local OpenAI-compatible provider in OpenClaw. The proxy should run on localhost and Codex CLI should own all authentication.

## Tool bridge semantics

When OpenClaw sends tools in a chat completion request, the proxy describes them to Codex as **external caller-dispatched tools** that require returning `tool_call` JSON for OpenClaw to dispatch. The proxy does not execute these tools. Codex retains its own native capabilities/tools from the Codex app-server session and may use them when sufficient, so OpenClaw-dispatched tools and Codex-native capabilities combine into a larger effective tool range instead of replacing one another.

## Start the proxy

```bash
cd ~/.openclaw/projects/codex-proxy
npm install
npm run build
npm start
```

Default URL:

```text
http://127.0.0.1:3466/v1
```

## Provider config

Add a provider similar to this in your OpenClaw model configuration:

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

If your OpenClaw build supports the Responses API, use the same `baseUrl` with `/v1/responses`. Chat completions remain the most compatible path.

## Streaming progress previews

Streaming responses send an initial `:ok` SSE comment and idle `:keepalive req_id=... count=...` comments. These are transport-only SSE comments that keep the connection alive without producing visible text.

When Codex app-server reports real long-running work (shell commands, file changes), the keepalive path emits visible, newline-terminated progress deltas instead: `[Working: using shell…]\n`, `[Working: waiting for shell, 12s…]\n`, etc. These are standard assistant-content chunks (Chat Completions `data:` deltas / Responses `response.output_text.delta` events), so OpenClaw's streaming preview surfaces them in the Telegram chat as a live typing indicator while Codex is working. The proxy never uses zero-width characters, empty deltas, or other invisible padding as fake progress.

## Usage and cost estimates

Codex app-server token usage is mapped into OpenAI-compatible `usage` fields. When app-server usage is missing, the proxy estimates token counts locally and marks `usage.estimated=true`. The proxy also exposes simulated normal API-cost estimates in `usage.cost` / `usage.cost_usd`, response headers such as `X-Codex-Proxy-Total-Tokens` and `X-Codex-Proxy-Estimated-Cost-Usd`, Prometheus metrics, and `/pricing` / `/v1/pricing` for the pricing book. These are operational estimates only; Codex CLI/app-server still owns auth and subscription entitlement.

## Usage guidance

- Keep `authHeader: false` when possible. The local proxy does not require an API key.
- Use `apiKey: "local"` only for clients that require a non-empty value.
- Keep the proxy bound to `127.0.0.1`.
- For browser-based localhost clients, set `CODEX_PROXY_CORS=1` only when needed. CORS is off by default.
- Use `/health` for liveness and `/healthz/deep` only when you want to verify the Codex CLI/app-server path and quota.

## Troubleshooting

Check cheap liveness:

```bash
curl -s http://127.0.0.1:3466/health
```

Check model discovery:

```bash
curl -s http://127.0.0.1:3466/v1/models
```

Run a live turn:

```bash
curl -s -X POST http://127.0.0.1:3466/v1/chat/completions \
  -H 'Content-Type: application/json' \
  -d '{"model":"gpt-5.5","messages":[{"role":"user","content":"Reply OK only."}]}'
```

If live turns fail but `/health` works, verify `codex exec "Reply OK only."` in the same user account that runs the proxy.
