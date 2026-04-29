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
  debug: boolean;
  stderrMaxBytes: number;
  cors: boolean;
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
    debug: env.CODEX_PROXY_DEBUG === "1" || env.DEBUG === "1" || env.DEBUG === "true",
    stderrMaxBytes: parsePositiveInt(env.CODEX_PROXY_STDERR_MAX_BYTES, 16_384),
    cors: env.CODEX_PROXY_CORS === "1",
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

function parseCsv(value: string | undefined, fallback: string[]): string[] {
  if (!value) return fallback;
  const parsed = value.split(",").map((part) => part.trim()).filter(Boolean);
  return parsed.length > 0 ? parsed : fallback;
}

export const CONFIG = parseConfig();
