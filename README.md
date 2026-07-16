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

Scaffolding phase — see the build phases (P0–P6) in the implementation guide.

## Quick start (once scaffolded)

```bash
cp .env.example .env      # set DASHSCOPE_API_KEY and SUSUMATE_API_URL
npm install
npm run gateway           # prints a QR — scan with the SusuMate WhatsApp number
```
