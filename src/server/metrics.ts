/**
 * Prometheus-style metrics with fixed label sets.
 *
 * Keep cardinality bounded: never label by prompt, request id, raw error text,
 * arbitrary client model ids, or app-server stderr.
 */

import { canonicalModelLabel } from "../adapter/openai-to-codex.js";
import type { TokenUsageBreakdown } from "../types/codex.js";
import type { UsageCostEstimate } from "./pricing.js";

type EndpointLabel = "chat" | "chat_completions" | "responses" | "models" | "health" | "metrics" | "other";
type StatusLabel = "ok" | "error";
type RuntimeLabel = "pool" | "oneshot";
type ExitReason = "clean" | "signal" | "error" | "timeout" | "killed" | "unknown";
type PoolEvent = "warm_hit" | "cold_spawn" | "ttl_eviction" | "lru_eviction" | "stale_eviction" | "prewarm_error";
type FallbackReason = "pool_failure";
type SessionEvent = "hit" | "miss" | "created" | "evicted" | "expired" | "rejected" | "reset";
type StickyEvictionReason = "idle_ttl" | "absolute_ttl" | "lru" | "unhealthy" | "reset" | "client_disconnect" | "turn_error" | "evicted";
type StickyBusyReason = "active" | "capacity" | "queue_timeout";
type SessionModeLabel = "pool" | "sticky" | "stateless";
type ModeStatusLabel = "accepted" | "rejected";

interface RequestRecord {
  endpoint: string;
  model: string;
  runtime?: string;
  status: StatusLabel;
  durationMs: number;
}

interface RequestBucket {
  count: number;
  sumDurationMs: number;
  buckets: Record<number, number>;
}

const counters: Record<string, number> = {};
const histogramSums: Record<string, number> = {};
const histogramCounts: Record<string, number> = {};
const requestRecords = new Map<string, RequestBucket>();
const poolEvents: Record<PoolEvent, number> = {
  warm_hit: 0,
  cold_spawn: 0,
  ttl_eviction: 0,
  lru_eviction: 0,
  stale_eviction: 0,
  prewarm_error: 0,
};
const fallbacks: Record<FallbackReason, number> = {
  pool_failure: 0,
};
const sessionEvents: Record<SessionEvent, number> = {
  hit: 0,
  miss: 0,
  created: 0,
  evicted: 0,
  expired: 0,
  rejected: 0,
  reset: 0,
};
const stickyEvictions: Record<StickyEvictionReason, number> = {
  idle_ttl: 0,
  absolute_ttl: 0,
  lru: 0,
  unhealthy: 0,
  reset: 0,
  client_disconnect: 0,
  turn_error: 0,
  evicted: 0,
};
const stickyBusy: Record<StickyBusyReason, number> = {
  active: 0,
  capacity: 0,
  queue_timeout: 0,
};
const stickyModes: Record<SessionModeLabel, Record<ModeStatusLabel, number>> = {
  pool: { accepted: 0, rejected: 0 },
  sticky: { accepted: 0, rejected: 0 },
  stateless: { accepted: 0, rejected: 0 },
};
let stickyHits = 0;
let stickyColdStarts = 0;
let poolSize = 0;
let activeSessions = 0;
const subprocessExits: Record<ExitReason, number> = {
  clean: 0,
  signal: 0,
  error: 0,
  timeout: 0,
  killed: 0,
  unknown: 0,
};
const tokenCounters: Record<string, number> = {};
const costCounters: Record<string, number> = {};

const REQUEST_BUCKETS_MS = [100, 250, 500, 1000, 2500, 5000, 10_000, 30_000, 60_000, 120_000];
const ENDPOINTS = new Set<EndpointLabel>(["chat", "chat_completions", "responses", "models", "health", "metrics", "other"]);

export function incCounter(name: string, labels?: Record<string, string>): void {
  const key = labeledKey(name, sanitizeLabels(labels));
  counters[key] = (counters[key] || 0) + 1;
}

export function observeHistogram(name: string, value: number, labels?: Record<string, string>): void {
  const key = labeledKey(name, sanitizeLabels(labels));
  histogramSums[key] = (histogramSums[key] || 0) + value;
  histogramCounts[key] = (histogramCounts[key] || 0) + 1;
}

export function recordRequest(rec: RequestRecord): void {
  const endpoint = canonicalEndpoint(rec.endpoint);
  const model = canonicalModelLabel(rec.model);
  const runtime = canonicalRuntime(rec.runtime);
  const status = rec.status === "ok" ? "ok" : "error";
  const key = `${endpoint}|${model}|${runtime}|${status}`;
  let bucket = requestRecords.get(key);
  if (!bucket) {
    bucket = {
      count: 0,
      sumDurationMs: 0,
      buckets: Object.fromEntries(REQUEST_BUCKETS_MS.map((b) => [b, 0])),
    };
    requestRecords.set(key, bucket);
  }

  bucket.count++;
  bucket.sumDurationMs += Math.max(0, rec.durationMs);
  for (const le of REQUEST_BUCKETS_MS) {
    if (rec.durationMs <= le) bucket.buckets[le]++;
  }
}

export function recordSubprocessExit(reason: string): void {
  const label = canonicalExitReason(reason);
  subprocessExits[label]++;
}

export function recordPoolEvent(event: string): void {
  const label = canonicalPoolEvent(event);
  poolEvents[label]++;
}

export function recordFallback(reason: string): void {
  const label = canonicalFallbackReason(reason);
  fallbacks[label]++;
}

export function recordSessionEvent(event: string): void {
  const label = canonicalSessionEvent(event);
  sessionEvents[label]++;
}

export function recordStickySessionHit(): void {
  stickyHits++;
}

export function recordStickySessionStart(): void {
  stickyColdStarts++;
}

export function recordStickySessionEviction(reason: string): void {
  stickyEvictions[canonicalStickyEviction(reason)]++;
}

export function recordStickySessionBusy(reason: string): void {
  stickyBusy[canonicalStickyBusy(reason)]++;
}

export function recordStickySessionMode(mode: string, status: string): void {
  stickyModes[canonicalSessionMode(mode)][status === "rejected" ? "rejected" : "accepted"]++;
}

export function recordTokenUsage(model: string, usage: TokenUsageBreakdown, cost: UsageCostEstimate | undefined, estimated: boolean): void {
  const labels = { model: canonicalModelLabel(model), estimated: estimated ? "true" : "false" };
  addLabeled(tokenCounters, "codex_proxy_tokens_total", usage.inputTokens || 0, { ...labels, direction: "input" });
  addLabeled(tokenCounters, "codex_proxy_tokens_total", usage.cachedInputTokens || 0, { ...labels, direction: "cached_input" });
  addLabeled(tokenCounters, "codex_proxy_tokens_total", usage.outputTokens || 0, { ...labels, direction: "output" });
  addLabeled(tokenCounters, "codex_proxy_tokens_total", usage.reasoningOutputTokens || 0, { ...labels, direction: "reasoning_output" });
  addLabeled(tokenCounters, "codex_proxy_tokens_total", usage.totalTokens || 0, { ...labels, direction: "total" });
  if (cost) addLabeled(costCounters, "codex_proxy_estimated_cost_usd_total", cost.total_cost_usd, labels);
}

export function setPoolSize(size: number): void {
  poolSize = Math.max(0, Math.floor(size));
}

export function setSessionCount(size: number): void {
  activeSessions = Math.max(0, Math.floor(size));
}

function sanitizeLabels(labels?: Record<string, string>): Record<string, string> | undefined {
  if (!labels) return undefined;
  const out: Record<string, string> = {};
  for (const [key, value] of Object.entries(labels)) {
    if (key === "model") out[key] = canonicalModelLabel(value);
    else if (key === "endpoint") out[key] = canonicalEndpoint(value);
    else if (key === "runtime") out[key] = canonicalRuntime(value);
    else if (key === "status") out[key] = value === "ok" ? "ok" : "error";
    else out[key] = safeLabel(value);
  }
  return out;
}

function canonicalRuntime(runtime: string | undefined): RuntimeLabel {
  return runtime === "oneshot" ? "oneshot" : "pool";
}

function canonicalEndpoint(endpoint: string): EndpointLabel {
  return ENDPOINTS.has(endpoint as EndpointLabel) ? endpoint as EndpointLabel : "other";
}

function canonicalPoolEvent(event: string): PoolEvent {
  switch (event) {
    case "warm_hit":
    case "cold_spawn":
    case "ttl_eviction":
    case "lru_eviction":
    case "stale_eviction":
    case "prewarm_error":
      return event;
    default:
      return "prewarm_error";
  }
}

function canonicalFallbackReason(reason: string): FallbackReason {
  return reason === "pool_failure" ? "pool_failure" : "pool_failure";
}

function canonicalSessionEvent(event: string): SessionEvent {
  switch (event) {
    case "hit":
    case "miss":
    case "created":
    case "evicted":
    case "expired":
    case "rejected":
    case "reset":
      return event;
    default:
      return "rejected";
  }
}

function canonicalStickyEviction(reason: string): StickyEvictionReason {
  switch (reason) {
    case "idle_ttl":
    case "absolute_ttl":
    case "lru":
    case "unhealthy":
    case "reset":
    case "client_disconnect":
    case "turn_error":
    case "evicted":
      return reason;
    default:
      return "evicted";
  }
}

function canonicalStickyBusy(reason: string): StickyBusyReason {
  switch (reason) {
    case "active":
    case "capacity":
    case "queue_timeout":
      return reason;
    default:
      return "active";
  }
}

function canonicalSessionMode(mode: string): SessionModeLabel {
  switch (mode) {
    case "sticky":
    case "stateless":
    case "pool":
      return mode;
    default:
      return "pool";
  }
}

function canonicalExitReason(reason: string): ExitReason {
  switch (reason) {
    case "clean":
    case "signal":
    case "error":
    case "timeout":
    case "killed":
      return reason;
    default:
      return "unknown";
  }
}

function stickyMaxSessionsForMetrics(): number {
  const parsed = Number.parseInt(process.env.CODEX_PROXY_STICKY_MAX_SESSIONS || process.env.CODEX_PROXY_SESSION_MAX || "32", 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : 32;
}

function safeLabel(value: string): string {
  return value.replace(/[^a-zA-Z0-9_.:-]/g, "_").slice(0, 80) || "unknown";
}

function escapeLabel(value: string): string {
  return value.replace(/\\/g, "\\\\").replace(/"/g, '\\"').replace(/\n/g, "\\n");
}

function labeledKey(name: string, labels?: Record<string, string>): string {
  if (!labels || Object.keys(labels).length === 0) return name;
  const parts = Object.entries(labels)
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([k, v]) => `${k}="${escapeLabel(v)}"`)
    .join(",");
  return `${name}{${parts}}`;
}

function addLabeled(target: Record<string, number>, name: string, value: number, labels?: Record<string, string>): void {
  const key = labeledKey(name, sanitizeLabels(labels));
  target[key] = (target[key] || 0) + Math.max(0, Number(value) || 0);
}

export function renderMetrics(): string {
  const lines: string[] = [];

  lines.push("# HELP codex_proxy_requests_total Total HTTP requests");
  lines.push("# TYPE codex_proxy_requests_total counter");
  for (const [key, bucket] of requestRecords) {
    const [endpoint, model, runtime, status] = key.split("|");
    lines.push(`codex_proxy_requests_total{endpoint="${endpoint}",model="${model}",runtime="${runtime}",status="${status}"} ${bucket.count}`);
  }
  for (const [key, val] of Object.entries(counters)) {
    if (key.startsWith("codex_proxy_requests_total")) lines.push(`${key} ${val}`);
  }

  lines.push("# HELP codex_proxy_errors_total Total errors");
  lines.push("# TYPE codex_proxy_errors_total counter");
  for (const [key, val] of Object.entries(counters)) {
    if (key.startsWith("codex_proxy_errors_total")) lines.push(`${key} ${val}`);
  }

  lines.push("# HELP codex_proxy_request_duration_seconds Request handler latency");
  lines.push("# TYPE codex_proxy_request_duration_seconds histogram");
  for (const [key, bucket] of requestRecords) {
    const [endpoint, model, runtime, status] = key.split("|");
    const labels = `endpoint="${endpoint}",model="${model}",runtime="${runtime}",status="${status}"`;
    for (const le of REQUEST_BUCKETS_MS) {
      lines.push(`codex_proxy_request_duration_seconds_bucket{${labels},le="${(le / 1000).toFixed(3)}"} ${bucket.buckets[le]}`);
    }
    lines.push(`codex_proxy_request_duration_seconds_bucket{${labels},le="+Inf"} ${bucket.count}`);
    lines.push(`codex_proxy_request_duration_seconds_sum{${labels}} ${(bucket.sumDurationMs / 1000).toFixed(6)}`);
    lines.push(`codex_proxy_request_duration_seconds_count{${labels}} ${bucket.count}`);
  }

  lines.push("# HELP codex_proxy_turn_duration_ms Turn duration in milliseconds");
  lines.push("# TYPE codex_proxy_turn_duration_ms summary");
  for (const [key, sum] of Object.entries(histogramSums)) {
    if (key.startsWith("codex_proxy_turn_duration_ms")) {
      const count = histogramCounts[key] || 0;
      lines.push(`${key}_sum ${sum}`);
      lines.push(`${key}_count ${count}`);
    }
  }

  lines.push("# HELP codex_proxy_tokens_total Total tokens reported or estimated by the proxy");
  lines.push("# TYPE codex_proxy_tokens_total counter");
  for (const [key, val] of Object.entries(tokenCounters)) lines.push(`${key} ${val}`);

  lines.push("# HELP codex_proxy_estimated_cost_usd_total Estimated cost in USD using public per-model API prices");
  lines.push("# TYPE codex_proxy_estimated_cost_usd_total counter");
  for (const [key, val] of Object.entries(costCounters)) lines.push(`${key} ${val.toFixed(6)}`);

  lines.push("# HELP codex_proxy_subprocess_exits_total Codex app-server subprocess exits");
  lines.push("# TYPE codex_proxy_subprocess_exits_total counter");
  for (const [reason, count] of Object.entries(subprocessExits)) {
    lines.push(`codex_proxy_subprocess_exits_total{reason="${reason}"} ${count}`);
  }

  lines.push("# HELP codex_proxy_pool_events_total Worker pool lifecycle events");
  lines.push("# TYPE codex_proxy_pool_events_total counter");
  for (const [event, count] of Object.entries(poolEvents)) {
    lines.push(`codex_proxy_pool_events_total{event="${event}"} ${count}`);
  }

  lines.push("# HELP codex_proxy_fallbacks_total Runtime fallback events");
  lines.push("# TYPE codex_proxy_fallbacks_total counter");
  for (const [reason, count] of Object.entries(fallbacks)) {
    lines.push(`codex_proxy_fallbacks_total{reason="${reason}"} ${count}`);
  }

  lines.push("# HELP codex_proxy_pool_size Current app-server worker pool size");
  lines.push("# TYPE codex_proxy_pool_size gauge");
  lines.push(`codex_proxy_pool_size ${poolSize}`);

  lines.push("# HELP codex_proxy_sessions_total Session pool lifecycle events");
  lines.push("# TYPE codex_proxy_sessions_total counter");
  for (const [event, count] of Object.entries(sessionEvents)) {
    lines.push(`codex_proxy_sessions_total{event="${event}"} ${count}`);
  }

  lines.push("# HELP codex_proxy_active_sessions Current active Codex session count");
  lines.push("# TYPE codex_proxy_active_sessions gauge");
  lines.push(`codex_proxy_active_sessions ${activeSessions}`);

  lines.push("# HELP codex_proxy_sticky_pool_size Live sessions in the opt-in sticky session pool");
  lines.push("# TYPE codex_proxy_sticky_pool_size gauge");
  lines.push(`codex_proxy_sticky_pool_size{state="live"} ${activeSessions}`);
  lines.push(`codex_proxy_sticky_pool_size{state="max"} ${stickyMaxSessionsForMetrics()}`);

  lines.push("# HELP codex_proxy_sticky_pool_enabled 1 when sticky sessions are enabled");
  lines.push("# TYPE codex_proxy_sticky_pool_enabled gauge");
  lines.push(`codex_proxy_sticky_pool_enabled ${process.env.CODEX_PROXY_STICKY_SESSIONS === "1" || process.env.CODEX_PROXY_SESSIONS === "1" ? 1 : 0}`);

  lines.push("# HELP codex_proxy_sticky_session_hits_total Sticky requests served from an existing live Codex session");
  lines.push("# TYPE codex_proxy_sticky_session_hits_total counter");
  lines.push(`codex_proxy_sticky_session_hits_total ${stickyHits}`);

  lines.push("# HELP codex_proxy_sticky_session_cold_starts_total Sticky requests that created a new live Codex session");
  lines.push("# TYPE codex_proxy_sticky_session_cold_starts_total counter");
  lines.push(`codex_proxy_sticky_session_cold_starts_total ${stickyColdStarts}`);

  lines.push("# HELP codex_proxy_sticky_session_evictions_total Sticky session evictions by bounded reason");
  lines.push("# TYPE codex_proxy_sticky_session_evictions_total counter");
  for (const [reason, count] of Object.entries(stickyEvictions)) lines.push(`codex_proxy_sticky_session_evictions_total{reason="${reason}"} ${count}`);

  lines.push("# HELP codex_proxy_sticky_session_busy_total Sticky session busy/rejection events by bounded reason");
  lines.push("# TYPE codex_proxy_sticky_session_busy_total counter");
  for (const [reason, count] of Object.entries(stickyBusy)) lines.push(`codex_proxy_sticky_session_busy_total{reason="${reason}"} ${count}`);

  lines.push("# HELP codex_proxy_session_mode_total Session mode decisions by bounded mode and status");
  lines.push("# TYPE codex_proxy_session_mode_total counter");
  for (const [mode, statuses] of Object.entries(stickyModes)) {
    for (const [status, count] of Object.entries(statuses)) lines.push(`codex_proxy_session_mode_total{mode="${mode}",status="${status}"} ${count}`);
  }

  lines.push("# HELP codex_proxy_uptime_seconds Proxy uptime in seconds");
  lines.push("# TYPE codex_proxy_uptime_seconds gauge");
  lines.push(`codex_proxy_uptime_seconds ${Math.floor(process.uptime())}`);

  lines.push("");
  return lines.join("\n");
}

export function resetMetrics(): void {
  for (const key of Object.keys(counters)) delete counters[key];
  for (const key of Object.keys(histogramSums)) delete histogramSums[key];
  for (const key of Object.keys(histogramCounts)) delete histogramCounts[key];
  for (const key of Object.keys(tokenCounters)) delete tokenCounters[key];
  for (const key of Object.keys(costCounters)) delete costCounters[key];
  requestRecords.clear();
  for (const key of Object.keys(poolEvents) as PoolEvent[]) poolEvents[key] = 0;
  for (const key of Object.keys(fallbacks) as FallbackReason[]) fallbacks[key] = 0;
  for (const key of Object.keys(sessionEvents) as SessionEvent[]) sessionEvents[key] = 0;
  for (const key of Object.keys(stickyEvictions) as StickyEvictionReason[]) stickyEvictions[key] = 0;
  for (const key of Object.keys(stickyBusy) as StickyBusyReason[]) stickyBusy[key] = 0;
  for (const mode of Object.keys(stickyModes) as SessionModeLabel[]) {
    stickyModes[mode].accepted = 0;
    stickyModes[mode].rejected = 0;
  }
  stickyHits = 0;
  stickyColdStarts = 0;
  poolSize = 0;
  activeSessions = 0;
  for (const key of Object.keys(subprocessExits) as ExitReason[]) subprocessExits[key] = 0;
}
