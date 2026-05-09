# Opt-In Sticky Codex CLI Sessions Implementation Plan

> Adapted from Claude Proxy sticky-session plan: `/Users/mehdichaouachi/.openclaw/projects/claude-proxy/docs/superpowers/plans/2026-05-09-sticky-claude-sessions.md`.

**Goal:** Bring `codex-proxy` sticky session semantics to parity with Cassius’s Claude Proxy implementation while reusing the existing `CodexSessionPool` foundation.

**Core architecture:** Add a Codex-specific session options parser and evolve the current session pool into a first-class sticky pool. Route handlers choose `pool`, `sticky`, or `stateless` per request. Sticky mode reuses one live `codex app-server` worker plus one Codex thread; pool mode remains the default warm-worker/fresh-thread behavior; stateless maps to one-shot.

---

## Key differences from Claude Proxy

- Claude Proxy sticky mode binds to a `StreamJsonSubprocess`; Codex Proxy sticky mode binds to `CodexSubprocess + threadId`.
- Codex already has `src/subprocess/session-pool.ts`; do not duplicate it blindly. Extend or wrap it.
- Codex app-server starts threads with sandbox/approval/cwd/base instructions. Those must be part of the sticky fingerprint.
- Codex already supports streaming/non-streaming Chat and Responses through the same `runTurn` helper, so integration can be simpler than Claude Proxy’s two route paths.
- Existing legacy protocol (`CODEX_PROXY_SESSIONS=1`, `X-Codex-Proxy-Session`) must keep working.

---

## Implementation tasks

### Task 1 — Add request extension types

Files:
- `src/types/openai.ts`

Steps:
- Add `CodexProxySessionMode = "pool" | "sticky" | "stateless"`.
- Add `CodexProxySessionPolicy = "strict" | "compatible"`.
- Add `CodexProxyRequestExtension` with aliases matching the PRD.
- Add optional `codex_proxy?: CodexProxyRequestExtension` to `ChatCompletionRequest` and `ResponseRequest`.

Gate:
- `npm run build`

---

### Task 2 — Add sticky option parser tests first

Files:
- create `src/__tests__/sticky-options.test.ts`
- later create `src/server/sticky-options.ts`

Test cases:
- no headers/body resolves to `{ mode: "pool" }`;
- `X-Codex-Proxy-Session-Key` opts into sticky when enabled;
- legacy `X-Codex-Proxy-Session` remains an alias;
- header beats body extension;
- body aliases work when `CODEX_PROXY_STICKY_ALLOW_BODY_OPTIONS !== "0"`;
- mode `stateless` works without key;
- mode `sticky` without key returns `invalid_session_key`;
- sticky disabled returns `sticky_sessions_disabled`;
- TTL seconds clamps to min/max;
- reset truthy/falsy parsing;
- policy accepts only `strict|compatible`;
- key hash short is 12 hex chars and raw key is not used for metrics-facing fields.

Gate:
- tests fail before implementation, then pass after Task 3.

---

### Task 3 — Implement `src/server/sticky-options.ts`

Files:
- create `src/server/sticky-options.ts`
- modify `src/subprocess/runtime.ts` only enough to preserve legacy compatibility or delegate to the new parser

Implementation shape:

```ts
export interface StickySessionConfig {
  enabled: boolean;
  legacyEnabled: boolean;
  allowBodyOptions: boolean;
  keyMaxLength: number;
  defaultTtlSeconds: number;
  minTtlSeconds: number;
  maxTtlSeconds: number;
  absoluteTtlSeconds: number;
  maxSessions: number;
  queueTimeoutMs: number;
}

export interface ResolvedSessionOptions {
  mode: "pool" | "sticky" | "stateless";
  explicit: boolean;
  sticky?: {
    rawKey: string;
    keyHash: string;
    keyHashShort: string;
    ttlSeconds: number;
    reset: boolean;
    policy: "strict" | "compatible";
    legacyHeader: boolean;
  };
}
```

Config mapping:
- `enabled = CODEX_PROXY_STICKY_SESSIONS === "1" || CODEX_PROXY_SESSIONS === "1"`
- sticky max sessions falls back to `CODEX_PROXY_SESSION_MAX`
- sticky default TTL falls back to `CODEX_PROXY_SESSION_TTL_MS / 1000`

Gate:
- `npm run build`
- `npm test -- --test-name-pattern sticky-options` if Node test pattern is convenient, otherwise full `npm test`.

---

### Task 4 — Evolve `CodexSessionPool` into sticky-capable pool

Files:
- modify `src/subprocess/session-pool.ts`
- optionally rename exports internally, but avoid churn in public names
- update `src/__tests__/session-pool.test.ts`
- optionally add `src/__tests__/sticky-session-pool.test.ts` if the old tests get too crowded

Required changes:
- Accept per-request `ttlMs` or `ttlSeconds` instead of only global TTL.
- Add absolute TTL support.
- Add reset support by key/fingerprint.
- Add bounded counters: hits, cold starts, resets, TTL evictions, absolute TTL evictions, LRU, unhealthy/dead evictions, busy/queue timeouts.
- Add queue timeout for concurrent turns on the same sticky slot.
- Add `stats()` with enabled/max/default TTL/max TTL/absolute TTL/queue timeout.
- Add `abortSession` behavior that discards the sticky slot on client disconnect.
- Compute slot key from hashed session identity + safe fingerprint, not raw key.
- Keep `validateSessionId` for legacy header, but introduce `normalizeStickySessionKey` for the new broader key rules.

Fingerprint should include:
- key hash;
- model;
- cwd;
- sandbox;
- approval policy;
- config overrides hash;
- instructions hash/presence;
- session policy.

Gate:
- `npm test` with existing session tests updated.

---

### Task 5 — Route integration for Chat Completions and Responses

Files:
- modify `src/server/routes.ts`
- retire direct `resolveSessionRequest(...)` usage in favor of `resolveSessionOptions(...)`

Changes:
- Resolve `sessionOptions` after model/options parsing so fingerprint can use actual options.
- For invalid parser result: return OpenAI-style 400.
- Map modes:
  - `sticky` → `GLOBAL_CODEX_SESSIONS.runTurn(stickyOptions, prompt, options, ...)`
  - `pool` → existing pool/oneshot logic based on runtime
  - `stateless` → force `oneshot` for this request
- Preserve fallback-on-pool-failure for `pool` mode only.
- On stream/client close, abort and discard sticky slot.
- Set response headers before stream flush / JSON response.
- Record session mode accepted/rejected counters.

Gate:
- `npm run build`
- `npm test`

---

### Task 6 — Metrics and health

Files:
- modify `src/server/metrics.ts`
- modify `src/server/routes.ts` health payload
- update `src/__tests__/metrics.test.ts`, `src/__tests__/server.test.ts`

Metrics to add:
- `codex_proxy_sticky_pool_size{state="live|max"}`
- `codex_proxy_sticky_pool_enabled`
- `codex_proxy_sticky_session_hits_total`
- `codex_proxy_sticky_session_cold_starts_total`
- `codex_proxy_sticky_session_evictions_total{reason=...}`
- `codex_proxy_sticky_session_busy_total{reason=...}`
- `codex_proxy_session_mode_total{mode,status}`

Health:
- add `sticky_pool` object to `/health` without breaking existing `status`, `uptime`, `version`.

Gate:
- metrics/server tests prove no raw session key appears.

---

### Task 7 — Protocol and docs

Files:
- create/update `PROTOCOL.md` if present, otherwise add a session protocol section to `README.md`
- update `README.md`
- update `docs/openclaw.md`
- update `docs/macos-launchagent.md` env section if relevant
- update `docs/OCTO_FEATURE_PLAN.md` parity roadmap
- optionally update shared infra docs after implementation lands, not before, to avoid documenting unshipped behavior as live

Docs must say:
- default remains normal OpenAI-compatible behavior;
- sticky requires opt-in env + request key;
- long TTL preserves local app-server/thread continuity, not guaranteed server-side cache warmth;
- do not expose remotely without auth/rate limiting;
- raw keys are hashed/redacted.

Gate:
- `grep -R "CLAUDE_PROXY\|Claude" docs README.md PROTOCOL.md` should not find copy/paste leftovers except explicit “adapted from Claude Proxy” references in PRD/plan.

---

### Task 8 — Live validation

Run on a temporary port, not the LaunchAgent port first:

```bash
cd /Users/mehdichaouachi/.openclaw/projects/codex-proxy
npm run build
CODEX_PROXY_PORT=3467 \
CODEX_PROXY_STICKY_SESSIONS=1 \
CODEX_PROXY_STICKY_MAX_SESSIONS=2 \
CODEX_PROXY_STICKY_DEFAULT_TTL_SECONDS=300 \
CODEX_PROXY_RUNTIME=pool \
npm start
```

Smoke tests:

1. Default request, no sticky header: succeeds and metrics show no sticky hit.
2. Sticky turn 1: ask Codex to remember a nonce.
3. Sticky turn 2 with same `X-Codex-Proxy-Session-Key`: Codex recalls nonce; metrics show cold start + hit.
4. Same key with `X-Codex-Proxy-Session-Reset: 1`: old continuity cleared.
5. `X-Codex-Proxy-Session-Mode: stateless`: no sticky metrics/session reuse.
6. Invalid key/control char: HTTP 400.
7. TTL/LRU probe with tiny TTL/max.
8. Responses API streaming/non-streaming with sticky key.

Final gate:
- `npm run build`
- `npm test`
- temporary live sticky smoke passes
- no raw key in `/metrics`

---

## Recommended implementation order

1. Types + parser tests/parser.
2. Session pool lifecycle/fingerprint upgrades.
3. Route integration.
4. Metrics/health.
5. Docs.
6. Live smoke.

This keeps the dangerous part — live Codex thread continuity — isolated until parser and pool semantics are deterministic.
