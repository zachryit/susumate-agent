# susumate-agent

A standalone WhatsApp agent ("Mate") for **SusuMate**. Users chat on WhatsApp to run
their savings groups, contribute, top up, send money, and more. It is a separate codebase
from the SusuMate backend and talks to it **only over the public HTTP API** — keeping the
SusuMate source private.

- **Stack:** Node.js + TypeScript
- **WhatsApp:** Baileys (WhatsApp Web, QR pairing) — swappable for the Cloud API
- **Auth:** per-user OTP login → the agent acts as the real user via their token
- **LLM:** Qwen Cloud (DashScope), OpenAI-compatible; provider-agnostic

See [IMPLEMENTATION-GUIDE.md](IMPLEMENTATION-GUIDE.md) for architecture, the port plan from
SusuMate's embedded Mate agent, and the build phases.

## Status

Implemented (P0–P6) — see the build phases in the implementation guide. Typechecks clean and
boots to WhatsApp QR pairing. Pending: a real OTP login + write action against a paired number.

## Quick start

```bash
cp .env.example .env
#  - DASHSCOPE_API_KEY   your Qwen Cloud (DashScope) key
#  - SUSUMATE_API_URL    https://susumate.app/api   (default)
#  - SESSION_ENC_KEY     node -e "console.log(require('crypto').randomBytes(32).toString('base64'))"
npm install
npm run typecheck         # optional
npm run gateway           # prints a QR — scan with the SusuMate WhatsApp number
```

Then message the paired number on WhatsApp: Mate greets you, walks you through phone + OTP
sign-in, and can then run any SusuMate action on your behalf. Health check: `curl localhost:8787/health`.

## Run in the background

```bash
npm run gateway:start     # nohup + pidfile
npm run gateway:logs      # tail logs
npm run gateway:status
npm run gateway:stop
```
