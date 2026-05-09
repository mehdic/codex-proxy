# PRD: Opt-In Sticky Codex CLI Sessions

**Status:** Ready for implementation planning  
**Date:** 2026-05-09  
**Owner:** Codex Proxy maintainers  
**Repository:** `/Users/mehdichaouachi/.openclaw/projects/codex-proxy`  
**Adapted from:** Claude Proxy sticky-session PRD at `/Users/mehdichaouachi/.openclaw/projects/claude-proxy/docs/prd/sticky-sessions.md`

---

## Problem

`codex-proxy` already has an opt-in session/thread pool behind `CODEX_PROXY_SESSIONS=1` and `X-Codex-Proxy-Session`. That proves the core behavior works: repeated requests with the same caller key can reuse one `codex app-server` worker and one Codex thread.

But it is not yet at parity with the sticky-session protocol Cassius implemented for Claude Proxy:

- only one legacy header is supported;
- there is no explicit `pool | sticky | stateless` session mode protocol;
- request-body extension fields are not supported;
- no per-request TTL/reset/policy knobs;
- observability is coarse (`codex_proxy_sessions_total`) and does not distinguish sticky hits, cold starts, evictions, mode accepts/rejects, or pool capacity;
- `/health` does not expose sticky-pool state;
- docs do not present a generic public extension compatible with OpenClaw, LiveKit, SDK users, and custom apps.

The goal is not to reinvent the existing `CodexSessionPool`; it is to harden and standardize it into a generic sticky-session feature matching Claude Proxy’s new semantics where Codex architecture allows it.

---

## Goal

Add a generic, opt-in sticky-session extension to Codex Proxy so callers can bind a stable session key to the same live `codex app-server` worker and Codex thread across requests, while preserving the default OpenAI-compatible behavior for callers that do not opt in.

---

## Non-Goals

- Do not enable sticky sessions by default.
- Do not hard-code OpenClaw agents, Telegram chats, or any named user/session source.
- Do not store, read, copy, print, or manage Codex OAuth/session tokens; official Codex owns auth.
- Do not persist raw prompts/conversations to disk as part of this feature.
- Do not expose raw session keys in logs, traces, metrics labels, or error responses.
- Do not execute OpenClaw tools inside the proxy. The proxy still only bridges OpenAI-compatible requests to Codex app-server behavior.
- Do not claim long TTL equals OpenAI/Codex server-side prompt-cache persistence. Sticky TTL preserves local app-server/thread continuity only.
- Do not break the existing legacy `X-Codex-Proxy-Session` + `CODEX_PROXY_SESSIONS=1` path.

---

## Current State

Relevant files today:

- `src/subprocess/session-pool.ts` — existing `CodexSessionPool`; validates `X-Codex-Proxy-Session`, keys by `sessionId|buildPoolKey(options)`, serializes turns per slot, TTL/LRU evicts, starts one ephemeral Codex thread per session slot, and records coarse session metrics.
- `src/subprocess/runtime.ts` — resolves runtime and legacy session header.
- `src/server/routes.ts` — parses legacy session once per request and calls `GLOBAL_CODEX_SESSIONS.runTurn(...)` when a session id is present.
- `src/server/config.ts` — exposes `CODEX_PROXY_SESSIONS`, `CODEX_PROXY_SESSION_TTL_MS`, `CODEX_PROXY_SESSION_MAX`.
- `src/server/metrics.ts` — exposes `codex_proxy_sessions_total` and `codex_proxy_active_sessions`.
- `src/types/openai.ts` — has no `codex_proxy` request extension yet.
- `src/__tests__/session-pool.test.ts`, `src/__tests__/runtime.test.ts`, `src/__tests__/server.test.ts` — current regression surface.

---

## Functional Requirements

### FR1 — Backward compatibility

Requests without sticky extension fields must behave exactly as they do now:

- default runtime remains configured by `CODEX_PROXY_RUNTIME` (`pool` by default);
- no required request fields are added;
- existing OpenAI Chat Completions and Responses clients continue to work;
- legacy `CODEX_PROXY_SESSIONS=1` + `X-Codex-Proxy-Session` still opts into sticky behavior.

### FR2 — Generic session options protocol

Support Claude Proxy-style Codex names:

| Header | Meaning |
| --- | --- |
| `X-Codex-Proxy-Session-Key` | Caller-selected stable sticky key. Preferred new header. |
| `X-Codex-Proxy-Session` | Legacy alias. Continue supporting it. |
| `X-Codex-Proxy-Session-Mode` | `pool`, `sticky`, or `stateless`. Defaults to `sticky` when a key exists, otherwise `pool`. |
| `X-Codex-Proxy-Session-TTL-Seconds` | Requested idle TTL, clamped by server config. |
| `X-Codex-Proxy-Session-Reset` | Truthy value evicts the matching sticky session before serving the request. |
| `X-Codex-Proxy-Session-Policy` | Reserved: `strict` or `compatible`; default `strict`. |

Also support a body extension on Chat Completions and Responses requests:

```json
{
  "model": "gpt-5.5",
  "messages": [{ "role": "user", "content": "Hello" }],
  "codex_proxy": {
    "session_key": "reaper:telegram:5216159759",
    "session_mode": "sticky",
    "session_ttl_seconds": 86400,
    "session_reset": false,
    "session_policy": "strict"
  }
}
```

Body aliases should match the Claude Proxy ergonomics: `session`, `sessionKey`, `session_key`, `mode`, `sessionMode`, `session_mode`, `ttl_seconds`, `sessionTtlSeconds`, `session_ttl_seconds`, `reset`, `sessionReset`, `session_reset`, `policy`, `sessionPolicy`, `session_policy`.

Precedence:

1. headers;
2. body extension;
3. environment defaults;
4. hard-coded defaults.

### FR3 — Session modes

- `pool` — default behavior: use the normal warm app-server worker pool; each request starts a fresh Codex thread.
- `sticky` — use a caller key to reuse the same app-server worker and Codex thread.
- `stateless` — bypass both sticky and pool reuse; use one app-server process for the request and discard it.

Rules:

- key without explicit mode means `sticky`;
- `sticky` without a valid key returns HTTP 400;
- if sticky sessions are disabled, sticky requests return HTTP 400 with a clear OpenAI-style error;
- `pool` ignores session key fields;
- `stateless` ignores session key fields and maps to existing `oneshot` runtime for that request.

### FR4 — Key and fingerprint safety

- Validate keys as strings after trim.
- Default max key length: 256 for new `Session-Key`; legacy `X-Codex-Proxy-Session` can remain 128 initially or be raised in a documented compatibility bump.
- Reject empty values and control characters.
- Hash the normalized key with SHA-256 for internal fingerprints, logs, traces, and diagnostics.
- Never use raw caller keys in Prometheus labels.
- Sticky identity must include: session key hash, model, cwd, sandbox, approval policy, base instructions/config overrides fingerprint, and session policy.

### FR5 — TTL, reset, and capacity

Add/align config:

| Env var | Default | Meaning |
| --- | --- | --- |
| `CODEX_PROXY_STICKY_SESSIONS` | falls back to `CODEX_PROXY_SESSIONS` | Enables new sticky protocol. |
| `CODEX_PROXY_STICKY_DEFAULT_TTL_SECONDS` | `600` | Default idle TTL. |
| `CODEX_PROXY_STICKY_MIN_TTL_SECONDS` | `60` | Minimum requested TTL. |
| `CODEX_PROXY_STICKY_MAX_TTL_SECONDS` | `86400` | Maximum requested TTL. |
| `CODEX_PROXY_STICKY_ABSOLUTE_TTL_SECONDS` | `86400` | Hard maximum session lifetime; `0` disables absolute expiry. |
| `CODEX_PROXY_STICKY_MAX_SESSIONS` | falls back to `CODEX_PROXY_SESSION_MAX` (`32`) | Max live sticky sessions. |
| `CODEX_PROXY_STICKY_QUEUE_TIMEOUT_MS` | `120000` | Max wait for another turn on same sticky slot. |
| `CODEX_PROXY_STICKY_ALLOW_BODY_OPTIONS` | `1` | Allows `codex_proxy` body extension. |
| `CODEX_PROXY_STICKY_KEY_MAX_LENGTH` | `256` | Max normalized key length. |

Reset behavior:

- reset evicts matching idle slots for the key/fingerprint before serving the request;
- reset on an active slot returns 409 or 429 with OpenAI-style error `sticky_session_busy` rather than racing.

### FR6 — Observability

Expose bounded metrics analogous to Claude Proxy:

- `codex_proxy_sticky_pool_size{state="live|max"}`
- `codex_proxy_sticky_pool_enabled`
- `codex_proxy_sticky_session_hits_total`
- `codex_proxy_sticky_session_cold_starts_total`
- `codex_proxy_sticky_session_evictions_total{reason="idle_ttl|absolute_ttl|lru|unhealthy|reset|client_disconnect|turn_error"}`
- `codex_proxy_sticky_session_busy_total{reason="active|capacity|queue_timeout"}`
- `codex_proxy_session_mode_total{mode="pool|sticky|stateless",status="accepted|rejected"}`

Keep existing `codex_proxy_sessions_total` metrics as compatibility aliases for one release if practical.

Health should include a small `sticky_pool` object:

```json
{
  "sticky_pool": {
    "enabled": true,
    "size": 1,
    "max": 32,
    "defaultTtlSeconds": 600,
    "maxTtlSeconds": 86400,
    "absoluteTtlSeconds": 86400,
    "queueTimeoutMs": 120000
  }
}
```

### FR7 — Response headers

When sticky mode is used, return bounded metadata headers:

- `X-Codex-Proxy-Session-Mode: sticky`
- `X-Codex-Proxy-Session-Hit: true|false`
- `X-Codex-Proxy-Session-Key-Hash: <12 hex chars>`
- `X-Codex-Proxy-Session-TTL-Seconds: <effective ttl>`

For `pool`/`stateless`, return `X-Codex-Proxy-Session-Mode` only when the caller explicitly supplied session mode fields.

---

## Security and Safety

- Localhost binding remains default.
- Sticky sessions are trusted-local feature; if exposed remotely, operator must add auth/rate limits separately.
- Key hashing is mandatory for traces/logs/metrics.
- Fingerprint mismatch should create a separate slot or reject under strict policy; do not silently reuse a thread with different model/sandbox/approval/cwd/instructions.
- On client disconnect, kill/discard the active sticky worker unless the turn completed cleanly; do not leave ambiguous thread state alive.

---

## Acceptance Criteria

1. Existing `npm test` passes with sticky disabled.
2. Existing legacy session tests pass unchanged.
3. New option parser tests cover header/body precedence, aliases, invalid modes, disabled sticky, TTL clamp, reset parsing, and hashed key output.
4. New sticky pool tests cover hit/miss, TTL expiry, absolute expiry, LRU, reset, in-flight serialization, busy rejection, dead worker eviction, and no raw-key metric labels.
5. Chat Completions and Responses support sticky/pool/stateless modes in streaming and non-streaming paths.
6. Live smoke with `CODEX_PROXY_STICKY_SESSIONS=1` proves memory continuity across two requests with same key.
7. Live smoke proves default request remains non-sticky.
8. `/metrics` shows sticky counters/gauges and `/health` exposes sticky pool state.
9. Docs explain that TTL preserves local Codex app-server/thread continuity, not server-side cache guarantees.

