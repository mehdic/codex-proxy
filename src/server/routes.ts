/**
 * Express route handlers for the codex-proxy.
 */

import { Router, type Request, type Response } from "express";
import { v4 as uuid } from "uuid";
import {
  AVAILABLE_MODELS,
  resolveModel,
  chatRequestToOptions,
  responsesRequestToOptions,
  canonicalModelLabel,
} from "../adapter/openai-to-codex.js";
import {
  turnResultToChatCompletion,
  makeChatCompletionChunk,
  chunkToSSE,
  SSE_DONE,
  turnResultToResponseObject,
  makeResponseStreamEvent,
  makeResponseTextDoneEvent,
} from "../adapter/codex-to-openai.js";
import { CodexSubprocess, type CodexSubprocessOptions, type DeltaCallback, type TurnResult } from "../subprocess/manager.js";
import { GLOBAL_CODEX_POOL, type PoolLease } from "../subprocess/pool.js";
import { isPoolTransportFault } from "../subprocess/fallback.js";
import { resolveRuntime, type RuntimeMode } from "../subprocess/runtime.js";
import { startSseKeepalive } from "./keepalive.js";
import { incCounter, observeHistogram, recordFallback, recordRequest, renderMetrics } from "./metrics.js";
import { CONFIG } from "./config.js";
import { CodexProxyError, invalidRequestError, mapErrorToHttp } from "./errors.js";
import { NAME, VERSION } from "./version.js";
import type { ChatCompletionRequest, ResponseRequest, ModelObject, ModelListResponse } from "../types/openai.js";

type EndpointName = "chat_completions" | "responses";

// ── Model list ───────────────────────────────────────────────────────

const MODEL_CREATED = Math.floor(Date.now() / 1000);

function buildModelList(): ModelListResponse {
  const data: ModelObject[] = AVAILABLE_MODELS.map((id) => ({
    id,
    object: "model" as const,
    created: MODEL_CREATED,
    owned_by: "codex-proxy",
  }));
  return { object: "list", data };
}

export function buildHealthPayload() {
  return { status: "ok", uptime: Math.floor(process.uptime()), version: VERSION };
}

export function buildVersionPayload() {
  return { name: NAME, version: VERSION };
}

// ── Router factory ───────────────────────────────────────────────────

export function createRouter(): Router {
  const router = Router();

  // Health
  router.get("/health", (_req: Request, res: Response) => {
    res.json(buildHealthPayload());
  });

  router.get("/version", (_req: Request, res: Response) => {
    res.json(buildVersionPayload());
  });

  // Deep health: verifies the codex binary and app-server path with a tiny turn.
  router.get("/healthz/deep", async (_req: Request, res: Response) => {
    const started = Date.now();
    const model = resolveModel(process.env.CODEX_PROXY_HEALTH_MODEL || CONFIG.defaultModel);
    const subprocess = new CodexSubprocess();
    try {
      await subprocess.start({ model, timeoutMs: CONFIG.healthTimeoutMs, initTimeoutMs: CONFIG.initTimeoutMs });
      const result = await subprocess.submitTurn("Reply with OK only.", {
        model,
        timeoutMs: CONFIG.healthTimeoutMs,
        initTimeoutMs: CONFIG.initTimeoutMs,
        turnStartTimeoutMs: CONFIG.turnStartTimeoutMs,
      });
      res.json({ ok: true, status: "ok", model, latency_ms: Date.now() - started, text: result.text.slice(0, 80) });
    } catch (err) {
      const mapped = mapErrorToHttp(err, CONFIG.debug);
      res.status(503).json({
        ok: false,
        status: "error",
        model,
        latency_ms: Date.now() - started,
        error: mapped.body.error,
      });
    } finally {
      subprocess.kill();
    }
  });

  // Metrics
  router.get("/metrics", (_req: Request, res: Response) => {
    res.set("Content-Type", "text/plain; charset=utf-8");
    res.send(renderMetrics());
  });

  // Models
  const handleModels = (_req: Request, res: Response) => {
    res.json(buildModelList());
  };
  router.get("/models", handleModels);
  router.get("/v1/models", handleModels);

  // Chat completions
  const handleChatCompletions = async (req: Request, res: Response) => {
    const body = req.body as ChatCompletionRequest;
    const reqStart = Date.now();
    const requestId = String(res.locals.requestId || uuid());
    let status: "ok" | "error" = "error";
    const runtime = resolveRuntime(req, CONFIG);
    const abortController = new AbortController();
    if (!body.messages || !Array.isArray(body.messages) || body.messages.length === 0) {
      res.status(400).json(invalidRequestError("messages array is required", "messages"));
      return;
    }

    const model = resolveModel(body.model);
    const label = canonicalModelLabel(model);

    const { prompt, options } = chatRequestToOptions(body, {
      timeoutMs: CONFIG.defaultTimeoutMs,
      initTimeoutMs: CONFIG.initTimeoutMs,
      turnStartTimeoutMs: CONFIG.turnStartTimeoutMs,
    });
    res.on("close", () => {
      recordRequest({ endpoint: "chat_completions", model, runtime, status, durationMs: Date.now() - reqStart });
      if (!res.writableEnded) abortController.abort();
    });

    try {
      if (body.stream) {
        res.setHeader("Content-Type", "text/event-stream");
        res.setHeader("Cache-Control", "no-cache");
        res.setHeader("Connection", "keep-alive");
        res.setHeader("X-Accel-Buffering", "no");
        res.setHeader("X-Request-Id", requestId);
        res.flushHeaders();
        let lastStreamWrite = Date.now();
        res.write(":ok\n\n");
        const keepalive = startSseKeepalive(CONFIG.keepaliveMs, (chunk) => {
          res.write(chunk);
        }, () => lastStreamWrite, (next) => {
          lastStreamWrite = next;
        });

        const streamId = requestId;
        let result: TurnResult;
        try {
          result = await runTurn(prompt, options, runtime, "chat_completions", (delta) => {
            const chunk = makeChatCompletionChunk(streamId, model, delta);
            res.write(chunkToSSE(chunk));
            lastStreamWrite = Date.now();
          }, false, abortController.signal);
        } finally {
          if (keepalive) clearInterval(keepalive);
        }
        status = "ok";

        // Final chunk with finish_reason
        const finalChunk = makeChatCompletionChunk(streamId, model, null, "stop");
        res.write(chunkToSSE(finalChunk));
        res.write(SSE_DONE);
        lastStreamWrite = Date.now();
        res.end();

        if (result.durationMs) {
          observeHistogram("codex_proxy_turn_duration_ms", result.durationMs, { model: label });
        }
      } else {
        const result = await runTurn(prompt, options, runtime, "chat_completions", undefined, true, abortController.signal);
        const response = turnResultToChatCompletion(result, model);
        status = "ok";
        res.json(response);

        if (result.durationMs) {
          observeHistogram("codex_proxy_turn_duration_ms", result.durationMs, { model: label });
        }
      }
    } catch (err) {
      incCounter("codex_proxy_errors_total", { endpoint: "chat_completions", model: label });
      const mapped = mapErrorToHttp(err, CONFIG.debug);
      if (!res.headersSent) {
        res.status(mapped.status).json(mapped.body);
      } else {
        res.write(`event: error\ndata: ${JSON.stringify(mapped.body)}\n\n`);
        res.write(SSE_DONE);
        res.end();
      }
    }
  };

  router.post("/chat/completions", handleChatCompletions);
  router.post("/v1/chat/completions", handleChatCompletions);

  // Responses API
  const handleResponses = async (req: Request, res: Response) => {
    const body = req.body as ResponseRequest;
    const reqStart = Date.now();
    const requestId = String(res.locals.requestId || uuid());
    let status: "ok" | "error" = "error";
    const runtime = resolveRuntime(req, CONFIG);
    const abortController = new AbortController();
    if (!body.input) {
      res.status(400).json(invalidRequestError("input is required", "input"));
      return;
    }

    const model = resolveModel(body.model);
    const label = canonicalModelLabel(model);

    const { prompt, options } = responsesRequestToOptions(body, {
      timeoutMs: CONFIG.defaultTimeoutMs,
      initTimeoutMs: CONFIG.initTimeoutMs,
      turnStartTimeoutMs: CONFIG.turnStartTimeoutMs,
    });
    res.on("close", () => {
      recordRequest({ endpoint: "responses", model, runtime, status, durationMs: Date.now() - reqStart });
      if (!res.writableEnded) abortController.abort();
    });

    try {
      if (body.stream) {
        res.setHeader("Content-Type", "text/event-stream");
        res.setHeader("Cache-Control", "no-cache");
        res.setHeader("Connection", "keep-alive");
        res.setHeader("X-Accel-Buffering", "no");
        res.setHeader("X-Request-Id", requestId);
        res.flushHeaders();
        let lastStreamWrite = Date.now();
        res.write(":ok\n\n");
        const keepalive = startSseKeepalive(CONFIG.keepaliveMs, (chunk) => {
          res.write(chunk);
        }, () => lastStreamWrite, (next) => {
          lastStreamWrite = next;
        });

        const respId = `resp_${requestId}`;
        const outputId = `msg_${uuid()}`;

        // response.created
        res.write(makeResponseStreamEvent("response.created", {
          response: { id: respId, object: "response", created_at: Math.floor(Date.now() / 1000), status: "in_progress", model, output: [] },
        }));
        lastStreamWrite = Date.now();

        res.write(makeResponseStreamEvent("response.in_progress", {
          response: { id: respId, object: "response", created_at: Math.floor(Date.now() / 1000), status: "in_progress", model, output: [] },
        }));
        lastStreamWrite = Date.now();

        // output_item.added
        res.write(makeResponseStreamEvent("response.output_item.added", {
          output_index: 0,
          item: { type: "message", id: outputId, role: "assistant", status: "in_progress", content: [] },
        }));
        lastStreamWrite = Date.now();

        res.write(makeResponseStreamEvent("response.content_part.added", {
          output_index: 0,
          content_index: 0,
          item_id: outputId,
          part: { type: "output_text", text: "" },
        }));
        lastStreamWrite = Date.now();

        let result: TurnResult;
        try {
          result = await runTurn(prompt, options, runtime, "responses", (delta) => {
            res.write(makeResponseStreamEvent("response.output_text.delta", {
              output_index: 0, content_index: 0, delta,
            }));
            lastStreamWrite = Date.now();
          }, false, abortController.signal);
        } finally {
          if (keepalive) clearInterval(keepalive);
        }
        status = "ok";

        // output_text.done
        res.write(makeResponseTextDoneEvent(0, 0, result.text));
        lastStreamWrite = Date.now();

        res.write(makeResponseStreamEvent("response.content_part.done", {
          output_index: 0,
          content_index: 0,
          item_id: outputId,
          part: { type: "output_text", text: result.text },
        }));
        lastStreamWrite = Date.now();

        // output_item.done
        res.write(makeResponseStreamEvent("response.output_item.done", {
          output_index: 0,
          item: {
            type: "message", id: outputId, role: "assistant", status: "completed",
            content: [{ type: "output_text", text: result.text }],
          },
        }));
        lastStreamWrite = Date.now();

        // response.completed
        res.write(makeResponseStreamEvent("response.completed", {
          response: turnResultToResponseObject(result, model, { responseId: respId, outputId }),
        }));
        lastStreamWrite = Date.now();

        res.end();

        if (result.durationMs) {
          observeHistogram("codex_proxy_turn_duration_ms", result.durationMs, { model: label });
        }
      } else {
        const result = await runTurn(prompt, options, runtime, "responses", undefined, true, abortController.signal);
        const response = turnResultToResponseObject(result, model);
        status = "ok";
        res.json(response);

        if (result.durationMs) {
          observeHistogram("codex_proxy_turn_duration_ms", result.durationMs, { model: label });
        }
      }
    } catch (err) {
      incCounter("codex_proxy_errors_total", { endpoint: "responses", model: label });
      const mapped = mapErrorToHttp(err, CONFIG.debug);
      if (!res.headersSent) {
        res.status(mapped.status).json(mapped.body);
      } else {
        res.write(makeResponseStreamEvent("error", mapped.body as unknown as Record<string, unknown>));
        res.end();
      }
    }
  };

  router.post("/responses", handleResponses);
  router.post("/v1/responses", handleResponses);

  return router;
}

async function runTurn(
  prompt: string,
  options: CodexSubprocessOptions,
  runtime: RuntimeMode,
  endpoint: EndpointName,
  deltaCallback?: DeltaCallback,
  allowFallback = true,
  signal?: AbortSignal,
): Promise<TurnResult> {
  try {
    return await runTurnOnce(prompt, options, runtime, deltaCallback, signal);
  } catch (err) {
    if (
      runtime === "pool"
      && allowFallback
      && CONFIG.fallbackOnPoolFailure
      && isPoolTransportFault(err)
    ) {
      recordFallback("pool_failure");
      incCounter("codex_proxy_errors_total", { endpoint, model: options.model, runtime: "pool" });
      return runTurnOnce(prompt, options, "oneshot", deltaCallback, signal);
    }
    throw err;
  }
}

async function runTurnOnce(
  prompt: string,
  options: CodexSubprocessOptions,
  runtime: RuntimeMode,
  deltaCallback?: DeltaCallback,
  signal?: AbortSignal,
): Promise<TurnResult> {
  if (runtime === "oneshot") {
    const subprocess = new CodexSubprocess();
    try {
      await subprocess.start(options);
      const turn = deltaCallback
        ? subprocess.submitTurnStreaming(prompt, options, deltaCallback)
        : subprocess.submitTurn(prompt, options);
      return await withAbort(turn, signal, () => subprocess.kill("SIGTERM", "killed"));
    } finally {
      subprocess.kill();
    }
  }

  let lease: PoolLease<CodexSubprocess> | null = null;
  try {
    lease = await GLOBAL_CODEX_POOL.acquire(options);
    const turn = deltaCallback
      ? lease.worker.submitTurnStreaming(prompt, options, deltaCallback)
      : lease.worker.submitTurn(prompt, options);
    const result = await withAbort(turn, signal, () => lease?.worker.kill("SIGTERM", "killed"));
    GLOBAL_CODEX_POOL.release(lease, true);
    lease = null;
    return result;
  } catch (err) {
    if (lease) GLOBAL_CODEX_POOL.release(lease, false);
    throw err;
  }
}

function withAbort<T>(operation: Promise<T>, signal: AbortSignal | undefined, onAbort: () => void): Promise<T> {
  if (!signal) return operation;
  if (signal.aborted) {
    onAbort();
    return Promise.reject(new CodexProxyError("client_closed", "client_closed"));
  }
  return new Promise<T>((resolve, reject) => {
    const abort = () => {
      onAbort();
      reject(new CodexProxyError("client_closed", "client_closed"));
    };
    signal.addEventListener("abort", abort, { once: true });
    operation.then(
      (value) => {
        signal.removeEventListener("abort", abort);
        resolve(value);
      },
      (err) => {
        signal.removeEventListener("abort", abort);
        reject(err);
      },
    );
  });
}
