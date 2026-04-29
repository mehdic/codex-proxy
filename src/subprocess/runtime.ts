import type { ProxyConfig } from "../server/config.js";
import { validateSessionId } from "./session-pool.js";

export type RuntimeMode = "pool" | "oneshot";

export interface RuntimeRequest {
  header(name: string): string | string[] | undefined;
}

export function resolveRuntime(req: RuntimeRequest | undefined, config: ProxyConfig): RuntimeMode {
  if (config.allowRuntimeOverride && req) {
    const header = req.header("x-codex-proxy-runtime");
    if (header === "pool" || header === "oneshot") return header;
  }
  return config.runtime;
}

export type SessionRequestResolution =
  | { kind: "none" }
  | { kind: "session"; sessionId: string }
  | { kind: "invalid"; message: string };

export function resolveSessionRequest(req: RuntimeRequest | undefined, config: ProxyConfig): SessionRequestResolution {
  if (!config.sessionsEnabled || !req) return { kind: "none" };
  const header = req.header("x-codex-proxy-session");
  if (Array.isArray(header)) {
    if (header.length === 0) return { kind: "none" };
    return invalidSessionHeader();
  }
  if (header === undefined || header === "") return { kind: "none" };

  const sessionId = validateSessionId(header);
  if (!sessionId) return invalidSessionHeader();
  return { kind: "session", sessionId };
}

function invalidSessionHeader(): SessionRequestResolution {
  return {
    kind: "invalid",
    message: "X-Codex-Proxy-Session must match [A-Za-z0-9._:-] and be at most 128 characters",
  };
}
