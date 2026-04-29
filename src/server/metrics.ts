/**
 * Prometheus-style metrics with fixed label sets.
 *
 * Keep cardinality bounded: never label by prompt, request id, raw error text,
 * arbitrary client model ids, or app-server stderr.
 */

import { canonicalModelLabel } from "../adapter/openai-to-codex.js";

type EndpointLabel = "chat" | "chat_completions" | "responses" | "models" | "health" | "metrics" | "other";
type StatusLabel = "ok" | "error";
type ExitReason = "clean" | "signal" | "error" | "timeout" | "killed" | "unknown";

interface RequestRecord {
  endpoint: string;
  model: string;
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
const subprocessExits: Record<ExitReason, number> = {
  clean: 0,
  signal: 0,
  error: 0,
  timeout: 0,
  killed: 0,
  unknown: 0,
};

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
  const status = rec.status === "ok" ? "ok" : "error";
  const key = `${endpoint}|${model}|${status}`;
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

function sanitizeLabels(labels?: Record<string, string>): Record<string, string> | undefined {
  if (!labels) return undefined;
  const out: Record<string, string> = {};
  for (const [key, value] of Object.entries(labels)) {
    if (key === "model") out[key] = canonicalModelLabel(value);
    else if (key === "endpoint") out[key] = canonicalEndpoint(value);
    else if (key === "status") out[key] = value === "ok" ? "ok" : "error";
    else out[key] = safeLabel(value);
  }
  return out;
}

function canonicalEndpoint(endpoint: string): EndpointLabel {
  return ENDPOINTS.has(endpoint as EndpointLabel) ? endpoint as EndpointLabel : "other";
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

export function renderMetrics(): string {
  const lines: string[] = [];

  lines.push("# HELP codex_proxy_requests_total Total HTTP requests");
  lines.push("# TYPE codex_proxy_requests_total counter");
  for (const [key, bucket] of requestRecords) {
    const [endpoint, model, status] = key.split("|");
    lines.push(`codex_proxy_requests_total{endpoint="${endpoint}",model="${model}",status="${status}"} ${bucket.count}`);
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
    const [endpoint, model, status] = key.split("|");
    const labels = `endpoint="${endpoint}",model="${model}",status="${status}"`;
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

  lines.push("# HELP codex_proxy_subprocess_exits_total Codex app-server subprocess exits");
  lines.push("# TYPE codex_proxy_subprocess_exits_total counter");
  for (const [reason, count] of Object.entries(subprocessExits)) {
    lines.push(`codex_proxy_subprocess_exits_total{reason="${reason}"} ${count}`);
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
  requestRecords.clear();
  for (const key of Object.keys(subprocessExits) as ExitReason[]) subprocessExits[key] = 0;
}
