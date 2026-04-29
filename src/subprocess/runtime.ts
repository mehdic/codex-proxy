import type { ProxyConfig } from "../server/config.js";

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
