import express, { type Express } from "express";
import { createRouter } from "./routes.js";

export interface ServerOptions {
  host?: string;
  port?: number;
  maxBodySize?: string;
}

export function createApp(options: Pick<ServerOptions, "maxBodySize"> = {}): Express {
  const app = express();
  app.disable("x-powered-by");
  app.use(express.json({ limit: options.maxBodySize || process.env.CODEX_PROXY_MAX_BODY || "8mb" }));
  app.use(createRouter());
  return app;
}

export async function startServer(options: ServerOptions = {}) {
  const host = options.host || process.env.CODEX_PROXY_HOST || "127.0.0.1";
  const port = options.port ?? Number(process.env.CODEX_PROXY_PORT || 3466);
  const app = createApp(options);

  return new Promise<{ app: Express; server: ReturnType<Express["listen"]>; host: string; port: number }>((resolve, reject) => {
    const server = app.listen(port, host, () => resolve({ app, server, host, port }));
    server.once("error", reject);
  });
}
