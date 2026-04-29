import express, { type Express, type Request, type Response, type NextFunction } from "express";
import { createServer, type Server } from "node:http";
import { v4 as uuid } from "uuid";
import { CONFIG, parseConfig } from "./config.js";
import { createRouter } from "./routes.js";

export interface ServerOptions {
  host?: string;
  port?: number;
  maxBodySize?: string;
}

let serverInstance: Server | null = null;

export function createApp(options: Pick<ServerOptions, "maxBodySize"> = {}): Express {
  const app = express();
  app.disable("x-powered-by");
  app.use((req: Request, res: Response, next: NextFunction) => {
    const requestId = req.header("x-request-id") || uuid().replace(/-/g, "").slice(0, 24);
    res.locals.requestId = requestId;
    res.setHeader("X-Request-Id", requestId);
    const started = Date.now();
    res.on("finish", () => {
      if (CONFIG.debug) {
        console.error(`[codex-proxy] req_id=${requestId} method=${req.method} path=${req.path} status=${res.statusCode} duration_ms=${Date.now() - started}`);
      }
    });
    next();
  });
  app.use(express.json({ limit: options.maxBodySize || CONFIG.maxBodySize }));
  app.use(createRouter());
  app.use((_req: Request, res: Response) => {
    res.status(404).json({ error: { message: "Not found", type: "invalid_request_error", code: "not_found" } });
  });
  return app;
}

export async function startServer(options: ServerOptions = {}) {
  const cfg = parseConfig(process.env);
  const host = options.host || cfg.host;
  const port = options.port ?? cfg.port;
  const app = createApp(options);

  return new Promise<{ app: Express; server: Server; host: string; port: number }>((resolve, reject) => {
    const server = createServer(app);
    serverInstance = server;
    server.once("error", reject);
    server.listen(port, host, () => resolve({ app, server, host, port }));
  });
}

export async function stopServer(graceMs = CONFIG.shutdownGraceMs): Promise<void> {
  if (!serverInstance) return;
  const server = serverInstance;
  serverInstance = null;

  await new Promise<void>((resolve, reject) => {
    const timer = setTimeout(() => {
      server.closeAllConnections?.();
      resolve();
    }, graceMs);
    server.close((err) => {
      clearTimeout(timer);
      if (err) reject(err);
      else resolve();
    });
  });
}
