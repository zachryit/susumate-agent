// The gateway: starts the WhatsApp channel, debounces inbound bursts, runs the Mate turn, and
// sends the reply back (chunked). Group messages are answered only when Mate is @mentioned.

import { loadConfig, primaryModel, fallbackModels, type AgentConfig } from './config.js';
import { ChatProvider } from './agent/provider.js';
import { ChannelRouter } from './channels/index.js';
import { BaileysChannel } from './channels/baileys.js';
import { Debouncer } from './channels/middleware/debounce.js';
import { sessionKey, type InboundMessage } from './channels/envelope.js';
import { SusumateClient } from './susumate/client.js';
import { SessionStore } from './sessions/store.js';
import { runMateTurn, type MateDeps } from './agent/mate.js';
import { startHealthServer } from './runtime/http.js';

const CHUNK = 3500;

function chunkText(text: string): string[] {
  const out: string[] = [];
  let rest = text;
  while (rest.length > CHUNK) {
    let cut = rest.lastIndexOf('\n', CHUNK);
    if (cut < CHUNK * 0.6) cut = CHUNK;
    out.push(rest.slice(0, cut));
    rest = rest.slice(cut).replace(/^\n/, '');
  }
  if (rest) out.push(rest);
  return out;
}

/** Ensure a phone is stored with a leading +, matching SusuMate's User.phone format. */
function e164WithPlus(digits?: string): string | undefined {
  if (!digits) return undefined;
  return digits.startsWith('+') ? digits : '+' + digits;
}

export async function startGateway(): Promise<void> {
  const cfg: AgentConfig = loadConfig();

  const provider = new ChatProvider();
  const model = primaryModel(cfg); // throws a clear error if DASHSCOPE_API_KEY is missing
  const fallbacks = fallbackModels(cfg);
  console.error(`[gateway] model: ${model.ref}${fallbacks.length ? ` (fallbacks: ${fallbacks.map((m) => m.ref).join(', ')})` : ''}`);
  console.error(`[gateway] susumate api: ${cfg.susumateApiUrl}`);

  const client = new SusumateClient(cfg.susumateApiUrl, cfg.susumateTimeoutMs);
  const store = new SessionStore(cfg.sessionStore, cfg.sessionEncKey, cfg.maxHistory);
  store.startAutoFlush();

  const mateDeps: MateDeps = { cfg, provider, model, fallbacks, client, store };

  const router = new ChannelRouter();
  const wa = new BaileysChannel({
    accountId: cfg.wa.accountId,
    authDir: cfg.wa.authDir,
    mediaDir: cfg.wa.mediaDir,
    mediaMaxBytes: cfg.wa.mediaMaxBytes,
    printQr: cfg.wa.printQr,
    pairNumber: cfg.wa.pairNumber,
    qrPngPath: cfg.wa.qrPngPath,
  });
  router.register(wa);

  const startedAt = Date.now();
  startHealthServer(cfg.httpPort, () => ({
    status: 'ok',
    channels: ['whatsapp'],
    uptimeSec: Math.round((Date.now() - startedAt) / 1000),
  }));

  // Debounce coalesces rapid consecutive messages into one turn.
  const debouncer = new Debouncer(cfg.debounceMs, (key, messages) => {
    void handleBurst(key, messages).catch((e) => console.error('[gateway] handleBurst error', e));
  });

  async function handleBurst(key: string, messages: InboundMessage[]): Promise<void> {
    const first = messages[0]!;
    const last = messages[messages.length - 1]!;
    const phone = e164WithPlus(first.senderE164);
    const session = store.get(key, phone);

    // Record the most recent image so campaign covers can use "attached".
    for (const m of messages) {
      if (m.media?.kind === 'image') store.setLastImage(session, { path: m.media.path, mime: m.media.mime });
    }

    const text = messages.map((m) => m.text).filter(Boolean).join('\n').trim();
    if (!text) {
      // An image with no caption — acknowledge so the user knows it landed.
      if (messages.some((m) => m.media?.kind === 'image')) {
        await send(first.chatId, "Got your photo. 👍 Tell me what you'd like to use it for.");
      }
      return;
    }

    const groupContext = first.isGroup;
    await router.setTyping('whatsapp', first.chatId, true).catch(() => {});
    try {
      const reply = await runMateTurn(mateDeps, {
        session,
        userMessage: text,
        groupContext,
        chatTail: groupContext ? messages.map((m) => `${m.senderName ?? m.senderE164 ?? 'someone'}: ${m.text}`) : undefined,
      });
      await send(last.chatId, reply);
    } finally {
      await router.setTyping('whatsapp', first.chatId, false).catch(() => {});
    }
  }

  async function send(chatId: string, text: string): Promise<void> {
    for (const chunk of chunkText(text)) {
      await router.sendText('whatsapp', chatId, chunk).catch((e) => console.error('[gateway] send failed', e));
    }
  }

  router.onMessage((m) => {
    if (m.fromMe) return; // ignore our own echoes
    // In groups, only engage when @mentioned.
    if (m.isGroup && !m.mentionedSelf) return;
    debouncer.push(sessionKey(m), m);
  });

  await router.start();
  console.error('[gateway] started — waiting for WhatsApp messages');

  const shutdown = async () => {
    console.error('[gateway] shutting down…');
    debouncer.clear();
    store.stopAutoFlush();
    await router.stop();
    process.exit(0);
  };
  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);
}
