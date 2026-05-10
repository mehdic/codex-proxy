export interface ProxyConfig {
  host: string;
  port: number;
  maxBodySize: string;
  defaultModel: string;
  runtime: "pool" | "oneshot";
  allowRuntimeOverride: boolean;
  codexBin: string;
  defaultTimeoutMs: number;
  turnStartTimeoutMs: number;
  initTimeoutMs: number;
  healthTimeoutMs: number;
  shutdownGraceMs: number;
  poolMax: number;
  poolTtlMs: number;
  prewarmModels: string[];
  initPool: boolean;
  fallbackOnPoolFailure: boolean;
  keepaliveMs: number;
  sessionsEnabled: boolean;
  sessionTtlMs: number;
  sessionMax: number;
  stickySessionsEnabled: boolean;
  stickyAllowBodyOptions: boolean;
  stickyKeyMaxLength: number;
  stickyDefaultTtlSeconds: number;
  stickyMinTtlSeconds: number;
  stickyMaxTtlSeconds: number;
  stickyAbsoluteTtlSeconds: number;
  stickyMaxSessions: number;
  stickyQueueTimeoutMs: number;
  debug: boolean;
  trace: boolean;
  stderrMaxBytes: number;
  cors: boolean;
  codexSandbox: "read-only" | "workspace-write" | "danger-full-access";
  codexApprovalPolicy: "untrusted" | "on-failure" | "on-request" | "never";
}

type Env = Record<string, string | undefined>;

export function parseConfig(env: Env = process.env): ProxyConfig {
  const defaultTimeoutMs = parsePositiveInt(env.CODEX_PROXY_TIMEOUT_MS, 120_000);
  return {
    host: env.CODEX_PROXY_HOST || "127.0.0.1",
    port: parsePort(env.CODEX_PROXY_PORT, 3466),
    maxBodySize: env.CODEX_PROXY_MAX_BODY || "8mb",
    defaultModel: env.CODEX_PROXY_DEFAULT_MODEL || "gpt-5.5",
    runtime: parseRuntime(env.CODEX_PROXY_RUNTIME, "pool"),
    allowRuntimeOverride: env.CODEX_PROXY_ALLOW_RUNTIME_OVERRIDE === "1",
    codexBin: env.CODEX_PROXY_CODEX_BIN || "codex",
    defaultTimeoutMs,
    turnStartTimeoutMs: parsePositiveInt(env.CODEX_PROXY_TURN_START_TIMEOUT_MS, 10_000),
    initTimeoutMs: parsePositiveInt(env.CODEX_PROXY_INIT_TIMEOUT_MS, 10_000),
    healthTimeoutMs: parsePositiveInt(env.CODEX_PROXY_HEALTH_TIMEOUT_MS, 30_000),
    shutdownGraceMs: parsePositiveInt(env.CODEX_PROXY_SHUTDOWN_GRACE_MS, 10_000),
    poolMax: parsePositiveInt(env.CODEX_PROXY_POOL_MAX, 2),
    poolTtlMs: parsePositiveInt(env.CODEX_PROXY_POOL_TTL_MS, 600_000),
    prewarmModels: parseCsv(env.CODEX_PROXY_PREWARM_MODELS, ["gpt-5.5", "gpt-5.4-mini"]),
    initPool: env.CODEX_PROXY_INIT_POOL !== "0",
    fallbackOnPoolFailure: env.CODEX_PROXY_FALLBACK_ON_POOL_FAILURE !== "0",
    keepaliveMs: parseNonNegativeInt(env.CODEX_PROXY_KEEPALIVE_MS, 10_000),
    sessionsEnabled: env.CODEX_PROXY_SESSIONS === "1",
    sessionTtlMs: parsePositiveInt(env.CODEX_PROXY_SESSION_TTL_MS, 600_000),
    sessionMax: parsePositiveInt(env.CODEX_PROXY_SESSION_MAX, 32),
    stickySessionsEnabled: env.CODEX_PROXY_STICKY_SESSIONS === "1" || env.CODEX_PROXY_SESSIONS === "1",
    stickyAllowBodyOptions: env.CODEX_PROXY_STICKY_ALLOW_BODY_OPTIONS !== "0",
    stickyKeyMaxLength: parsePositiveInt(env.CODEX_PROXY_STICKY_KEY_MAX_LENGTH, 256),
    stickyDefaultTtlSeconds: parsePositiveInt(
      env.CODEX_PROXY_STICKY_DEFAULT_TTL_SECONDS,
      Math.floor(parsePositiveInt(env.CODEX_PROXY_SESSION_TTL_MS, 600_000) / 1000),
    ),
    stickyMinTtlSeconds: parsePositiveInt(env.CODEX_PROXY_STICKY_MIN_TTL_SECONDS, 60),
    stickyMaxTtlSeconds: parsePositiveInt(env.CODEX_PROXY_STICKY_MAX_TTL_SECONDS, 86_400),
    stickyAbsoluteTtlSeconds: parseNonNegativeInt(env.CODEX_PROXY_STICKY_ABSOLUTE_TTL_SECONDS, 86_400),
    stickyMaxSessions: parsePositiveInt(env.CODEX_PROXY_STICKY_MAX_SESSIONS, parsePositiveInt(env.CODEX_PROXY_SESSION_MAX, 32)),
    stickyQueueTimeoutMs: parsePositiveInt(env.CODEX_PROXY_STICKY_QUEUE_TIMEOUT_MS, 120_000),
    debug: env.CODEX_PROXY_DEBUG === "1" || env.DEBUG === "1" || env.DEBUG === "true",
    trace: env.CODEX_PROXY_TRACE === "1" || env.CODEX_PROXY_TRACE === "true",
    stderrMaxBytes: parsePositiveInt(env.CODEX_PROXY_STDERR_MAX_BYTES, 16_384),
    cors: env.CODEX_PROXY_CORS === "1",
    codexSandbox: parseCodexSandbox(env.CODEX_PROXY_SANDBOX, "read-only"),
    codexApprovalPolicy: parseCodexApprovalPolicy(env.CODEX_PROXY_APPROVAL_POLICY, "never"),
  };
}

function parsePort(value: string | undefined, fallback: number): number {
  const parsed = Number(value);
  return Number.isInteger(parsed) && parsed > 0 && parsed <= 65_535 ? parsed : fallback;
}

function parsePositiveInt(value: string | undefined, fallback: number): number {
  const parsed = Number(value);
  return Number.isInteger(parsed) && parsed > 0 ? parsed : fallback;
}

function parseNonNegativeInt(value: string | undefined, fallback: number): number {
  const parsed = Number(value);
  return Number.isInteger(parsed) && parsed >= 0 ? parsed : fallback;
}

function parseRuntime(value: string | undefined, fallback: "pool" | "oneshot"): "pool" | "oneshot" {
  return value === "pool" || value === "oneshot" ? value : fallback;
}

function parseCodexSandbox(
  value: string | undefined,
  fallback: ProxyConfig["codexSandbox"],
): ProxyConfig["codexSandbox"] {
  return value === "read-only" || value === "workspace-write" || value === "danger-full-access"
    ? value
    : fallback;
}

function parseCodexApprovalPolicy(
  value: string | undefined,
  fallback: ProxyConfig["codexApprovalPolicy"],
): ProxyConfig["codexApprovalPolicy"] {
  return value === "untrusted" || value === "on-failure" || value === "on-request" || value === "never"
    ? value
    : fallback;
}

function parseCsv(value: string | undefined, fallback: string[]): string[] {
  if (!value) return fallback;
  const parsed = value.split(",").map((part) => part.trim()).filter(Boolean);
  return parsed.length > 0 ? parsed : fallback;
}

export const CONFIG = parseConfig();
