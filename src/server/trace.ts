import { CONFIG } from "./config.js";

const REDACT_KEY_RE = /(authorization|api[-_]?key|token|secret|password|cookie|set-cookie|credential|bearer)/i;
const SECRET_VALUE_RE = /\b(?:sk|sk-proj|sess|ghp|github_pat|xox[baprs]|ya29|AKIA|ASIA)[A-Za-z0-9_\-]{12,}\b/g;
const BEARER_VALUE_RE = /\bBearer\s+[A-Za-z0-9._~+\/=\-]{12,}\b/gi;
const MAX_STRING = 64_000;
const MAX_ARRAY = 200;
const MAX_DEPTH = 8;

export function traceEnabled(): boolean {
  return CONFIG.trace || CONFIG.debug;
}

export function trace(event: string, data?: unknown): void {
  if (!traceEnabled()) return;
  const payload = {
    ts: new Date().toISOString(),
    pid: process.pid,
    event,
    data: sanitize(data),
  };
  try {
    process.stderr.write(`[codex-proxy:trace] ${JSON.stringify(payload)}\n`);
  } catch (err) {
    process.stderr.write(`[codex-proxy:trace] {"event":"trace_write_failed","error":${JSON.stringify(String(err))}}\n`);
  }
}

export function traceError(event: string, err: unknown, data?: unknown): void {
  trace(event, { ...asObject(data), error: errorPayload(err) });
}

function asObject(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : { value };
}

function sanitize(value: unknown, depth = 0, seen = new WeakSet<object>()): unknown {
  if (depth > MAX_DEPTH) return "[MaxDepth]";
  if (value == null) return value;
  if (typeof value === "string") return sanitizeString(value);
  if (typeof value === "number" || typeof value === "boolean") return value;
  if (typeof value === "bigint") return value.toString();
  if (typeof value === "symbol") return String(value);
  if (typeof value === "function") return `[Function:${value.name || "anonymous"}]`;
  if (value instanceof Error) return errorPayload(value);
  if (Buffer.isBuffer(value)) return `[Buffer:${value.length}]`;
  if (value instanceof Date) return value.toISOString();
  if (typeof value !== "object") return String(value);
  if (seen.has(value)) return "[Circular]";
  seen.add(value);

  if (Array.isArray(value)) {
    const items = value.slice(0, MAX_ARRAY).map((item) => sanitize(item, depth + 1, seen));
    if (value.length > MAX_ARRAY) items.push(`…[truncated:${value.length}]`);
    return items;
  }

  const out: Record<string, unknown> = {};
  for (const [key, child] of Object.entries(value as Record<string, unknown>)) {
    if (REDACT_KEY_RE.test(key)) {
      out[key] = "[REDACTED]";
    } else {
      out[key] = sanitize(child, depth + 1, seen);
    }
  }
  return out;
}

function sanitizeString(value: string): string {
  const truncated = value.length > MAX_STRING ? `${value.slice(0, MAX_STRING)}…[truncated:${value.length}]` : value;
  return truncated
    .replace(BEARER_VALUE_RE, "Bearer [REDACTED]")
    .replace(SECRET_VALUE_RE, "[REDACTED_SECRET]");
}

function errorPayload(err: unknown): Record<string, unknown> {
  if (err instanceof Error) {
    const extra: Record<string, unknown> = {};
    for (const [key, value] of Object.entries(err as unknown as Record<string, unknown>)) {
      extra[key] = sanitize(value);
    }
    return {
      name: err.name,
      message: sanitizeString(err.message),
      stack: err.stack ? sanitizeString(err.stack) : err.stack,
      ...extra,
    };
  }
  return { message: sanitizeString(String(err)), value: sanitize(err) };
}
