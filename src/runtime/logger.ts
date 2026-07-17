// File + console logging. Tees console.error (what the gateway/channels
// use) to a persistent log file so operators aren't dependent on the process's stdout buffer.

import { mkdirSync, createWriteStream, type WriteStream } from 'node:fs';
import { resolve, join } from 'node:path';

let stream: WriteStream | null = null;

function fmt(a: unknown): string {
  if (typeof a === 'string') return a;
  try {
    return JSON.stringify(a);
  } catch {
    return String(a);
  }
}

export function configureLogging(dir?: string): void {
  const d = resolve(dir ?? process.env.LOG_DIR ?? join(process.cwd(), 'logs'));
  try {
    mkdirSync(d, { recursive: true });
    stream = createWriteStream(join(d, 'gateway.log'), { flags: 'a' });
    const orig = console.error.bind(console);
    console.error = ((...args: unknown[]) => {
      try {
        stream?.write(`[${new Date().toISOString()}] ${args.map(fmt).join(' ')}\n`);
      } catch {
        /* logging is best-effort */
      }
      orig(...(args as Parameters<typeof orig>));
    }) as typeof console.error;
    console.error(`[log] file logging -> ${join(d, 'gateway.log')}`);
  } catch {
    /* fall back to console only */
  }
}
