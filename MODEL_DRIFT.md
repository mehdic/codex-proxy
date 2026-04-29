# Model and Protocol Drift

Codex app-server is not a stable public OpenAI API. It is a JSON-RPC interface owned by the official Codex CLI, and its request, notification, and model schema can change across CLI releases.

`codex-proxy` handles known drift defensively, but upgrades should be tested before relying on a new Codex CLI version.

## What can drift

- model identifiers accepted by Codex
- `initialize`, `thread/start`, or `turn/start` parameter names
- notification names such as `item/agentMessage/delta` and `turn/completed`
- content item shapes for completed assistant messages
- token usage field names
- error payload shape and retry behavior
- app-server behavior when one initialized stdio process handles multiple ephemeral threads over time
- app-server behavior when multiple `turn/start` calls reuse one thread id for opt-in sessions

The proxy intentionally uses stdio app-server transport:

```bash
codex app-server --listen stdio://
```

Do not switch to experimental WebSocket transport for routine compatibility work.

## Generate fresh protocol observations

Use a local scratch capture that does not include auth material or secrets. The proxy never needs Codex OAuth tokens.

One practical approach is to run the proxy with debug logging while sending a harmless prompt:

```bash
CODEX_PROXY_DEBUG=1 npm start
curl -s -X POST http://127.0.0.1:3466/v1/chat/completions \
  -H 'Content-Type: application/json' \
  -d '{"model":"gpt-5.5","messages":[{"role":"user","content":"Reply OK only."}]}'
```

For deeper schema work, inspect the installed Codex CLI package or run a tiny stdio harness that logs JSON-RPC method names and redacted shape keys. Do not log prompt contents from real work and do not read or print Codex auth files.

Keep durable schema notes in `PROTOCOL.md` and type updates in `src/types/codex.ts`.

## Upgrade checklist

After upgrading Codex CLI:

```bash
npm run build
npm test
npm run smoke
```

Then manually verify:

- `/health` returns version and uptime.
- `/healthz/deep` succeeds with the intended model.
- `/v1/models` includes useful current models.
- non-streaming `/v1/chat/completions` returns assistant text.
- streaming `/v1/chat/completions` emits chunks and `[DONE]`.
- non-streaming `/v1/responses` returns `output_text`.
- streaming `/v1/responses` emits `response.created`, text delta events, and `response.completed`.
- errors remain OpenAI-style and do not include secrets.
- in `pool` runtime, repeated requests reuse app-server workers without reusing Codex threads.
- with `CODEX_PROXY_SESSIONS=1`, two sequential requests with the same valid `X-Codex-Proxy-Session` succeed and `/metrics` does not expose the session id.
- in `oneshot` runtime, a request still succeeds with a fresh app-server process.

If a live smoke fails because of quota or Codex auth, verify the CLI directly:

```bash
codex exec "Reply OK only."
```

## Version policy

Package version, `src/server/version.ts`, and `package-lock.json` should move together. Runtime version output comes from `src/server/version.ts` so the built server does not depend on importing `package.json`.
