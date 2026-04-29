export interface ProxyConfig {
  host: string;
  port: number;
  maxBodySize: string;
  defaultModel: string;
  codexBin: string;
  defaultTimeoutMs: number;
  turnStartTimeoutMs: number;
  initTimeoutMs: number;
  healthTimeoutMs: number;
  shutdownGraceMs: number;
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
    codexBin: env.CODEX_PROXY_CODEX_BIN || "codex",
    defaultTimeoutMs,
    turnStartTimeoutMs: parsePositiveInt(env.CODEX_PROXY_TURN_START_TIMEOUT_MS, 10_000),
    initTimeoutMs: parsePositiveInt(env.CODEX_PROXY_INIT_TIMEOUT_MS, 10_000),
    healthTimeoutMs: parsePositiveInt(env.CODEX_PROXY_HEALTH_TIMEOUT_MS, 30_000),
    shutdownGraceMs: parsePositiveInt(env.CODEX_PROXY_SHUTDOWN_GRACE_MS, 10_000),
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

export const CONFIG = parseConfig();
