# susumate-agent

A standalone WhatsApp agent ("Mate") for **SusuMate**. Users chat on WhatsApp to run their
savings groups, contribute, top up, send money, and more — in plain language.

- **Stack:** Node.js + TypeScript
- **WhatsApp:** **WhatsApp Cloud API (Meta)** — the official transport (used for the hackathon).
  Also supports Baileys (WhatsApp Web, QR) for quick local dev. Both run behind one `Channel`
  interface, selectable with `WA_CHANNEL`.
- **Auth:** per-user OTP login → the agent acts as the real user via their token
- **LLM:** Qwen Cloud (DashScope), OpenAI-compatible

See [IMPLEMENTATION-GUIDE.md](IMPLEMENTATION-GUIDE.md) for architecture and how the agent maps
chat to SusuMate API actions, and [docs/whatsapp-cloud-setup.md](docs/whatsapp-cloud-setup.md)
for the full Meta Cloud API + webhook + nginx setup.

## Transports (`WA_CHANNEL`)

| `WA_CHANNEL` | Runs | When to use |
|---|---|---|
| `cloud` | WhatsApp Cloud API (Meta) | **Production / hackathon** (official, no QR) |
| `baileys` | Baileys (WhatsApp Web, QR) | Quick local dev / demo |
| `both` | Cloud API **and** Baileys together | Running an official number and a QR number at once |

## Quick start

```bash
cp .env.example .env
#  - DASHSCOPE_API_KEY   your Qwen Cloud (DashScope) key
#  - SUSUMATE_API_URL    https://susumate.app/api   (default)
#  - SESSION_ENC_KEY     node -e "console.log(require('crypto').randomBytes(32).toString('base64'))"
#  - WA_CHANNEL          cloud | baileys | both
npm install
npm run typecheck         # optional
npm run gateway           # starts the gateway + webhook HTTP server
```

Health check: `curl localhost:8787/health` → `{"status":"ok","channels":[...]}`.

### Cloud API (recommended)
Set `WA_CHANNEL=cloud` and the `WHATSAPP_CLOUD_*` vars (token, phone number id, verify token),
expose the webhook publicly, and point Meta at it. Full walkthrough:
**[docs/whatsapp-cloud-setup.md](docs/whatsapp-cloud-setup.md)**. Once configured, anyone can
message your WhatsApp Business number and Mate replies.

### Baileys (local dev)
Set `WA_CHANNEL=baileys` and run `npm run gateway` — it prints a QR (also written to
`sessions/wa/pair-qr.png`); scan it with the phone to link. Creds persist and auto-reconnect.

In all cases: message the number and Mate greets you, walks you through phone + OTP sign-in,
then runs any SusuMate action on your behalf.

## Run in the background

```bash
npm run gateway:start     # nohup + pidfile; kills any stray instance first
npm run gateway:logs      # tail logs
npm run gateway:status    # reports the running instance count
npm run gateway:stop      # stops ALL instances for this repo
```

> Never run two instances against the same Baileys pairing — WhatsApp evicts one and the
> connection flaps (error 440). `gateway:start` guards against this automatically.

## Resetting sessions

Runtime state lives under `sessions/` (git-ignored). The running gateway holds the session
store in memory and re-saves every few seconds, so **always stop it before clearing** —
otherwise the delete won't stick.

**Soft reset** — sign everyone out and wipe chat history (keeps the WhatsApp link):

```bash
npm run gateway:stop
rm -f sessions/store.json && rm -rf sessions/media/inbound/*
npm run gateway:start
```

**Full reset** — also unpair Baileys (you'll re-scan the QR on next start; does not affect the
Cloud API):

```bash
npm run gateway:stop
rm -rf sessions/
npm run gateway:start
```
