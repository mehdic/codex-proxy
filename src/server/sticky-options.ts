import { createHash } from "node:crypto";
import type { ProxyConfig } from "./config.js";
import type { CodexProxyRequestExtension, CodexProxySessionMode, CodexProxySessionPolicy } from "../types/openai.js";

export type SessionMode = CodexProxySessionMode;
export type SessionPolicy = CodexProxySessionPolicy;

export interface StickyOptionsRequest {
  body?: unknown;
  header(name: string): string | string[] | undefined;
}

export interface ResolvedSessionOptions {
  mode: SessionMode;
  explicit: boolean;
  sticky?: {
    rawKey: string;
    keyHash: string;
    keyHashShort: string;
    ttlSeconds: number;
    reset: boolean;
    policy: SessionPolicy;
    legacyHeader: boolean;
  };
}

export type SessionOptionsResult = {
  kind: "ok";
  options: ResolvedSessionOptions;
} | {
  kind: "invalid";
  code: string;
  message: string;
  options: ResolvedSessionOptions;
};

const VALID_MODES = new Set<SessionMode>(["pool", "sticky", "stateless"]);
const VALID_POLICIES = new Set<SessionPolicy>(["strict", "compatible"]);

export function resolveSessionOptions(req: StickyOptionsRequest | undefined, config: ProxyConfig): SessionOptionsResult {
  if (!req) return ok({ mode: "pool", explicit: false });

  const bodyExt = readBodyExtension(req.body, config.stickyAllowBodyOptions);
  const preferredKey = readHeader(req, "x-codex-proxy-session-key");
  const legacyKey = readHeader(req, "x-codex-proxy-session");
  const headerMode = readHeader(req, "x-codex-proxy-session-mode");
  const headerTtl = readHeader(req, "x-codex-proxy-session-ttl-seconds");
  const headerReset = readHeader(req, "x-codex-proxy-session-reset");
  const headerPolicy = readHeader(req, "x-codex-proxy-session-policy");

  const bodyKey = readFirst(bodyExt, ["session_key", "sessionKey", "session"]);
  const rawKey = preferredKey ?? legacyKey ?? bodyKey;
  const legacyHeader = preferredKey === undefined && legacyKey !== undefined;
  const rawMode = headerMode ?? readFirst(bodyExt, ["session_mode", "sessionMode", "mode"]);
  const rawTtl = headerTtl ?? readFirst(bodyExt, ["session_ttl_seconds", "sessionTtlSeconds", "ttl_seconds"]);
  const rawReset = headerReset ?? readFirst(bodyExt, ["session_reset", "sessionReset", "reset"]);
  const rawPolicy = headerPolicy ?? readFirst(bodyExt, ["session_policy", "sessionPolicy", "policy"]);

  const keyWasProvided = rawKey !== undefined && rawKey !== null && String(rawKey).trim().length > 0;
  const mode = normalizeMode(rawMode, keyWasProvided);
  if (!mode) return invalid("invalid_session_mode", "Session mode must be one of: pool, sticky, stateless");

  const explicit = Boolean(keyWasProvided || rawMode !== undefined || rawTtl !== undefined || rawReset !== undefined || rawPolicy !== undefined);
  if (mode !== "sticky") return ok({ mode, explicit });

  if (!config.stickySessionsEnabled) {
    return ok({ mode: "pool", explicit: false });
  }

  const key = normalizeSessionKey(rawKey, legacyHeader ? Math.min(config.stickyKeyMaxLength, 128) : config.stickyKeyMaxLength);
  if (!key) return invalid("invalid_session_key", `X-Codex-Proxy-Session-Key must be a non-empty string up to ${config.stickyKeyMaxLength} characters`);

  const ttlRaw = rawTtl === undefined || rawTtl === null || String(rawTtl).trim() === "" ? config.stickyDefaultTtlSeconds : Number.parseInt(String(rawTtl), 10);
  if (!Number.isFinite(ttlRaw) || ttlRaw <= 0) return invalid("invalid_session_ttl", "Session TTL must be a positive integer number of seconds");

  const policy = normalizePolicy(rawPolicy);
  if (!policy) return invalid("invalid_session_policy", "Session policy must be strict or compatible");

  const keyHash = createHash("sha256").update(key).digest("hex");
  return ok({
    mode: "sticky",
    explicit: true,
    sticky: {
      rawKey: key,
      keyHash,
      keyHashShort: keyHash.slice(0, 12),
      ttlSeconds: clamp(ttlRaw, config.stickyMinTtlSeconds, config.stickyMaxTtlSeconds),
      reset: parseBoolean(rawReset) === true,
      policy,
      legacyHeader,
    },
  });
}

function ok(options: ResolvedSessionOptions): SessionOptionsResult {
  return { kind: "ok", options };
}

function invalid(code: string, message: string): SessionOptionsResult {
  return { kind: "invalid", code, message, options: { mode: "pool", explicit: true } };
}

function readHeader(req: StickyOptionsRequest, name: string): string | undefined {
  const value = req.header(name);
  if (Array.isArray(value)) return value[0];
  return typeof value === "string" ? value : undefined;
}

function readBodyExtension(body: unknown, allow: boolean): CodexProxyRequestExtension | undefined {
  if (!allow || !body || typeof body !== "object" || Array.isArray(body)) return undefined;
  const ext = (body as { codex_proxy?: unknown }).codex_proxy;
  if (!ext || typeof ext !== "object" || Array.isArray(ext)) return undefined;
  return ext as CodexProxyRequestExtension;
}

function readFirst(ext: CodexProxyRequestExtension | undefined, keys: Array<keyof CodexProxyRequestExtension>): unknown {
  if (!ext) return undefined;
  for (const key of keys) {
    if (Object.prototype.hasOwnProperty.call(ext, key)) return ext[key];
  }
  return undefined;
}

function normalizeMode(raw: unknown, keyWasProvided: boolean): SessionMode | undefined {
  if (raw === undefined || raw === null || String(raw).trim() === "") return keyWasProvided ? "sticky" : "pool";
  const normalized = String(raw).trim().toLowerCase();
  return VALID_MODES.has(normalized as SessionMode) ? normalized as SessionMode : undefined;
}

function normalizePolicy(raw: unknown): SessionPolicy | undefined {
  if (raw === undefined || raw === null || String(raw).trim() === "") return "strict";
  const normalized = String(raw).trim().toLowerCase();
  return VALID_POLICIES.has(normalized as SessionPolicy) ? normalized as SessionPolicy : undefined;
}

export function normalizeSessionKey(raw: unknown, maxLength: number): string | undefined {
  if (typeof raw !== "string" && typeof raw !== "number") return undefined;
  const key = String(raw).trim();
  if (!key || key.length > maxLength) return undefined;
  if (/[\u0000-\u001F\u007F]/.test(key)) return undefined;
  return key;
}

function parseBoolean(raw: unknown): boolean | undefined {
  if (typeof raw === "boolean") return raw;
  if (typeof raw === "number") return raw !== 0;
  if (typeof raw !== "string") return undefined;
  const normalized = raw.trim().toLowerCase();
  if (["1", "true", "yes", "on"].includes(normalized)) return true;
  if (["0", "false", "no", "off", ""].includes(normalized)) return false;
  return undefined;
}

function clamp(value: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, Math.trunc(value)));
}
