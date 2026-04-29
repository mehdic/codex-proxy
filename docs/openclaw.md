# OpenClaw

`codex-proxy` can be used as a local OpenAI-compatible provider in OpenClaw. The proxy should run on localhost and Codex CLI should own all authentication.

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
