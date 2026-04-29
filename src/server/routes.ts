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
import { CodexSubprocess } from "../subprocess/manager.js";
import { incCounter, observeHistogram, recordRequest, renderMetrics } from "./metrics.js";
import { CONFIG } from "./config.js";
import { invalidRequestError, mapErrorToHttp } from "./errors.js";
import { NAME, VERSION } from "./version.js";
import type { ChatCompletionRequest, ResponseRequest, ModelObject, ModelListResponse } from "../types/openai.js";

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
    const subprocess = new CodexSubprocess();
    res.on("close", () => {
      recordRequest({ endpoint: "chat_completions", model, status, durationMs: Date.now() - reqStart });
      if (!res.writableEnded) subprocess.kill();
    });

    try {
      await subprocess.start(options);

      if (body.stream) {
        res.setHeader("Content-Type", "text/event-stream");
        res.setHeader("Cache-Control", "no-cache");
        res.setHeader("Connection", "keep-alive");
        res.setHeader("X-Accel-Buffering", "no");
        res.setHeader("X-Request-Id", requestId);
        res.flushHeaders();
        res.write(":ok\n\n");

        const streamId = requestId;
        const result = await subprocess.submitTurnStreaming(prompt, options, (delta) => {
          const chunk = makeChatCompletionChunk(streamId, model, delta);
          res.write(chunkToSSE(chunk));
        });
        status = "ok";

        // Final chunk with finish_reason
        const finalChunk = makeChatCompletionChunk(streamId, model, null, "stop");
        res.write(chunkToSSE(finalChunk));
        res.write(SSE_DONE);
        res.end();

        if (result.durationMs) {
          observeHistogram("codex_proxy_turn_duration_ms", result.durationMs, { model: label });
        }
      } else {
        const result = await subprocess.submitTurn(prompt, options);
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
    } finally {
      subprocess.kill();
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
    const subprocess = new CodexSubprocess();
    res.on("close", () => {
      recordRequest({ endpoint: "responses", model, status, durationMs: Date.now() - reqStart });
      if (!res.writableEnded) subprocess.kill();
    });

    try {
      await subprocess.start(options);

      if (body.stream) {
        res.setHeader("Content-Type", "text/event-stream");
        res.setHeader("Cache-Control", "no-cache");
        res.setHeader("Connection", "keep-alive");
        res.setHeader("X-Accel-Buffering", "no");
        res.setHeader("X-Request-Id", requestId);
        res.flushHeaders();
        res.write(":ok\n\n");

        const respId = `resp_${requestId}`;
        const outputId = `msg_${uuid()}`;

        // response.created
        res.write(makeResponseStreamEvent("response.created", {
          response: { id: respId, object: "response", created_at: Math.floor(Date.now() / 1000), status: "in_progress", model, output: [] },
        }));

        res.write(makeResponseStreamEvent("response.in_progress", {
          response: { id: respId, object: "response", created_at: Math.floor(Date.now() / 1000), status: "in_progress", model, output: [] },
        }));

        // output_item.added
        res.write(makeResponseStreamEvent("response.output_item.added", {
          output_index: 0,
          item: { type: "message", id: outputId, role: "assistant", status: "in_progress", content: [] },
        }));

        res.write(makeResponseStreamEvent("response.content_part.added", {
          output_index: 0,
          content_index: 0,
          item_id: outputId,
          part: { type: "output_text", text: "" },
        }));

        const result = await subprocess.submitTurnStreaming(prompt, options, (delta) => {
          res.write(makeResponseStreamEvent("response.output_text.delta", {
            output_index: 0, content_index: 0, delta,
          }));
        });
        status = "ok";

        // output_text.done
        res.write(makeResponseTextDoneEvent(0, 0, result.text));

        res.write(makeResponseStreamEvent("response.content_part.done", {
          output_index: 0,
          content_index: 0,
          item_id: outputId,
          part: { type: "output_text", text: result.text },
        }));

        // output_item.done
        res.write(makeResponseStreamEvent("response.output_item.done", {
          output_index: 0,
          item: {
            type: "message", id: outputId, role: "assistant", status: "completed",
            content: [{ type: "output_text", text: result.text }],
          },
        }));

        // response.completed
        res.write(makeResponseStreamEvent("response.completed", {
          response: turnResultToResponseObject(result, model, { responseId: respId, outputId }),
        }));

        res.end();

        if (result.durationMs) {
          observeHistogram("codex_proxy_turn_duration_ms", result.durationMs, { model: label });
        }
      } else {
        const result = await subprocess.submitTurn(prompt, options);
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
    } finally {
      subprocess.kill();
    }
  };

  router.post("/responses", handleResponses);
  router.post("/v1/responses", handleResponses);

  return router;
}
