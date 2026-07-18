// Tiny HTTP server: liveness/health plus registerable routes (used by the WhatsApp Cloud API
// webhook). Dependency-free.

import { createServer, type Server, type IncomingMessage, type ServerResponse } from 'node:http';

export interface HealthInfo {
  status: 'ok';
  channels: string[];
  uptimeSec: number;
}

/** A route handler receives the parsed URL and (for POST) the raw request body. Return true once handled. */
export type RouteHandler = (
  req: IncomingMessage,
  res: ServerResponse,
  url: URL,
  body: string,
) => boolean | Promise<boolean>;

export class HttpServer {
  private server: Server | null = null;
  private routes = new Map<string, RouteHandler>();
  private healthFn: (() => HealthInfo) | null = null;

  constructor(private readonly port: number) {}

  route(method: string, path: string, handler: RouteHandler): void {
    this.routes.set(`${method.toUpperCase()} ${path}`, handler);
  }

  setHealth(fn: () => HealthInfo): void {
    this.healthFn = fn;
  }

  start(): void {
    this.server = createServer((req, res) => {
      const url = new URL(req.url ?? '/', `http://localhost:${this.port}`);
      const handler = this.routes.get(`${(req.method ?? 'GET').toUpperCase()} ${url.pathname}`);

      if (!handler) {
        if (req.method === 'GET' && (url.pathname === '/health' || url.pathname === '/')) {
          sendJson(res, 200, this.healthFn?.() ?? { status: 'ok' });
        } else {
          sendJson(res, 404, { error: 'not_found' });
        }
        return;
      }

      const chunks: Buffer[] = [];
      req.on('data', (c) => chunks.push(c as Buffer));
      req.on('end', () => {
        const body = Buffer.concat(chunks).toString('utf8');
        Promise.resolve(handler(req, res, url, body)).catch((e) => {
          console.error('[http] route error', e);
          if (!res.headersSent) sendJson(res, 500, { error: 'server_error' });
        });
      });
    });
    this.server.listen(this.port, () => console.error(`[http] server on :${this.port}`));
    this.server.on('error', (e) => console.error('[http] server error', e));
  }

  stop(): void {
    this.server?.close();
    this.server = null;
  }
}

export function sendJson(res: ServerResponse, status: number, body: unknown): void {
  res.writeHead(status, { 'content-type': 'application/json' });
  res.end(JSON.stringify(body));
}
