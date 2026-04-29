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
} from "../adapter/codex-to-openai.js";
import { CodexSubprocess } from "../subprocess/manager.js";
import { incCounter, observeHistogram, renderMetrics } from "./metrics.js";
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

// ── Router factory ───────────────────────────────────────────────────

export function createRouter(): Router {
  const router = Router();

  // Health
  router.get("/health", (_req: Request, res: Response) => {
    res.json({ status: "ok", uptime: Math.floor(process.uptime()) });
  });

  // Deep health: verifies the codex binary and app-server path with a tiny turn.
  router.get("/healthz/deep", async (_req: Request, res: Response) => {
    const started = Date.now();
    const model = resolveModel(process.env.CODEX_PROXY_HEALTH_MODEL || process.env.CODEX_PROXY_DEFAULT_MODEL);
    const subprocess = new CodexSubprocess();
    try {
      await subprocess.start({ model, timeoutMs: Number(process.env.CODEX_PROXY_HEALTH_TIMEOUT_MS || 30_000) });
      const result = await subprocess.submitTurn("Reply with OK only.", {
        model,
        timeoutMs: Number(process.env.CODEX_PROXY_HEALTH_TIMEOUT_MS || 30_000),
      });
      res.json({ ok: true, status: "ok", model, latency_ms: Date.now() - started, text: result.text.slice(0, 80) });
    } catch (err) {
      res.status(503).json({
        ok: false,
        status: "error",
        model,
        latency_ms: Date.now() - started,
        error: err instanceof Error ? err.message : String(err),
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
    if (!body.messages || !Array.isArray(body.messages) || body.messages.length === 0) {
      res.status(400).json({ error: { message: "messages array is required", type: "invalid_request_error" } });
      return;
    }

    const model = resolveModel(body.model);
    const label = canonicalModelLabel(model);
    incCounter("codex_proxy_requests_total", { endpoint: "chat_completions", model: label });

    const { prompt, options } = chatRequestToOptions(body);
    const subprocess = new CodexSubprocess();

    try {
      await subprocess.start(options);

      if (body.stream) {
        res.setHeader("Content-Type", "text/event-stream");
        res.setHeader("Cache-Control", "no-cache");
        res.setHeader("Connection", "keep-alive");
        res.setHeader("X-Accel-Buffering", "no");
        res.flushHeaders();

        const streamId = uuid();
        const result = await subprocess.submitTurnStreaming(prompt, options, (delta) => {
          const chunk = makeChatCompletionChunk(streamId, model, delta);
          res.write(chunkToSSE(chunk));
        });

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
        res.json(response);

        if (result.durationMs) {
          observeHistogram("codex_proxy_turn_duration_ms", result.durationMs, { model: label });
        }
      }
    } catch (err) {
      incCounter("codex_proxy_errors_total", { endpoint: "chat_completions", model: label });
      const message = err instanceof Error ? err.message : String(err);
      if (!res.headersSent) {
        res.status(502).json({ error: { message: `Codex subprocess error: ${message}`, type: "server_error" } });
      } else {
        // Already streaming - send error event and close
        res.write(`data: ${JSON.stringify({ error: { message } })}\n\n`);
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
    if (!body.input) {
      res.status(400).json({ error: { message: "input is required", type: "invalid_request_error" } });
      return;
    }

    const model = resolveModel(body.model);
    const label = canonicalModelLabel(model);
    incCounter("codex_proxy_requests_total", { endpoint: "responses", model: label });

    const { prompt, options } = responsesRequestToOptions(body);
    const subprocess = new CodexSubprocess();

    try {
      await subprocess.start(options);

      if (body.stream) {
        res.setHeader("Content-Type", "text/event-stream");
        res.setHeader("Cache-Control", "no-cache");
        res.setHeader("Connection", "keep-alive");
        res.setHeader("X-Accel-Buffering", "no");
        res.flushHeaders();

        const respId = `resp_${uuid()}`;
        const outputId = `msg_${uuid()}`;

        // response.created
        res.write(makeResponseStreamEvent("response.created", {
          response: { id: respId, object: "response", status: "in_progress", model, output: [] },
        }));

        // output_item.added
        res.write(makeResponseStreamEvent("response.output_item.added", {
          output_index: 0,
          item: { type: "message", id: outputId, role: "assistant", status: "in_progress", content: [] },
        }));

        const result = await subprocess.submitTurnStreaming(prompt, options, (delta) => {
          res.write(makeResponseStreamEvent("response.output_text.delta", {
            output_index: 0, content_index: 0, delta,
          }));
        });

        // output_text.done
        res.write(makeResponseStreamEvent("response.output_text.done", {
          output_index: 0, content_index: 0, text: result.text,
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
          response: turnResultToResponseObject(result, model),
        }));

        res.end();

        if (result.durationMs) {
          observeHistogram("codex_proxy_turn_duration_ms", result.durationMs, { model: label });
        }
      } else {
        const result = await subprocess.submitTurn(prompt, options);
        const response = turnResultToResponseObject(result, model);
        res.json(response);

        if (result.durationMs) {
          observeHistogram("codex_proxy_turn_duration_ms", result.durationMs, { model: label });
        }
      }
    } catch (err) {
      incCounter("codex_proxy_errors_total", { endpoint: "responses", model: label });
      const message = err instanceof Error ? err.message : String(err);
      if (!res.headersSent) {
        res.status(502).json({ error: { message: `Codex subprocess error: ${message}`, type: "server_error" } });
      } else {
        res.write(makeResponseStreamEvent("error", { error: { message } }));
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
