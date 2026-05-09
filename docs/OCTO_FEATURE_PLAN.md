# codex-proxy — Octo Feature Plan

Date: 2026-05-01

## Positioning

`codex-proxy` should be the production-grade OpenAI-compatible gateway for official Codex app-server traffic: strong SDK compatibility, explicit sticky session/thread semantics, sandbox/approval policy, reliable Responses behavior, and clean operational packaging.

It should stay small enough to trust. The proxy should translate, observe, and enforce policy — not become the tool executor, router, workflow engine, and database all at once. That’s how “small bridge” becomes “haunted bridge with a Kubernetes dependency.”

## Octo debate synthesis

### Balanced analyst

Because `codex-proxy` sits on the official `codex app-server`, it is the better candidate for reference OpenAI compatibility. Prioritize Responses API parity, security policy, and durable minimal state. Keep OAuth/session ownership inside Codex itself.

### Innovative advocate

Push `codex-proxy` toward a production backbone: virtual keys, approval UI, durable response/thread state, OpenTelemetry traces, and strong SDK fixtures. Let it be the reliable factory while `claude-proxy` remains the faster/extensible Claude lab.

### Pragmatic engineer

First clean the docs and release surface. Then make Responses first-class, add thin security before any non-local exposure, and implement only the minimal durable state needed for `previous_response_id` or session restoration. Do not overbuild routing/caching/batching until real clients demand it.

## Phase 0 — documentation and release hygiene

- Keep README status aligned with `package.json`, `/health`, git tags, and infra docs.
- Document current multi-tool-call bridge support accurately.
- Keep caveats current: Responses is improved but not full OpenAI durable Responses; multimodal inputs are flattened/placeheld; Codex OAuth remains owned by the official CLI/app-server.
- Add release checklist gates for version consistency, docs freshness, build, tests, smoke, and optional live release checklist.

Acceptance checks:

- `npm run build`
- `npm test`
- `scripts/release-checklist.sh` where available
- `npm run smoke` against a running local proxy when safe

## Phase 1 — first-class Responses compatibility

Goal: make `codex-proxy` the strongest local OpenAI-compatible Responses implementation in this pair.

Deliverables:

- Expand SDK fixture tests for OpenAI Node/Python common request shapes: string input, message arrays, mixed content, function-call outputs, reasoning/summary items, metadata, `instructions`, `tool_choice`, and streaming.
- Normalize streaming events and aliases expected by current OpenAI SDK clients: creation, in-progress, output item/content part, text delta/done, function-call item, completed/done.
- Preserve usage fields across Responses and Chat: cached tokens, reasoning tokens, estimated cost, and estimate method.
- Improve error shapes for unsupported content parts so clients get actionable `invalid_request_error` responses instead of vague failures.

Acceptance checks:

- SDK fixture test suite passes without needing live Codex.
- Live `/v1/responses` smoke passes for non-streaming, streaming, and tool-call scenarios.

## Phase 1.5 — generic opt-in sticky sessions

Status: implemented on the sticky-session branch.

Deliverables:

- Preferred `X-Codex-Proxy-Session-Key` plus legacy `X-Codex-Proxy-Session` compatibility.
- `pool | sticky | stateless` mode parsing from headers or `codex_proxy` body extension.
- Per-request TTL/reset/policy fields, server-side TTL clamps, absolute TTL, max-session bounds, and queue timeout.
- Hashed-key observability, sticky metrics, health payload stats, and OpenAI-style validation errors.
- Default behavior remains normal pooled-worker/fresh-thread OpenAI-compatible requests.

Acceptance checks:

- `npm run build`
- `npm test`
- live sticky smoke with same-key nonce recall when safe.

## Phase 2 — minimal durable response/thread state

Goal: support practical `previous_response_id` and session restoration without building a full conversation database.

Deliverables:

- Add optional local state provider: filesystem or SQLite, TTL-bounded by default.
- Map response IDs to sanitized session/thread metadata and compatible model/options fingerprint.
- Support `previous_response_id` lookup where the backing Codex session/thread can safely continue.
- Refuse mismatched model/options/session state with OpenAI-style errors.
- Add metrics for state hits, misses, expirations, and incompatible lookups.

Acceptance checks:

- Works when enabled; disabled remains current stateless behavior.
- Restart test proves resumable metadata survives if configured.
- No prompts, OAuth tokens, or raw secrets are written to state by default.

## Phase 3 — security and policy layer

Goal: keep localhost easy, but make non-local or multi-client use survivable.

Deliverables:

- Optional virtual API keys.
- Per-key policy: allowed models, allowed runtime modes, session access, max body, max request duration, rate limits, sandbox and approval policy binding.
- Strong startup warning or refusal when binding non-loopback without auth.
- Origin validation for browser/CORS use.
- Secret redaction across logs, traces, and metrics.
- Policy-aware errors that explain what was denied without leaking policy internals.

Acceptance checks:

- Default localhost/no-auth behavior remains unchanged.
- Non-loopback bind without auth is blocked or loudly refused unless explicitly overridden.
- Per-key policy tests cover allow, deny, rate-limit, and sandbox binding.

## Phase 4 — approval and sandbox bridge

Goal: expose Codex’s approval/sandbox model cleanly to callers.

Deliverables:

- Surface pending approval events from app-server where available.
- Provide an approval decision endpoint or event channel for local UIs/orchestrators.
- Record approval waits and decisions in traces.
- Keep `CODEX_PROXY_SANDBOX` and `CODEX_PROXY_APPROVAL_POLICY` conservative by default, with explicit docs for trusted localhost full-access mode.

Acceptance checks:

- Approval-needed flows do not hang silently.
- Denied approvals return clear OpenAI-compatible errors or tool-call results.

## Phase 5 — tool trace and replay

Goal: make multi-tool agent loops diagnosable.

Deliverables:

- Generate `X-Codex-Proxy-Trace-Id` per request.
- Record recent traces with redaction: model, runtime, session hit/miss, tools offered, emitted tool calls, arguments, tool result reinjection, fallback path, app-server event sequence, error class.
- Add optional local `GET /traces/:id` for recent records.
- Add tests for multiple tool calls, malformed tool JSON, duplicate JSON, streaming tool calls, and tool-result follow-up.

Acceptance checks:

- Multi-tool bridge traces show all emitted tool calls in order.
- Trace data never includes OAuth tokens or raw sensitive env values.

## Phase 6 — thin observability export

Goal: integrate with the rest of the stack without inventing another dashboard.

Deliverables:

- Optional OpenTelemetry spans for HTTP request, app-server turn, first token, tool-call emission, fallback, session/state lookup, and stream close.
- Optional Langfuse/OpenInference export.
- Redaction configuration for prompt/tool/file data.

Acceptance checks:

- Disabled by default.
- Enabled mode correlates response header trace IDs, Prometheus metrics, and exported spans.

## Optional later features

- Batch endpoint for many independent prompts/files.
- Response cache for deterministic low-temperature requests.
- Repo-index cache for repeated codebase analysis.
- Model routing/fallback between Codex, Claude, and direct API providers — preferably above the proxy unless a concrete client demands it here.
- WebSocket transport exploration only after the official Codex WebSocket API is stable enough to justify the risk.

## Non-goals

- Do not copy, store, print, or manage Codex OAuth tokens.
- Do not reintroduce OmniRoute for Codex routing.
- Do not execute OpenClaw external tools inside the proxy; emit `tool_calls` and let the caller dispatch.
- Do not expose the proxy publicly without auth, policy, and origin controls.
