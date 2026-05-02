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
  requestedFunctionTool,
  shouldEmulateOperationalTools,
  extractProxyToolCall,
  extractAllProxyToolCalls,
} from "../adapter/openai-to-codex.js";
import {
  turnResultToChatCompletion,
  turnResultToToolCallChatCompletion,
  turnResultToSpecificToolCallChatCompletion,
  turnResultToMultiToolCallChatCompletion,
  makeToolCall,
  makeChatToolCallChunk,
  makeChatCompletionChunk,
  turnResultUsageToOpenAI,
  chunkToSSE,
  SSE_DONE,
  turnResultToResponseObject,
  makeResponseDoneEvent,
  makeResponseStreamEvent,
  makeResponseTextDeltaEvent,
  makeResponseTextDoneEvent,
} from "../adapter/codex-to-openai.js";
import { CodexSubprocess, type CodexSubprocessOptions, type DeltaCallback, type NotificationCallback, type TurnResult } from "../subprocess/manager.js";
import { GLOBAL_CODEX_POOL, type PoolLease } from "../subprocess/pool.js";
import { GLOBAL_CODEX_SESSIONS } from "../subprocess/session-pool.js";
import { isPoolTransportFault } from "../subprocess/fallback.js";
import { resolveRuntime, resolveSessionRequest, type RuntimeMode } from "../subprocess/runtime.js";
import { startSseKeepalive, guardedWrite, createSseKeepaliveComment } from "./keepalive.js";
import { incCounter, observeHistogram, recordFallback, recordRequest, renderMetrics } from "./metrics.js";
import { CONFIG } from "./config.js";
import { CodexProxyError, invalidRequestError, mapErrorToHttp } from "./errors.js";
import { NAME, VERSION } from "./version.js";
import { annotateTurnUsage } from "./usage.js";
import { pricingSnapshot } from "./pricing.js";
import type { ChatCompletionRequest, ResponseRequest, ModelObject, ModelListResponse } from "../types/openai.js";
import { attachPhaseTracker } from "./phase-tracker.js";
import { createProgressChunk, hasRenderableAssistantContent } from "./progress-utils.js";

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

  // Public price book used for local cost estimates.
  const handlePricing = (_req: Request, res: Response) => {
    res.json({ object: "pricing_book", ...pricingSnapshot() });
  };
  router.get("/pricing", handlePricing);
  router.get("/v1/pricing", handlePricing);

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
    const session = resolveSessionRequest(req, CONFIG);
    if (session.kind === "invalid") {
      incCounter("codex_proxy_errors_total", { endpoint: "chat_completions", model: label });
      res.status(400).json(invalidRequestError(session.message, "X-Codex-Proxy-Session"));
      return;
    }

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
        const safeWrite = guardedWrite(
          (chunk) => res.write(chunk),
          () => !res.writableEnded && res.writable,
        );
        safeWrite(":ok\n\n");
        const streamId = requestId;
        const phaseTracker = attachPhaseTracker();
        const keepalive = startSseKeepalive(CONFIG.keepaliveMs, safeWrite, () => lastStreamWrite, (next) => {
          lastStreamWrite = next;
        }, (count) => {
          const phase = phaseTracker.poll();
          if (phase && hasRenderableAssistantContent(phase.text)) {
            return chunkToSSE(createProgressChunk(streamId, model, `${phase.text}\n`));
          }
          return createSseKeepaliveComment(requestId, count);
        });

        const emulateTools = shouldEmulateOperationalTools(body);
        const observeNotification: NotificationCallback = (method, params) => phaseTracker.observe(method, params);
        let result: TurnResult;
        try {
          result = await runTurn(prompt, options, runtime, "chat_completions", emulateTools ? undefined : (delta) => {
            const chunk = makeChatCompletionChunk(streamId, model, delta);
            safeWrite(chunkToSSE(chunk));
            lastStreamWrite = Date.now();
          }, false, abortController.signal, session.kind === "session" ? session.sessionId : undefined, observeNotification);
        } finally {
          if (keepalive) clearInterval(keepalive);
          phaseTracker.detach();
        }
        status = "ok";
        annotateTurnUsage(result, prompt, model);

        const proxyToolCalls = emulateTools ? extractAllProxyToolCalls(result.text, body) : [];
        if (proxyToolCalls.length > 0) {
          for (let i = 0; i < proxyToolCalls.length; i++) {
            const toolCall = makeToolCall(result.turnId, proxyToolCalls[i].name, proxyToolCalls[i].arguments, i);
            const finishReason = i === proxyToolCalls.length - 1 ? "tool_calls" : null;
            safeWrite(chunkToSSE(makeChatToolCallChunk(streamId, model, toolCall, i, finishReason)));
          }
        } else {
          if (emulateTools && result.text) {
            safeWrite(chunkToSSE(makeChatCompletionChunk(streamId, model, result.text)));
          }
          const finalChunk = makeChatCompletionChunk(streamId, model, null, "stop", turnResultUsageToOpenAI(result));
          safeWrite(chunkToSSE(finalChunk));
        }
        safeWrite(SSE_DONE);
        lastStreamWrite = Date.now();
        res.end();

        if (result.durationMs) {
          observeHistogram("codex_proxy_turn_duration_ms", result.durationMs, { model: label });
        }
      } else {
        const result = await runTurn(
          prompt,
          options,
          runtime,
          "chat_completions",
          undefined,
          true,
          abortController.signal,
          session.kind === "session" ? session.sessionId : undefined,
        );
        annotateTurnUsage(result, prompt, model);
        const requestedTool = requestedFunctionTool(body);
        const proxyToolCalls = extractAllProxyToolCalls(result.text, body);
        const response = proxyToolCalls.length > 1
          ? turnResultToMultiToolCallChatCompletion(result, model, proxyToolCalls)
          : proxyToolCalls.length === 1
            ? turnResultToSpecificToolCallChatCompletion(result, model, proxyToolCalls[0].name, proxyToolCalls[0].arguments)
            : requestedTool
              ? turnResultToToolCallChatCompletion(result, model, requestedTool.function.name)
              : turnResultToChatCompletion(result, model);
        status = "ok";
        setUsageHeaders(res, result);
        res.json(response);

        if (result.durationMs) {
          observeHistogram("codex_proxy_turn_duration_ms", result.durationMs, { model: label });
        }
      }
    } catch (err) {
      incCounter("codex_proxy_errors_total", { endpoint: "chat_completions", model: label });
      if (err instanceof CodexProxyError && err.kind === "client_closed") return;
      const mapped = mapErrorToHttp(err, CONFIG.debug);
      if (!res.headersSent) {
        res.status(mapped.status).json(mapped.body);
      } else if (!res.writableEnded && res.writable) {
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
    const session = resolveSessionRequest(req, CONFIG);
    if (session.kind === "invalid") {
      incCounter("codex_proxy_errors_total", { endpoint: "responses", model: label });
      res.status(400).json(invalidRequestError(session.message, "X-Codex-Proxy-Session"));
      return;
    }

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
        const safeWrite = guardedWrite(
          (chunk) => res.write(chunk),
          () => !res.writableEnded && res.writable,
        );
        safeWrite(":ok\n\n");
        const phaseTracker = attachPhaseTracker();

        const respId = `resp_${requestId}`;
        const outputId = `msg_${uuid()}`;

        // response.created
        const partialResponse = {
          id: respId, object: "response", created_at: Math.floor(Date.now() / 1000),
          status: "in_progress", model, output: [],
          instructions: body.instructions ?? null,
          metadata: body.metadata ?? null,
          previous_response_id: body.previous_response_id ?? null,
          temperature: body.temperature ?? null,
          top_p: body.top_p ?? null,
        };
        safeWrite(makeResponseStreamEvent("response.created", { response: partialResponse }));
        lastStreamWrite = Date.now();

        safeWrite(makeResponseStreamEvent("response.in_progress", { response: partialResponse }));
        lastStreamWrite = Date.now();

        // output_item.added
        safeWrite(makeResponseStreamEvent("response.output_item.added", {
          output_index: 0,
          item: { type: "message", id: outputId, role: "assistant", status: "in_progress", content: [] },
        }));
        lastStreamWrite = Date.now();

        safeWrite(makeResponseStreamEvent("response.content_part.added", {
          output_index: 0,
          content_index: 0,
          item_id: outputId,
          part: { type: "output_text", text: "" },
        }));
        lastStreamWrite = Date.now();

        const keepalive = startSseKeepalive(CONFIG.keepaliveMs, safeWrite, () => lastStreamWrite, (next) => {
          lastStreamWrite = next;
        }, (count) => {
          const phase = phaseTracker.poll();
          if (phase && hasRenderableAssistantContent(phase.text)) {
            return makeResponseTextDeltaEvent(0, 0, `${phase.text}\n`, { responseId: respId, itemId: outputId });
          }
          return createSseKeepaliveComment(requestId, count);
        });

        const observeNotification: NotificationCallback = (method, params) => phaseTracker.observe(method, params);
        let result: TurnResult;
        try {
          result = await runTurn(prompt, options, runtime, "responses", (delta) => {
            safeWrite(makeResponseTextDeltaEvent(0, 0, delta, { responseId: respId, itemId: outputId }));
            lastStreamWrite = Date.now();
          }, false, abortController.signal, session.kind === "session" ? session.sessionId : undefined, observeNotification);
        } finally {
          if (keepalive) clearInterval(keepalive);
          phaseTracker.detach();
        }
        status = "ok";
        annotateTurnUsage(result, prompt, model);

        // output_text.done
        safeWrite(makeResponseTextDoneEvent(0, 0, result.text, { responseId: respId, itemId: outputId }));
        lastStreamWrite = Date.now();

        safeWrite(makeResponseStreamEvent("response.content_part.done", {
          output_index: 0,
          content_index: 0,
          item_id: outputId,
          part: { type: "output_text", text: result.text },
        }));
        lastStreamWrite = Date.now();

        // output_item.done
        safeWrite(makeResponseStreamEvent("response.output_item.done", {
          output_index: 0,
          item: {
            type: "message", id: outputId, role: "assistant", status: "completed",
            content: [{ type: "output_text", text: result.text }],
          },
        }));
        lastStreamWrite = Date.now();

        // response.completed plus response.done alias for newer clients.
        const finalResponse = turnResultToResponseObject(result, model, {
          responseId: respId,
          outputId,
          instructions: body.instructions ?? null,
          metadata: body.metadata,
          previousResponseId: body.previous_response_id,
          temperature: body.temperature ?? null,
          topP: body.top_p ?? null,
        });
        safeWrite(makeResponseStreamEvent("response.completed", {
          response: finalResponse,
        }));
        lastStreamWrite = Date.now();

        safeWrite(makeResponseDoneEvent(finalResponse));
        lastStreamWrite = Date.now();

        res.end();

        if (result.durationMs) {
          observeHistogram("codex_proxy_turn_duration_ms", result.durationMs, { model: label });
        }
      } else {
        const result = await runTurn(
          prompt,
          options,
          runtime,
          "responses",
          undefined,
          true,
          abortController.signal,
          session.kind === "session" ? session.sessionId : undefined,
        );
        annotateTurnUsage(result, prompt, model);
        const response = turnResultToResponseObject(result, model, {
          instructions: body.instructions ?? null,
          metadata: body.metadata,
          previousResponseId: body.previous_response_id,
          temperature: body.temperature ?? null,
          topP: body.top_p ?? null,
        });
        status = "ok";
        setUsageHeaders(res, result);
        res.json(response);

        if (result.durationMs) {
          observeHistogram("codex_proxy_turn_duration_ms", result.durationMs, { model: label });
        }
      }
    } catch (err) {
      incCounter("codex_proxy_errors_total", { endpoint: "responses", model: label });
      if (err instanceof CodexProxyError && err.kind === "client_closed") return;
      const mapped = mapErrorToHttp(err, CONFIG.debug);
      if (!res.headersSent) {
        res.status(mapped.status).json(mapped.body);
      } else if (!res.writableEnded && res.writable) {
        res.write(makeResponseStreamEvent("error", mapped.body as unknown as Record<string, unknown>));
        res.end();
      }
    }
  };

  router.post("/responses", handleResponses);
  router.post("/v1/responses", handleResponses);

  return router;
}

function setUsageHeaders(res: Response, result: TurnResult): void {
  if (!result.usage) return;
  res.setHeader("X-Codex-Proxy-Prompt-Tokens", String(result.usage.inputTokens || 0));
  res.setHeader("X-Codex-Proxy-Completion-Tokens", String(result.usage.outputTokens || 0));
  res.setHeader("X-Codex-Proxy-Total-Tokens", String(result.usage.totalTokens || 0));
  res.setHeader("X-Codex-Proxy-Usage-Estimated", result.usageEstimated ? "true" : "false");
  if (result.cost) res.setHeader("X-Codex-Proxy-Estimated-Cost-Usd", result.cost.total_cost_usd.toFixed(6));
}

async function runTurn(
  prompt: string,
  options: CodexSubprocessOptions,
  runtime: RuntimeMode,
  endpoint: EndpointName,
  deltaCallback?: DeltaCallback,
  allowFallback = true,
  signal?: AbortSignal,
  sessionId?: string,
  notificationCallback?: NotificationCallback,
): Promise<TurnResult> {
  if (sessionId) {
    return runTurnOnce(prompt, options, runtime, deltaCallback, signal, sessionId, notificationCallback);
  }

  try {
    return await runTurnOnce(prompt, options, runtime, deltaCallback, signal, undefined, notificationCallback);
  } catch (err) {
    if (
      runtime === "pool"
      && allowFallback
      && CONFIG.fallbackOnPoolFailure
      && isPoolTransportFault(err)
    ) {
      recordFallback("pool_failure");
      incCounter("codex_proxy_errors_total", { endpoint, model: options.model, runtime: "pool" });
      return runTurnOnce(prompt, options, "oneshot", deltaCallback, signal, undefined, notificationCallback);
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
  sessionId?: string,
  notificationCallback?: NotificationCallback,
): Promise<TurnResult> {
  if (sessionId) {
    const turn = GLOBAL_CODEX_SESSIONS.runTurn(sessionId, prompt, options, deltaCallback, notificationCallback);
    return await withAbort(turn, signal, () => GLOBAL_CODEX_SESSIONS.abortSession(sessionId, options));
  }

  if (runtime === "oneshot") {
    const subprocess = new CodexSubprocess();
    try {
      await subprocess.start(options);
      const turn = deltaCallback
        ? subprocess.submitTurnStreaming(prompt, options, deltaCallback, notificationCallback)
        : subprocess.submitTurn(prompt, options, deltaCallback, notificationCallback);
      return await withAbort(turn, signal, () => subprocess.kill("SIGTERM", "killed"));
    } finally {
      subprocess.kill();
    }
  }

  let lease: PoolLease<CodexSubprocess> | null = null;
  try {
    lease = await GLOBAL_CODEX_POOL.acquire(options);
    const turn = deltaCallback
      ? lease.worker.submitTurnStreaming(prompt, options, deltaCallback, notificationCallback)
      : lease.worker.submitTurn(prompt, options, deltaCallback, notificationCallback);
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
