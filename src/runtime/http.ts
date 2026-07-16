// Tiny HTTP server for liveness/health checks (and a home for future WhatsApp Cloud API
// webhooks). Deliberately dependency-free.

import { createServer, type Server } from 'node:http';

export interface HealthInfo {
  status: 'ok';
  channels: string[];
  uptimeSec: number;
}

export function startHealthServer(port: number, info: () => HealthInfo): Server {
  const server = createServer((req, res) => {
    if (req.url === '/health' || req.url === '/') {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify(info()));
      return;
    }
    res.writeHead(404, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ error: 'not_found' }));
  });
  server.listen(port, () => console.error(`[http] health server on :${port}`));
  server.on('error', (e) => console.error('[http] server error', e));
  return server;
}
