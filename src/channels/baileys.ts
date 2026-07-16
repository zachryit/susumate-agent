// WhatsApp channel via Baileys (WhatsApp Web), ported from swimbot. QR pairing, persisted creds,
// reconnect, normalized ingress, and text/media/voice egress. Isolated behind the Channel
// interface so it can be swapped for the WhatsApp Cloud API without touching the agent loop.

import makeWASocket, {
  useMultiFileAuthState,
  makeCacheableSignalKeyStore,
  fetchLatestBaileysVersion,
  downloadMediaMessage,
  getContentType,
  jidNormalizedUser,
  DisconnectReason,
  type WASocket,
  type proto,
} from 'baileys';
import { mkdir, writeFile, rm } from 'node:fs/promises';
import { join, extname } from 'node:path';
import { randomUUID } from 'node:crypto';
import qrcodeTerminal from 'qrcode-terminal';
import QRCode from 'qrcode';
import type {
  Channel,
  Capabilities,
  InboundMessage,
  MediaKind,
  OutboundMedia,
  OutboundOptions,
  SendResult,
} from './envelope.js';

// Baileys wants a pino-like logger; we keep it silent.
const silentLogger: any = {
  level: 'silent',
  child: () => silentLogger,
  trace() {}, debug() {}, info() {}, warn() {}, error() {}, fatal() {},
};

export interface BaileysOptions {
  accountId: string;
  authDir: string; // persisted creds.json + signal keys
  mediaDir: string; // inbound media downloaded here (under /inbound)
  mediaMaxBytes?: number;
  printQr?: boolean;
  /** If set (international number, digits only), pair via an 8-char code instead of a QR. */
  pairNumber?: string;
  /** If set, also write each QR to this PNG path (open it in an editor and scan). */
  qrPngPath?: string;
}

const MIME_EXT: Record<string, string> = {
  'audio/ogg': '.ogg', 'audio/mpeg': '.mp3', 'audio/mp4': '.m4a', 'audio/wav': '.wav',
  'image/jpeg': '.jpg', 'image/png': '.png', 'image/webp': '.webp',
  'application/pdf': '.pdf', 'video/mp4': '.mp4',
};

export class BaileysChannel implements Channel {
  readonly id = 'whatsapp' as const;
  readonly accountId: string;
  readonly capabilities: Capabilities = { media: true, voice: true, replyTo: true, reactions: true, typing: true };

  private sock: WASocket | null = null;
  private cb: ((m: InboundMessage) => void) | null = null;
  private stopping = false;
  private selfJid = '';
  private lidToPn = new Map<string, string>(); // learned WhatsApp LID -> phone-number mapping
  private presenceTimer: ReturnType<typeof setInterval> | null = null;

  constructor(private readonly opts: BaileysOptions) {
    this.accountId = opts.accountId;
  }

  onMessage(cb: (m: InboundMessage) => void): void {
    this.cb = cb;
  }

  async start(): Promise<void> {
    this.stopping = false;
    await mkdir(this.opts.authDir, { recursive: true });
    await mkdir(join(this.opts.mediaDir, 'inbound'), { recursive: true });
    await this.connect();
  }

  async stop(): Promise<void> {
    this.stopping = true;
    this.stopPresenceKeepalive();
    try {
      this.sock?.end(undefined);
    } catch {
      /* ignore */
    }
    this.sock = null;
  }

  // Keep the account showing "online". WhatsApp reverts presence to offline after a short idle
  // window, so we re-assert `available` periodically (and on every reconnect).
  private startPresenceKeepalive(): void {
    const assert = () => {
      this.sock?.sendPresenceUpdate('available').catch(() => {});
    };
    assert();
    this.stopPresenceKeepalive();
    this.presenceTimer = setInterval(assert, 10_000);
    this.presenceTimer.unref?.();
  }

  private stopPresenceKeepalive(): void {
    if (this.presenceTimer) {
      clearInterval(this.presenceTimer);
      this.presenceTimer = null;
    }
  }

  private async connect(): Promise<void> {
    const { state, saveCreds } = await useMultiFileAuthState(this.opts.authDir);
    const { version } = await fetchLatestBaileysVersion();

    const sock = makeWASocket({
      version,
      auth: { creds: state.creds, keys: makeCacheableSignalKeyStore(state.keys, silentLogger) },
      logger: silentLogger,
      browser: ['susumate', 'Chrome', '1.0.0'],
      syncFullHistory: false,
      markOnlineOnConnect: true,
    });
    this.sock = sock;
    sock.ev.on('creds.update', saveCreds);

    // Pairing-code flow (preferred when a QR can't be scanned).
    const alreadyLinked = state.creds.registered || !!state.creds.me?.lid;
    if (this.opts.pairNumber && !alreadyLinked) {
      const phone = this.opts.pairNumber.replace(/[^0-9]/g, '');
      setTimeout(async () => {
        try {
          const code = await sock.requestPairingCode(phone);
          const pretty = code?.match(/.{1,4}/g)?.join('-') ?? code;
          console.error(
            `\n[whatsapp] PAIRING CODE: ${pretty}\n` +
              `  On +${phone}: WhatsApp → Linked Devices → Link a Device →\n` +
              `  "Link with phone number instead" → enter this code.\n`,
          );
        } catch (e) {
          console.error('[whatsapp] pairing-code request failed (falling back to QR):', e);
        }
      }, 3000);
    }

    sock.ev.on('connection.update', (update) => {
      const { connection, lastDisconnect, qr } = update;
      if (qr) {
        if (this.opts.qrPngPath) {
          QRCode.toFile(this.opts.qrPngPath, qr, { width: 512, margin: 2 })
            .then(() => console.error(`[whatsapp] QR image updated: ${this.opts.qrPngPath} (open it and scan)`))
            .catch((e) => console.error('[whatsapp] QR png write failed', e));
        }
        if (!this.opts.pairNumber && this.opts.printQr !== false) {
          console.error('\n[whatsapp] scan this QR to pair:\n');
          qrcodeTerminal.generate(qr, { small: true });
        }
      }
      if (connection === 'open') {
        this.selfJid = jidNormalizedUser(sock.user?.id ?? '');
        console.error(`[whatsapp] connected as ${this.selfJid}`);
        this.startPresenceKeepalive();
      }
      if (connection === 'close') {
        this.stopPresenceKeepalive();
        const code = (lastDisconnect?.error as any)?.output?.statusCode;
        const loggedOut = code === DisconnectReason.loggedOut;
        if (loggedOut) {
          console.error('[whatsapp] disconnected (logged out) — clearing stale auth state, re-pair needed');
          rm(this.opts.authDir, { recursive: true, force: true }).catch((e) =>
            console.error('[whatsapp] failed to clear stale auth dir', e),
          );
          return;
        }
        if (this.stopping) {
          console.error('[whatsapp] disconnected');
          return;
        }
        console.error(`[whatsapp] connection closed (code ${code}); reconnecting…`);
        setTimeout(() => this.connect().catch((e) => console.error('[whatsapp] reconnect failed', e)), 2000);
      }
    });

    sock.ev.on('messages.upsert', async (ev) => {
      if (ev.type !== 'notify') return;
      for (const msg of ev.messages) {
        try {
          const inbound = await this.normalize(msg);
          if (inbound) this.cb?.(inbound);
        } catch (e) {
          console.error('[whatsapp] inbound normalize error', e);
        }
      }
    });
  }

  private async normalize(msg: proto.IWebMessageInfo): Promise<InboundMessage | null> {
    if (!msg.message || !msg.key?.remoteJid) return null;
    const remoteJid = msg.key.remoteJid;
    if (remoteJid === 'status@broadcast') return null;

    const type = getContentType(msg.message);
    const isGroup = remoteJid.endsWith('@g.us');
    const fromMe = !!msg.key.fromMe;
    const m = msg.message;

    const text =
      m.conversation ||
      m.extendedTextMessage?.text ||
      m.imageMessage?.caption ||
      m.videoMessage?.caption ||
      m.documentMessage?.caption ||
      '';

    const ctxInfo = m.extendedTextMessage?.contextInfo || m.imageMessage?.contextInfo;
    const mentions = ctxInfo?.mentionedJid ?? [];
    const mentionedSelf = !!this.selfJid && mentions.includes(this.selfJid);

    let media: InboundMessage['media'];
    if (type && ['imageMessage', 'audioMessage', 'videoMessage', 'documentMessage', 'stickerMessage'].includes(type)) {
      media = await this.downloadMedia(msg, type);
    }

    // Resolve the real phone number even when WhatsApp addresses the sender by LID (privacy alias).
    const lidJid = isGroup ? (msg.key.participant ?? remoteJid) : remoteJid;
    const keyAny = msg.key as { senderPn?: string; participantPn?: string };
    const pnJid = isGroup ? keyAny.participantPn : keyAny.senderPn;
    let phone = '';
    if (pnJid) {
      phone = jidNormalizedUser(pnJid).split('@')[0] ?? '';
      if (phone && lidJid.endsWith('@lid')) this.lidToPn.set(lidJid, phone);
    } else if (lidJid.endsWith('@lid')) {
      phone = this.lidToPn.get(lidJid) ?? '';
    } else {
      phone = jidNormalizedUser(lidJid).split('@')[0] ?? '';
    }
    const senderE164 = phone || (jidNormalizedUser(lidJid).split('@')[0] ?? '');
    const resolvedSenderId = phone ? `${phone}@s.whatsapp.net` : jidNormalizedUser(lidJid);

    return {
      channel: 'whatsapp',
      accountId: this.accountId,
      chatId: remoteJid,
      senderId: resolvedSenderId,
      senderName: msg.pushName ?? undefined,
      senderE164,
      isGroup,
      fromMe,
      text,
      mentionedSelf,
      replyToId: ctxInfo?.stanzaId ?? undefined,
      media,
      timestamp: Number(msg.messageTimestamp ?? 0) * 1000,
      raw: msg,
    };
  }

  private async downloadMedia(msg: proto.IWebMessageInfo, type: string): Promise<InboundMessage['media']> {
    const node = (msg.message as any)?.[type];
    const mime: string = node?.mimetype?.split(';')[0]?.trim() || 'application/octet-stream';
    const buffer = (await downloadMediaMessage(
      msg as any,
      'buffer',
      {},
      { logger: silentLogger, reuploadRequest: this.sock!.updateMediaMessage },
    )) as Buffer;
    if (this.opts.mediaMaxBytes && buffer.length > this.opts.mediaMaxBytes) {
      console.error(`[whatsapp] media exceeds ${this.opts.mediaMaxBytes} bytes; skipping download`);
      return undefined;
    }
    const ext = MIME_EXT[mime] || extname(node?.fileName || '') || '.bin';
    const path = join(this.opts.mediaDir, 'inbound', `${randomUUID()}${ext}`);
    await writeFile(path, buffer);

    const kind: MediaKind =
      type === 'imageMessage' ? 'image' :
      type === 'audioMessage' ? 'audio' :
      type === 'videoMessage' ? 'video' :
      type === 'stickerMessage' ? 'sticker' : 'document';

    return { path, mime, kind, isVoice: type === 'audioMessage' && !!node?.ptt };
  }

  private jidFor(to: string): string {
    return to.includes('@') ? to : `${to}@s.whatsapp.net`;
  }

  async sendText(to: string, text: string): Promise<SendResult> {
    const sock = this.requireSock();
    const jid = this.jidFor(to);
    const res = await sock.sendMessage(jid, { text });
    return { messageId: res?.key?.id ?? '', chatId: jid, timestamp: Date.now() };
  }

  async sendMedia(to: string, media: OutboundMedia, opts?: OutboundOptions): Promise<SendResult> {
    const sock = this.requireSock();
    const jid = this.jidFor(to);
    const kind = media.mime.split('/')[0];
    let content: any;
    if (opts?.asVoice || (kind === 'audio' && opts?.asVoice !== false)) {
      content = { audio: { url: media.path }, ptt: !!opts?.asVoice, mimetype: media.mime || 'audio/ogg; codecs=opus' };
    } else if (kind === 'image') {
      content = { image: { url: media.path }, caption: media.caption };
    } else if (kind === 'video') {
      content = { video: { url: media.path }, caption: media.caption };
    } else {
      content = { document: { url: media.path }, mimetype: media.mime, caption: media.caption };
    }
    const res = await sock.sendMessage(jid, content);
    return { messageId: res?.key?.id ?? '', chatId: jid, timestamp: Date.now() };
  }

  async setTyping(to: string, on: boolean): Promise<void> {
    try {
      await this.sock?.sendPresenceUpdate(on ? 'composing' : 'paused', this.jidFor(to));
    } catch {
      /* presence is best-effort */
    }
  }

  private requireSock(): WASocket {
    if (!this.sock) throw new Error('[whatsapp] socket not connected');
    return this.sock;
  }
}
