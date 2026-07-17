// Inbound debounce: coalesce rapid consecutive messages from one sender
// into a single agent turn, so a multi-line request doesn't fragment into many turns.

import type { InboundMessage } from '../envelope.js';

export class Debouncer {
  private timers = new Map<string, ReturnType<typeof setTimeout>>();
  private buffers = new Map<string, InboundMessage[]>();

  constructor(
    private readonly windowMs: number,
    private readonly onFlush: (key: string, messages: InboundMessage[]) => void,
  ) {}

  /** Buffer a message under `key` and (re)arm the quiet-window timer. */
  push(key: string, message: InboundMessage): void {
    const buf = this.buffers.get(key) ?? [];
    buf.push(message);
    this.buffers.set(key, buf);

    const existing = this.timers.get(key);
    if (existing) clearTimeout(existing);

    if (this.windowMs <= 0) {
      this.flush(key);
      return;
    }
    this.timers.set(
      key,
      setTimeout(() => this.flush(key), this.windowMs),
    );
  }

  private flush(key: string): void {
    const t = this.timers.get(key);
    if (t) clearTimeout(t);
    this.timers.delete(key);
    const messages = this.buffers.get(key) ?? [];
    this.buffers.delete(key);
    if (messages.length) this.onFlush(key, messages);
  }

  /** Cancel all pending timers (shutdown). */
  clear(): void {
    for (const t of this.timers.values()) clearTimeout(t);
    this.timers.clear();
    this.buffers.clear();
  }
}
