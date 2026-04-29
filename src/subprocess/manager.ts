/**
 * Codex app-server subprocess manager.
 *
 * Spawns `codex app-server` over stdio, performs JSON-RPC handshake
 * (initialize + initialized), starts an ephemeral thread, submits a
 * turn, and collects streamed agent message deltas until the turn
 * completes.
 *
 * Design: one-shot per request. Each HTTP request gets a fresh
 * app-server process. Clean, safe, no shared state. A persistent
 * pool can be layered on later via the same interface.
 */

import { spawn, type ChildProcess } from "node:child_process";
import { v4 as uuid } from "uuid";
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
  private stderrChunks: string[] = [];
  private dead = false;

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

    const codexBin = process.env.CODEX_PROXY_CODEX_BIN || "codex";

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
      // Capture stderr for diagnostics but never log secrets
      this.stderrChunks.push(text);
      if (this.stderrChunks.length > 50) this.stderrChunks.shift();
      if (process.env.DEBUG) {
        process.stderr.write(`[codex-proxy:stderr] ${text}`);
      }
    });

    this.proc.on("exit", (code, signal) => {
      this.dead = true;
      if (process.env.DEBUG) {
        console.error(`[codex-proxy] app-server exited code=${code} signal=${signal}`);
      }
      // Reject any pending requests
      for (const [, { reject }] of this.pendingResolvers) {
        reject(new Error(`app-server exited (code=${code}, signal=${signal})`));
      }
      this.pendingResolvers.clear();
    });

    this.proc.on("error", (err) => {
      this.dead = true;
      for (const [, { reject }] of this.pendingResolvers) {
        reject(err);
      }
      this.pendingResolvers.clear();
    });

    // Send initialize request
    const initResult = await this.sendRequest<InitializeResponse>("initialize", {
      clientInfo: {
        name: "codex-proxy",
        title: "Codex Proxy",
        version: "0.1.0",
      },
      capabilities: {
        experimentalApi: false,
      },
    });

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
    if (this.dead) throw new Error("app-server process is dead");

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
    });
    threadId = threadResp.thread.id;

    // Collect assistant text from streamed deltas
    let assistantText = "";

    const turnPromise = new Promise<TurnResult>((resolve, reject) => {
      const timeout = setTimeout(() => {
        reject(new Error(`Turn timed out after ${options.timeoutMs || 120_000}ms`));
        this.kill();
      }, options.timeoutMs || 120_000);

      const handler = (method: string, params: unknown) => {
        const p = params as Record<string, unknown>;
        if (p.threadId !== threadId) return;

        switch (method) {
          case "item/agentMessage/delta": {
            const delta = (p as unknown as AgentMessageDeltaNotification).delta;
            assistantText += delta;
            deltaCallback?.(delta);
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
              reject(new Error(`Codex error: ${err.error.message}`));
            }
            break;
          }
        }
      };

      this.addNotificationHandler(handler);
    });

    // Start turn
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
    });

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

  private sendRequest<T>(method: string, params: unknown): Promise<T> {
    return new Promise((resolve, reject) => {
      const id = this.nextId();
      this.pendingResolvers.set(id, {
        resolve: resolve as (v: unknown) => void,
        reject,
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
        if (process.env.DEBUG) {
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
            new Error(`JSON-RPC error ${msg.error.code}: ${msg.error.message}`),
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
  kill(): void {
    if (this.proc && !this.dead) {
      this.dead = true;
      this.proc.stdin?.end();
      this.proc.kill("SIGTERM");
      // Force kill after 5s
      setTimeout(() => {
        try {
          this.proc?.kill("SIGKILL");
        } catch {
          // already dead
        }
      }, 5000);
    }
  }

  /** Whether the subprocess has exited. */
  get isDead(): boolean {
    return this.dead;
  }

  /** Recent stderr lines for diagnostics. */
  get stderr(): string {
    return this.stderrChunks.join("");
  }
}
