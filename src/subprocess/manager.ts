/**
 * Codex app-server subprocess manager.
 *
 * Spawns `codex app-server` over stdio, performs JSON-RPC handshake
 * (initialize + initialized), starts an ephemeral thread, submits a
 * turn, and collects streamed agent message deltas until the turn
 * completes.
 *
 * Design: the manager owns one official app-server process. It can be
 * used one-shot per request or kept warm by the worker pool; every turn
 * still starts a fresh ephemeral Codex thread unless higher layers add
 * explicit session semantics.
 */

import { spawn, type ChildProcess } from "node:child_process";
import { v4 as uuid } from "uuid";
import { appendAssistantText, extractDeltaText } from "../adapter/codex-to-openai.js";
import { CONFIG } from "../server/config.js";
import { CodexProxyError } from "../server/errors.js";
import { recordSubprocessExit } from "../server/metrics.js";
import { VERSION } from "../server/version.js";
import type {
  RequestId,
  InitializeResponse,
  ThreadStartResponse,
  TurnStartResponse,
  AgentMessageDeltaNotification,
  TurnCompletedNotification,
  ItemCompletedNotification,
  ErrorNotification,
  ThreadTokenUsageUpdatedNotification,
  TokenUsageBreakdown,
  JsonRpcMessage,
  ServerApprovalRequest,
} from "../types/codex.js";

// ── Public types ────────────────────────────────────────────────────

export interface CodexSubprocessOptions {
  /** Codex model id, e.g. "gpt-5.5" */
  model: string;
  /** Working directory for the Codex agent */
  cwd?: string;
  /** Timeout in ms for the entire turn (default 120_000) */
  timeoutMs?: number;
  /** Timeout in ms for individual JSON-RPC setup requests */
  initTimeoutMs?: number;
  /** Timeout in ms for turn/start acknowledgement */
  turnStartTimeoutMs?: number;
  /** System / developer instructions */
  instructions?: string;
  /** Additional config overrides passed as `-c key=value` */
  configOverrides?: Record<string, string>;
}

export interface TurnResult {
  text: string;
  turnId: string;
  threadId: string;
  usage: TokenUsageBreakdown | null;
  durationMs: number | null;
  finishReason: "stop" | "length" | "error";
}

export type DeltaCallback = (delta: string) => void;

// ── Manager ─────────────────────────────────────────────────────────

export class CodexSubprocess {
  private proc: ChildProcess | null = null;
  private buffer = "";
  private requestId = 0;
  private pendingResolvers = new Map<
    RequestId,
    { resolve: (v: unknown) => void; reject: (e: Error) => void }
  >();
  private notificationHandlers: ((method: string, params: unknown) => void)[] = [];
  private stderrText = "";
  private dead = false;
  private killTimer: NodeJS.Timeout | null = null;
  private exitReason: "clean" | "signal" | "error" | "timeout" | "killed" | "unknown" = "unknown";

  /**
   * Spawn `codex app-server`, complete the initialize handshake,
   * and send the `initialized` notification.
   */
  async start(options: CodexSubprocessOptions): Promise<InitializeResponse> {
    const args = ["app-server", "--listen", "stdio://"];

    // Apply config overrides
    if (options.configOverrides) {
      for (const [key, value] of Object.entries(options.configOverrides)) {
        args.push("-c", `${key}=${value}`);
      }
    }

    const codexBin = CONFIG.codexBin;

    this.proc = spawn(codexBin, args, {
      cwd: options.cwd || process.cwd(),
      stdio: ["pipe", "pipe", "pipe"],
      env: { ...process.env },
    });

    this.proc.stdout!.on("data", (chunk: Buffer) => {
      this.buffer += chunk.toString("utf-8");
      this.drainBuffer();
    });

    this.proc.stderr!.on("data", (chunk: Buffer) => {
      const text = chunk.toString("utf-8");
      // Keep a bounded diagnostic tail. Never emit it unless debug is enabled.
      this.stderrText = (this.stderrText + text).slice(-CONFIG.stderrMaxBytes);
      if (CONFIG.debug) {
        process.stderr.write(`[codex-proxy:stderr] ${text}`);
      }
    });

    this.proc.on("exit", (code, signal) => {
      this.dead = true;
      if (this.killTimer) clearTimeout(this.killTimer);
      if (this.exitReason === "unknown") this.exitReason = signal ? "signal" : code === 0 ? "clean" : "error";
      recordSubprocessExit(this.exitReason);
      if (CONFIG.debug) {
        console.error(`[codex-proxy] app-server exited code=${code} signal=${signal}`);
      }
      // Reject any pending requests
      for (const [, { reject }] of this.pendingResolvers) {
        reject(new CodexProxyError("codex", `app-server exited (code=${code}, signal=${signal})`, {
          detail: this.stderr,
        }));
      }
      this.pendingResolvers.clear();
    });

    this.proc.on("error", (err) => {
      this.dead = true;
      this.exitReason = "error";
      recordSubprocessExit("error");
      for (const [, { reject }] of this.pendingResolvers) {
        reject(new CodexProxyError("spawn", err.message, { cause: err, detail: err.message }));
      }
      this.pendingResolvers.clear();
    });

    // Send initialize request
    const initResult = await this.sendRequest<InitializeResponse>("initialize", {
      clientInfo: {
        name: "codex-proxy",
        title: "Codex Proxy",
        version: VERSION,
      },
      capabilities: {
        experimentalApi: false,
      },
    }, options.initTimeoutMs || CONFIG.initTimeoutMs);

    // Send initialized notification
    this.sendNotification("initialized");

    return initResult;
  }

  /**
   * Start an ephemeral thread and submit a turn with the given user
   * text. Returns the full assistant text. For streaming, provide a
   * deltaCallback that receives each text delta as it arrives.
   */
  async submitTurn(
    userText: string,
    options: CodexSubprocessOptions,
    deltaCallback?: DeltaCallback,
  ): Promise<TurnResult> {
    if (this.dead) throw new CodexProxyError("codex", "app-server process is dead", { detail: this.stderr });

    let threadId: string;
    let tokenUsage: TokenUsageBreakdown | null = null;

    // Start thread
    const threadResp = await this.sendRequest<ThreadStartResponse>("thread/start", {
      model: options.model,
      cwd: options.cwd || process.cwd(),
      approvalPolicy: "never",
      sandbox: "read-only",
      ephemeral: true,
      baseInstructions: options.instructions || null,
      experimentalRawEvents: false,
      persistExtendedHistory: false,
    }, options.initTimeoutMs || CONFIG.initTimeoutMs);
    threadId = threadResp.thread.id;

    // Collect assistant text from streamed deltas
    let assistantText = "";

    let timeout: NodeJS.Timeout;
    let handler: (method: string, params: unknown) => void;
    const turnPromise = new Promise<TurnResult>((resolve, reject) => {
      timeout = setTimeout(() => {
        this.exitReason = "timeout";
        reject(new CodexProxyError("timeout", `Turn timed out after ${options.timeoutMs || CONFIG.defaultTimeoutMs}ms`, {
          detail: this.stderr,
        }));
        this.kill("SIGTERM", "timeout");
      }, options.timeoutMs || CONFIG.defaultTimeoutMs);

      handler = (method: string, params: unknown) => {
        const p = params as Record<string, unknown>;
        if (p.threadId !== threadId) return;

        switch (method) {
          case "item/agentMessage/delta": {
            const delta = extractDeltaText(p) || (p as unknown as AgentMessageDeltaNotification).delta;
            assistantText += delta;
            deltaCallback?.(delta);
            break;
          }
          case "item/completed": {
            const completedText = extractDeltaText(p as unknown as ItemCompletedNotification);
            const previousText = assistantText;
            const nextText = appendAssistantText(assistantText, completedText);
            if (nextText !== previousText && completedText) {
              const delta = completedText.startsWith(previousText)
                ? completedText.slice(previousText.length)
                : completedText;
              if (delta) deltaCallback?.(delta);
            }
            assistantText = nextText;
            break;
          }
          case "thread/tokenUsage/updated": {
            const usage = p as unknown as ThreadTokenUsageUpdatedNotification;
            tokenUsage = usage.tokenUsage.last;
            break;
          }
          case "turn/completed": {
            const tc = p as unknown as TurnCompletedNotification;
            clearTimeout(timeout);
            this.removeNotificationHandler(handler);

            const finishReason =
              tc.turn.status === "completed"
                ? "stop"
              : tc.turn.status === "failed"
                  ? "error"
                  : "stop";
            if (!assistantText) {
              const items = Array.isArray(tc.turn.items) ? tc.turn.items : [];
              for (const item of items) {
                assistantText = appendAssistantText(assistantText, extractDeltaText({ item }));
              }
            }

            resolve({
              text: assistantText,
              turnId: tc.turn.id,
              threadId,
              usage: tokenUsage,
              durationMs: tc.turn.durationMs,
              finishReason,
            });
            break;
          }
          case "error": {
            const err = p as unknown as ErrorNotification;
            if (!err.willRetry) {
              clearTimeout(timeout);
              this.removeNotificationHandler(handler);
              reject(new CodexProxyError("codex", `Codex error: ${err.error.message}`, {
                detail: err.error.additionalDetails || err.error.message,
              }));
            }
            break;
          }
        }
      };

      this.addNotificationHandler(handler);
    });

    // Start turn
    try {
      await this.sendRequest<TurnStartResponse>("turn/start", {
        threadId,
        input: [
          {
            type: "text",
            text: userText,
            text_elements: [],
          },
        ],
        model: options.model,
      }, options.turnStartTimeoutMs || CONFIG.turnStartTimeoutMs);
    } catch (err) {
      clearTimeout(timeout!);
      this.removeNotificationHandler(handler!);
      this.kill("SIGTERM", "killed");
      throw err;
    }

    return turnPromise;
  }

  /**
   * Start a thread and submit a turn, streaming deltas to a callback.
   * Same as submitTurn but always provides deltaCallback.
   */
  async submitTurnStreaming(
    userText: string,
    options: CodexSubprocessOptions,
    deltaCallback: DeltaCallback,
  ): Promise<TurnResult> {
    return this.submitTurn(userText, options, deltaCallback);
  }

  /**
   * Auto-approve any server requests (command execution, file change,
   * permissions, etc.) from the app-server. This is needed because
   * the proxy operates headlessly.
   */
  private handleServerRequest(msg: ServerApprovalRequest): void {
    // For safety, we auto-approve with the most conservative response.
    // In read-only sandbox mode with approval=never, most requests
    // should not arrive. If they do, deny them.
    const response = {
      jsonrpc: "2.0" as const,
      id: msg.id,
      result: { approved: false, reason: "codex-proxy: headless mode, request denied" },
    };
    this.write(response);
  }

  // ── Private helpers ─────────────────────────────────────────────

  private nextId(): number {
    return ++this.requestId;
  }

  private sendRequest<T>(method: string, params: unknown, timeoutMs = CONFIG.initTimeoutMs): Promise<T> {
    return new Promise((resolve, reject) => {
      const id = this.nextId();
      const timeout = setTimeout(() => {
        this.pendingResolvers.delete(id);
        reject(new CodexProxyError("timeout", `${method} timed out after ${timeoutMs}ms`, { detail: this.stderr }));
      }, timeoutMs);
      this.pendingResolvers.set(id, {
        resolve: (value: unknown) => {
          clearTimeout(timeout);
          resolve(value as T);
        },
        reject: (err: Error) => {
          clearTimeout(timeout);
          reject(err);
        },
      });
      this.write({
        jsonrpc: "2.0",
        id,
        method,
        params,
      });
    });
  }

  private sendNotification(method: string, params?: unknown): void {
    this.write({
      jsonrpc: "2.0",
      method,
      ...(params !== undefined ? { params } : {}),
    });
  }

  private write(msg: unknown): void {
    if (this.dead || !this.proc?.stdin?.writable) return;
    const json = JSON.stringify(msg);
    this.proc.stdin.write(json + "\n");
  }

  private drainBuffer(): void {
    let newlineIdx: number;
    while ((newlineIdx = this.buffer.indexOf("\n")) !== -1) {
      const line = this.buffer.slice(0, newlineIdx).trim();
      this.buffer = this.buffer.slice(newlineIdx + 1);
      if (!line) continue;

      let msg: JsonRpcMessage;
      try {
        msg = JSON.parse(line);
      } catch {
        if (CONFIG.debug) {
          console.error("[codex-proxy] unparseable line:", line.slice(0, 200));
        }
        continue;
      }

      this.handleMessage(msg);
    }
  }

  private handleMessage(msg: JsonRpcMessage): void {
    // JSON-RPC response (has id, has result or error)
    if ("id" in msg && ("result" in msg || "error" in msg)) {
      const resolver = this.pendingResolvers.get(msg.id as RequestId);
      if (resolver) {
        this.pendingResolvers.delete(msg.id as RequestId);
        if ("error" in msg && msg.error) {
          resolver.reject(
            new CodexProxyError("protocol", `JSON-RPC error ${msg.error.code}: ${msg.error.message}`, {
              detail: msg.error.message,
            }),
          );
        } else {
          resolver.resolve((msg as { result: unknown }).result);
        }
      }
      return;
    }

    // Server request (has id and method but no result/error) — needs a response
    if ("id" in msg && "method" in msg && !("result" in msg)) {
      this.handleServerRequest(msg as unknown as ServerApprovalRequest);
      return;
    }

    // Notification (has method, no id)
    if ("method" in msg && !("id" in msg)) {
      const notification = msg as { method: string; params?: unknown };
      for (const handler of this.notificationHandlers) {
        handler(notification.method, notification.params);
      }
    }
  }

  private addNotificationHandler(handler: (method: string, params: unknown) => void): void {
    this.notificationHandlers.push(handler);
  }

  private removeNotificationHandler(handler: (method: string, params: unknown) => void): void {
    const idx = this.notificationHandlers.indexOf(handler);
    if (idx !== -1) this.notificationHandlers.splice(idx, 1);
  }

  /** Kill the subprocess. */
  kill(signal: NodeJS.Signals = "SIGTERM", reason: "killed" | "timeout" = "killed"): void {
    if (this.proc && !this.dead) {
      this.dead = true;
      this.exitReason = reason;
      this.proc.stdin?.end();
      this.proc.kill(signal);
      // Force kill after 5s
      this.killTimer = setTimeout(() => {
        try {
          this.exitReason = "killed";
          this.proc?.kill("SIGKILL");
        } catch {
          // already dead
        }
      }, 5000);
      this.killTimer.unref?.();
    }
  }

  /** Whether the subprocess has exited. */
  get isDead(): boolean {
    return this.dead;
  }

  /** Recent stderr lines for diagnostics. */
  get stderr(): string {
    return this.stderrText;
  }
}
