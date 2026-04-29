export type CodexErrorKind =
  | "spawn"
  | "timeout"
  | "protocol"
  | "codex"
  | "client_closed"
  | "unknown";

export class CodexProxyError extends Error {
  readonly kind: CodexErrorKind;
  readonly detail?: string;

  constructor(kind: CodexErrorKind, message: string, options: { cause?: unknown; detail?: string } = {}) {
    super(message);
    this.name = "CodexProxyError";
    this.kind = kind;
    this.detail = options.detail;
    this.cause = options.cause;
  }
}

export interface HttpErrorBody {
  error: {
    message: string;
    type: "invalid_request_error" | "server_error";
    code: string;
    detail?: string;
  };
}

export function mapErrorToHttp(err: unknown, includeDebugDetail = false): { status: number; body: HttpErrorBody } {
  const proxyError = normalizeError(err);
  const base = mapKind(proxyError.kind);
  const body: HttpErrorBody = {
    error: {
      message: base.message,
      type: "server_error",
      code: base.code,
    },
  };

  if (includeDebugDetail && proxyError.detail) {
    body.error.detail = proxyError.detail;
  }

  return { status: base.status, body };
}

export function normalizeError(err: unknown): CodexProxyError {
  if (err instanceof CodexProxyError) return err;
  if (!(err instanceof Error)) return new CodexProxyError("unknown", "Unknown error", { detail: String(err) });

  const msg = err.message.toLowerCase();
  if (msg.includes("enoent") || msg.includes("not found")) {
    return new CodexProxyError("spawn", "Codex CLI not found", { cause: err, detail: err.message });
  }
  if (msg.includes("timed out") || msg.includes("timeout")) {
    return new CodexProxyError("timeout", "Codex request timed out", { cause: err, detail: err.message });
  }
  if (msg.includes("json-rpc") || msg.includes("protocol")) {
    return new CodexProxyError("protocol", "Codex app-server protocol error", { cause: err, detail: err.message });
  }
  if (msg.includes("app-server exited") || msg.includes("process is dead")) {
    return new CodexProxyError("codex", "Codex app-server exited before completing the request", { cause: err, detail: err.message });
  }
  return new CodexProxyError("unknown", "Codex subprocess error", { cause: err, detail: err.message });
}

function mapKind(kind: CodexErrorKind): { status: number; message: string; code: string } {
  switch (kind) {
    case "spawn":
      return { status: 502, message: "Codex CLI could not be started", code: "codex_spawn_failed" };
    case "timeout":
      return { status: 504, message: "Codex request timed out", code: "codex_timeout" };
    case "protocol":
      return { status: 502, message: "Codex app-server protocol error", code: "codex_protocol_error" };
    case "codex":
      return { status: 502, message: "Codex app-server failed", code: "codex_app_server_error" };
    case "client_closed":
      return { status: 499, message: "Client closed request", code: "client_closed" };
    case "unknown":
      return { status: 502, message: "Codex subprocess error", code: "codex_subprocess_error" };
  }
}
