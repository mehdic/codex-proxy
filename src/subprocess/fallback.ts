import { normalizeError } from "../server/errors.js";

const REAL_CODEX_ERROR_PATTERNS = [
  "auth",
  "login",
  "oauth",
  "unauthorized",
  "forbidden",
  "rate_limit",
  "quota",
  "billing",
  "model not found",
  "invalid model",
  "content_policy",
  "policy violation",
];

const TRANSPORT_PATTERNS = [
  "app-server process is dead",
  "app-server exited",
  "process is dead",
  "broken pipe",
  "stdin not writable",
  "json-rpc",
  "protocol",
  "thread/start timed out",
  "initialize timed out",
  "turn timed out",
  "timed out",
];

export function isPoolTransportFault(err: unknown): boolean {
  if (!(err instanceof Error)) return false;
  const normalized = normalizeError(err);
  const msg = `${normalized.message} ${normalized.detail || ""}`.toLowerCase();
  if (REAL_CODEX_ERROR_PATTERNS.some((pattern) => msg.includes(pattern))) return false;
  if (normalized.kind === "spawn") return true;
  if (normalized.kind === "timeout" || normalized.kind === "protocol") return true;
  if (normalized.kind === "codex") {
    return TRANSPORT_PATTERNS.some((pattern) => msg.includes(pattern));
  }
  return false;
}
