// WhatsApp Cloud API channel (Meta Graph). Inbound via a verified webhook on the shared HTTP
// server; egress via the Graph messages endpoint. The official, ban-safe path (vs Baileys).
// Registered only when the Cloud token + phone number id are configured.

import { createHmac, randomUUID } from 'node:crypto';
import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { HttpServer } from '../runtime/http.js';
import { sendJson } from '../runtime/http.js';
import type {
  Channel,
  Capabilities,
  InboundMessage,
  MediaKind,
  OutboundMedia,
  OutboundOptions,
  SendResult,
} from './envelope.js';

export interface CloudOptions {
  accountId: string;
  phoneNumberId: string;
  token: string;
  verifyToken: string;
  appSecret?: string;
  mediaDir: string;
  http: HttpServer;
  graphVersion?: string;
  webhookPath?: string;
}

const EXT: Record<string, string> = {
  'audio/ogg': '.ogg', 'audio/mpeg': '.mp3', 'audio/mp4': '.m4a', 'audio/amr': '.amr',
  'image/jpeg': '.jpg', 'image/png': '.png', 'application/pdf': '.pdf', 'video/mp4': '.mp4',
};

export class WhatsAppCloudChannel implements Channel {
  readonly id = 'whatsapp_cloud' as const;
  readonly accountId: string;
  readonly capabilities: Capabilities = { media: true, voice: true, replyTo: false, reactions: false, typing: true };

  private cb: ((m: InboundMessage) => void) | null = null;
  private readonly graph: string;
  private readonly path: string;
  // The Cloud API typing indicator is coupled to a read receipt and needs the id of an inbound
  // message. Remember the most recent inbound id per chat so setTyping() can reference it.
  private readonly lastInboundId = new Map<string, string>();

  constructor(private readonly opts: CloudOptions) {
    this.accountId = opts.accountId;
    this.graph = `https://graph.facebook.com/${opts.graphVersion ?? 'v21.0'}`;
    this.path = opts.webhookPath ?? '/webhooks/whatsapp';
  }

  onMessage(cb: (m: InboundMessage) => void): void {
    this.cb = cb;
  }

  async start(): Promise<void> {
    await mkdir(join(this.opts.mediaDir, 'inbound'), { recursive: true });

    // Meta webhook verification handshake.
    this.opts.http.route('GET', this.path, (_req, res, url) => {
      if (
        url.searchParams.get('hub.mode') === 'subscribe' &&
        url.searchParams.get('hub.verify_token') === this.opts.verifyToken
      ) {
        res.writeHead(200, { 'content-type': 'text/plain' });
        res.end(url.searchParams.get('hub.challenge') ?? '');
        return true;
      }
      res.writeHead(403);
      res.end('forbidden');
      return true;
    });

    // Inbound messages.
    this.opts.http.route('POST', this.path, async (req, res, _url, body) => {
      if (this.opts.appSecret && !this.verifySignature(req.headers['x-hub-signature-256'], body)) {
        res.writeHead(401);
        res.end('bad signature');
        return true;
      }
      sendJson(res, 200, { ok: true }); // ack fast; Meta retries on non-200
      try {
        await this.ingest(body);
      } catch (e) {
        console.error('[whatsapp_cloud] ingest error', e);
      }
      return true;
    });

    console.error(`[whatsapp_cloud] webhook on ${this.path} (phone_number_id ${this.opts.phoneNumberId})`);
  }

  async stop(): Promise<void> {
    /* shares the gateway HTTP server; nothing to close */
  }

  private verifySignature(header: string | string[] | undefined, body: string): boolean {
    const sig = Array.isArray(header) ? header[0] : header;
    if (!sig?.startsWith('sha256=')) return false;
    const expected = 'sha256=' + createHmac('sha256', this.opts.appSecret!).update(body).digest('hex');
    return sig === expected;
  }

  private async ingest(body: string): Promise<void> {
    const data = JSON.parse(body || '{}');
    for (const entry of data.entry ?? []) {
      for (const change of entry.changes ?? []) {
        const value = change.value ?? {};
        const contactName = value.contacts?.[0]?.profile?.name;
        for (const msg of value.messages ?? []) {
          if (msg.from && msg.id) this.lastInboundId.set(msg.from, msg.id);
          const inbound = await this.normalize(msg, contactName);
          if (inbound) this.cb?.(inbound);
        }
      }
    }
  }

  private async normalize(msg: any, senderName?: string): Promise<InboundMessage | null> {
    const from: string = msg.from;
    if (!from) return null;
    const type: string = msg.type;
    const text = msg.text?.body || msg.image?.caption || msg.video?.caption || msg.document?.caption || '';

    let media: InboundMessage['media'];
    const mediaNode = msg.image || msg.audio || msg.voice || msg.video || msg.document || msg.sticker;
    if (mediaNode?.id) {
      const kind: MediaKind =
        msg.image ? 'image' : msg.audio || msg.voice ? 'audio' : msg.video ? 'video' : msg.sticker ? 'sticker' : 'document';
      media = await this.downloadMedia(mediaNode.id, kind, type === 'voice' || !!msg.voice);
    }

    return {
      channel: 'whatsapp_cloud',
      accountId: this.accountId,
      chatId: from,
      senderId: from,
      senderName,
      senderE164: from,
      isGroup: false,
      fromMe: false,
      text,
      mentionedSelf: false,
      replyToId: msg.context?.id,
      media,
      timestamp: Number(msg.timestamp ?? 0) * 1000,
      raw: msg,
    };
  }

  private async downloadMedia(mediaId: string, kind: MediaKind, isVoice: boolean): Promise<InboundMessage['media']> {
    const meta: any = await (
      await fetch(`${this.graph}/${mediaId}`, { headers: { Authorization: `Bearer ${this.opts.token}` } })
    ).json();
    const url: string = meta.url;
    const mime: string = (meta.mime_type || '').split(';')[0] || 'application/octet-stream';
    const buf = Buffer.from(
      await (await fetch(url, { headers: { Authorization: `Bearer ${this.opts.token}` } })).arrayBuffer(),
    );
    const ext = EXT[mime] || '.bin';
    const path = join(this.opts.mediaDir, 'inbound', `${randomUUID()}${ext}`);
    await writeFile(path, buf);
    return { path, mime, kind, isVoice };
  }

  private async post(payload: Record<string, unknown>): Promise<SendResult> {
    const res = await fetch(`${this.graph}/${this.opts.phoneNumberId}/messages`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', Authorization: `Bearer ${this.opts.token}` },
      body: JSON.stringify({ messaging_product: 'whatsapp', ...payload }),
    });
    const json: any = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(`graph ${res.status}: ${JSON.stringify(json).slice(0, 300)}`);
    return { messageId: json.messages?.[0]?.id ?? '', chatId: String(payload.to), timestamp: Date.now() };
  }

  async sendText(to: string, text: string): Promise<SendResult> {
    return this.post({ to, type: 'text', text: { body: text } });
  }

  async sendMedia(to: string, media: OutboundMedia): Promise<SendResult> {
    // Cloud API needs a hosted media URL or a pre-uploaded media id; caption-as-text fallback for now.
    return this.sendText(to, media.caption || '[media]');
  }

  // Show the "typing…" bubble. The Cloud API only supports turning it ON (it auto-dismisses when we
  // send our reply, or after 25s), and requires the id of an inbound message from this chat — the
  // call doubles as the read receipt (blue ticks). No-op when `on` is false or we have no message id.
  async setTyping(to: string, on: boolean): Promise<void> {
    if (!on) return;
    const messageId = this.lastInboundId.get(to);
    if (!messageId) return;
    try {
      await fetch(`${this.graph}/${this.opts.phoneNumberId}/messages`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', Authorization: `Bearer ${this.opts.token}` },
        body: JSON.stringify({
          messaging_product: 'whatsapp',
          status: 'read',
          message_id: messageId,
          typing_indicator: { type: 'text' },
        }),
      });
    } catch (e) {
      /* typing indicator is best-effort */
      console.error('[whatsapp_cloud] setTyping failed', e);
    }
  }
}
