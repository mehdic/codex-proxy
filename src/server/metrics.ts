/**
 * Simple Prometheus-style metrics for the codex-proxy.
 */

// ── Counters ─────────────────────────────────────────────────────────

const counters: Record<string, number> = {};
const histogramSums: Record<string, number> = {};
const histogramCounts: Record<string, number> = {};

export function incCounter(name: string, labels?: Record<string, string>): void {
  const key = labeledKey(name, labels);
  counters[key] = (counters[key] || 0) + 1;
}

export function observeHistogram(name: string, value: number, labels?: Record<string, string>): void {
  const key = labeledKey(name, labels);
  histogramSums[key] = (histogramSums[key] || 0) + value;
  histogramCounts[key] = (histogramCounts[key] || 0) + 1;
}

function labeledKey(name: string, labels?: Record<string, string>): string {
  if (!labels || Object.keys(labels).length === 0) return name;
  const parts = Object.entries(labels)
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([k, v]) => `${k}="${v}"`)
    .join(",");
  return `${name}{${parts}}`;
}

// ── Rendering ────────────────────────────────────────────────────────

export function renderMetrics(): string {
  const lines: string[] = [];

  lines.push("# HELP codex_proxy_requests_total Total HTTP requests");
  lines.push("# TYPE codex_proxy_requests_total counter");
  for (const [key, val] of Object.entries(counters)) {
    if (key.startsWith("codex_proxy_requests_total")) {
      lines.push(`${key} ${val}`);
    }
  }

  lines.push("# HELP codex_proxy_errors_total Total errors");
  lines.push("# TYPE codex_proxy_errors_total counter");
  for (const [key, val] of Object.entries(counters)) {
    if (key.startsWith("codex_proxy_errors_total")) {
      lines.push(`${key} ${val}`);
    }
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

  // Uptime
  lines.push("# HELP codex_proxy_uptime_seconds Proxy uptime in seconds");
  lines.push("# TYPE codex_proxy_uptime_seconds gauge");
  lines.push(`codex_proxy_uptime_seconds ${Math.floor(process.uptime())}`);

  lines.push("");
  return lines.join("\n");
}

/** Reset all metrics (for testing). */
export function resetMetrics(): void {
  for (const key of Object.keys(counters)) delete counters[key];
  for (const key of Object.keys(histogramSums)) delete histogramSums[key];
  for (const key of Object.keys(histogramCounts)) delete histogramCounts[key];
}
