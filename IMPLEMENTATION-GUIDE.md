# SusuMate Agent — Implementation Guide

A **standalone** conversational agent ("Mate") that lets people use SusuMate over
**WhatsApp**. It is a separate codebase from the SusuMate backend and never touches
SusuMate's source or database directly — it talks to SusuMate **only over the public
HTTP API** (the private SusuMate backend). This keeps the SusuMate code private
while the agent can be iterated, deployed, and open-sourced independently.

> **Status:** Implemented (P0–P6). Stack and key decisions are locked (below); the code
> follows the structure and phases in this document. Typechecks clean and boots to WhatsApp
> QR pairing; validated against the live SusuMate API envelope at `https://susumate.app/api`.
> Remaining before production: pair a real WhatsApp number, run a real OTP login end to end,
> and swap Baileys for the WhatsApp Cloud API.

---

## 1. Goals & non-goals

**Goals**
- Users chat with Mate on WhatsApp to do everything the SusuMate app does: create/join
  savings groups, contribute (MoMo), propose/vote payouts, top up wallet, send transfers,
  read notifications, manage their profile.
- The agent acts **as the actual user**, so SusuMate's own validation, authorization,
  country gating, and money-safety checks are reused verbatim — the agent gets no special
  powers the user doesn't have.
- Self-contained project: its own repo, deploy, and process. SusuMate only needs to expose
  the API it already has.

**Non-goals**
- No direct DB access, no importing SusuMate backend code, no shared filesystem state.
- Not a replacement for the in-app Mate; it's a second channel that reuses the same API.
- No new money movement logic in the agent — all money actions are SusuMate endpoints.

---

## 2. Locked decisions

| Decision | Choice | Rationale |
|---|---|---|
| **Stack** | Node.js + TypeScript | Mirrors swimbot; lets us reuse its WhatsApp channel almost verbatim; single language. |
| **WhatsApp transport** | Baileys (WhatsApp Web, QR pair) | Free, no Meta approval, fast to demo. Isolated behind a `Channel` interface so Cloud API can be swapped in later. |
| **API auth** | Per-user OTP login → API token | Uses SusuMate's existing `/auth/request-otp` + `/auth/verify-otp`. Agent stores each user's token and calls the API **as them**. No impersonation/superpowers. |
| **LLM** | Qwen Cloud (DashScope), OpenAI-compatible | Matches the Qwen Cloud hackathon and swimbot's default. Provider-agnostic layer keeps Gemini/Anthropic swappable. |

---

## 3. How the agent turns a chat into SusuMate actions

The agent is a small set of modules that together turn a WhatsApp message into a real,
authenticated SusuMate API call and a reply:

| Module | Responsibility |
|---|---|
| `src/agent/loop.ts` | The turn loop: prompt → LLM → tool calls → execute → reply (bounded turns). |
| `src/susumate/catalog.ts` | A declarative allowlist of ~40 SusuMate actions — each entry maps a tool name to `{method, path, params, body, sensitive, confirm, group_safe}`. |
| `src/susumate/client.ts` | The HTTP client: calls `https://<susumate>/api/...` with the user's stored bearer token, so every action runs **as that user**. |
| `src/agent/guardrails.ts` | Egress scrub + "act, never pretend" — the agent never claims an action happened unless the API confirmed it. |
| `src/agent/tools.ts` | Tool registry: guest tools (login) vs signed-in tools (the full catalog). |
| `src/channels/` + `gateway.ts` | Baileys WhatsApp channel, debounce, and the gateway that wires it all together. |

The catalog is the crown jewel — it's just data, so adding or changing an action is a
one-line edit. The client is what makes each tool real: a tool call becomes an HTTP request
to SusuMate carrying the user's token.

### The action-execution flow

```
LLM asks for tool "contributions_start" with {group, amount, confirm:true}
   → catalog lookup → method=POST path=groups/{group}/contributions body={amount}
   → HTTP client:  POST /api/groups/<group>/contributions
                   Authorization: Bearer <this user's token>
   → SusuMate runs the SAME validation + authorization + rules as the app
   → 200/422/403 JSON returned → summarized back to the LLM → reply to user
```

Because we call the real endpoints as the user, a forbidden action fails identically to
the app (same 403/422 messages) — no parallel permission logic to keep in sync.

---

## 4. Architecture

```
 WhatsApp user
      │  (text / voice / image)
      ▼
┌─────────────────────────────────────────────────────────────┐
│                    susumate-agent (Node/TS)                   │
│                                                               │
│  Baileys channel ──► debounce ──► gateway ──► agent loop      │
│    (QR pair,           (collapse    (per-user   (Qwen +       │
│     creds persisted)    bursts)      session)    tools)       │
│                                          │                     │
│                                          ├─ session store      │
│                                          │   (history + token) │
│                                          ├─ guardrails (scrub) │
│                                          └─ SusuMate API client │
│                                              │  Bearer <token> │
└──────────────────────────────────────────────┼───────────────┘
                                                 ▼
                                    SusuMate API  (private backend)
                                    /api/auth/*, /api/groups/*, /api/wallet/* …
```

Everything left of the SusuMate box is this repo. Nothing crosses into SusuMate except
HTTPS calls to its documented endpoints.

---

## 5. Project structure

```
susumate-agent/
├─ IMPLEMENTATION-GUIDE.md      ← this file
├─ README.md
├─ package.json
├─ tsconfig.json
├─ .env.example
├─ .gitignore
├─ bin/
│  └─ agent.sh                  ← start/stop/status/logs (pm2 or nohup)
├─ src/
│  ├─ index.ts                  ← entrypoint: load config, start gateway
│  ├─ config.ts                 ← env → typed config (providers, susumate base URL)
│  ├─ gateway.ts                ← wires channel → debounce → loop → send
│  │
│  ├─ channels/
│  │  ├─ envelope.ts            ← Channel interface, Inbound/Outbound types  (from swimbot)
│  │  ├─ baileys.ts             ← WhatsApp Web channel                        (from swimbot)
│  │  ├─ index.ts               ← ChannelRouter                               (from swimbot)
│  │  └─ middleware/debounce.ts ← collapse message bursts                     (from swimbot)
│  │
│  ├─ agent/
│  │  ├─ loop.ts                ← prompt→LLM→tools→reply
│  │  ├─ prompt.ts              ← system prompt (Mate persona + rules)
│  │  ├─ provider.ts            ← OpenAI-compatible chat client (Qwen)        (from swimbot)
│  │  ├─ tools.ts               ← ToolRegistry: forUser / forGuest
│  │  ├─ guardrails.ts          ← egress scrub + act-never-pretend
│  │  └─ types.ts               ← Message / ToolCall / ToolResult shapes
│  │
│  ├─ susumate/
│  │  ├─ client.ts              ← HTTP client (calls the SusuMate API as the user)
│  │  ├─ catalog.ts             ← endpoint catalog (the action allowlist)
│  │  ├─ auth.ts                ← OTP login flow (request-otp / verify-otp)
│  │  └─ media.ts               ← upload user images (campaign covers, avatars)
│  │
│  ├─ sessions/
│  │  ├─ store.ts               ← per-phone: token + conversation history
│  │  └─ tokens.ts              ← encrypted-at-rest token vault
│  │
│  └─ runtime/
│     ├─ logger.ts
│     └─ http.ts                ← tiny HTTP server (health, future webhooks)
├─ sessions/                    ← runtime state (gitignored)
│  ├─ wa/                       ← Baileys creds
│  └─ store.json                ← sessions/tokens (or SQLite)
└─ logs/
```

Files marked *(from swimbot)* are lifted from `/home/azureuser/swimbot/src/...` with minimal
changes — that's the WhatsApp implementation you asked us to reuse.

---

## 6. Component detail

### 6.1 WhatsApp channel (Baileys) — from swimbot
- Copy `swimbot/src/channels/{envelope,baileys,index}.ts` and `middleware/debounce.ts`.
- QR pairing: on first run it prints a QR (and writes `sessions/wa/pair-qr.png`); scan it
  with the SusuMate WhatsApp number. Creds persist in `sessions/wa/` and auto-reconnect.
- Normalizes inbound to `{ channel, from (phone), text, media[] }`; egress chunks long
  replies (WhatsApp ~4k cap) and can send media.
- The `Channel` interface means we can later register `WhatsAppCloudChannel` instead
  without touching the agent loop.

### 6.2 Gateway — adapted from swimbot
- One handler per inbound message: resolve the sender's session by phone → debounce burst
  → run the agent loop → scrub → chunk → send.
- Debounce (swimbot's `Debouncer`) collapses the "3 messages in a row" pattern into one turn.

### 6.3 Agent loop
- Build system prompt + tool definitions (for user vs guest) → call Qwen → if tool calls,
  execute each via the SusuMate client, append results, loop (bounded by `MAX_TURNS`) →
  else return text.
- Behaviors: logout intent clears the session; daily quota guard;
  `confirm=false` preview then `confirm=true` execute for money/destructive actions.

### 6.4 SusuMate API client
```ts
// src/susumate/client.ts  (shape)
async call(token: string, method: string, uri: string, data?, files?): Promise<{
  status: number; ok: boolean; data: any; message?: string;
  errors?: Record<string,string[]>; error_code?: string;
}>
```
- `GET`/`DELETE` → querystring; `POST`/`PUT` → JSON (or `multipart/form-data` when `files`).
- Always `Authorization: Bearer <token>`, `Accept: application/json`.
- Returns SusuMate's own `{data, message, errors, error_code}` envelope unchanged so the
  agent can relay real validation messages. Never throws on 4xx — returns `ok:false`.

### 6.5 Endpoint catalog
Same entries and flags. Covers: profile/account, groups (+ public campaigns), members,
contributions, payouts, wallet + top-ups, transfers (GH/NG), chat/conversations,
notifications. Flags drive behavior:
- `sensitive` → hidden in group chats (private DM only).
- `confirm` → money/destructive: preview first, then re-call with `confirm=true`.
- `group_safe` → allowed when Mate is @mentioned in a group.

### 6.6 Auth (per-user OTP) — `src/susumate/auth.ts`
Verified against SusuMate routes:
1. Unknown WhatsApp number messages Mate → guest tools only (explain / browse public
   groups / begin login).
2. User gives their SusuMate phone → `POST /api/auth/request-otp { phone }`.
3. User relays the 6-digit code → `POST /api/auth/verify-otp { phone, code, device_name:"whatsapp" }`
   → response `{ data: { token, is_new_user, user } }`.
4. Store `token` in the token vault keyed by WhatsApp phone. All later calls use it.
5. `logout` / token 401 → clear token, drop back to guest.

Phone normalization mirrors SusuMate: local `0…` → `+233…`, bare `233…` → `+233…`, keep `+`.

### 6.7 Guardrails
- **Egress scrub:** strip internal tool names, UUIDs, and token-shaped strings before any
  text reaches the user.
- **Act-never-pretend:** if the reply claims a completed money/write action but no write
  tool returned `ok:true` this turn, replace the claim with a truthful nudge.

### 6.8 Sessions & token vault
- Per WhatsApp phone: `{ token?, history[], quotaCount, lastSeen }`.
- Start with a JSON file (`sessions/store.json`); move to SQLite if concurrency grows.
- **Tokens are secrets** — encrypt at rest with a key from `.env` (`SESSION_ENC_KEY`).
  Never log tokens; scrub covers accidental echoes.

---

## 7. Configuration (`.env.example`)

```env
# ── SusuMate API ────────────────────────────────────────────────
SUSUMATE_API_URL=https://<susumate-host>/api      # e.g. http://127.0.0.1:8000/api locally
SUSUMATE_API_TIMEOUT_MS=30000

# ── LLM (Qwen Cloud / DashScope, OpenAI-compatible) ─────────────
DASHSCOPE_BASE_URL=https://dashscope-intl.aliyuncs.com/compatible-mode/v1
DASHSCOPE_API_KEY=
AGENT_MODEL_PRIMARY=qwen/qwen-max
AGENT_MODEL_FALLBACKS=qwen/qwen-plus

# ── WhatsApp (Baileys) ──────────────────────────────────────────
WA_STATE_DIR=./sessions/wa
WA_PRINT_QR=true
WA_PAIR_NUMBER=                    # optional: pair by code instead of QR (intl, digits only)

# ── Agent behavior ──────────────────────────────────────────────
AGENT_MAX_TURNS=6
AGENT_DAILY_QUOTA=40               # messages per user per day
SESSION_STORE=./sessions/store.json
SESSION_ENC_KEY=                   # 32-byte base64; encrypts stored user tokens

# ── Runtime ─────────────────────────────────────────────────────
HTTP_PORT=8787                     # health check / future webhooks
LOG_LEVEL=info
```

No SusuMate secrets live here — only the API base URL. The agent authenticates as each
user with their own OTP-issued token.

---

## 8. Build phases

- [x] **P0 — Scaffold.** `package.json`, `tsconfig`, `.gitignore`, `.env.example`, dir
      skeleton, `bin/agent.sh`. Deps: `baileys`, `openai`, `dotenv`, `qrcode`,
      `qrcode-terminal` (native `fetch` for HTTP), dev: `typescript`, `tsx`, `@types/node`.
- [x] **P1 — WhatsApp channel.** Ported swimbot `channels/*`; gateway wires inbound →
      debounce → Mate → chunked reply. Boots to QR pairing; groups answered only on @mention.
- [x] **P2 — LLM loop on Qwen.** `loop.ts` + `provider.ts` + `model.ts`; Mate persona in
      `IDENTITY.md`/`prompt.ts`; sessions + capped history + silent model fallback.
- [x] **P3 — Auth flow.** `susumate/auth.ts`; guest → `begin_login` → `complete_login` →
      encrypted token stored; 401 auto-signs-out for re-auth.
- [x] **P4 — Catalog + client + tools.** `catalog.ts` (full port), HTTP `client.ts`
      (replaces the in-process dispatcher), `tools.ts` with the `confirm` preview/execute
      handshake and path-param/body/file mapping.
- [x] **P5 — Guardrails + media.** Egress scrub + act-never-pretend (`guardrails.ts`);
      image upload for campaign covers/avatars via public URL or WhatsApp `attached` photo.
- [x] **P6 — Hardening.** AES-256-GCM token encryption, per-user daily quotas, faithful
      error relay, timeouts, file logging, `bin/agent.sh` process management.

**Not yet done (needs a live number / manual step):** scan the QR with the SusuMate WhatsApp
number, run one real OTP login + a read action end to end, then a guarded write. Optional:
voice-note transcription; WhatsApp Cloud API adapter for production.

---

## 9. Security & safety notes

- The agent holds **user bearer tokens** — treat the token vault as a secret store
  (encrypted at rest, never logged, scrubbed from egress).
- All authorization stays server-side in SusuMate; the agent never decides who may do what.
- Money/destructive actions always use the two-step `confirm` handshake so the user
  explicitly approves amounts and fees before anything moves.
- Baileys is an unofficial WhatsApp client — fine for the hackathon/demo; plan the
  WhatsApp Cloud API swap (already interface-compatible) for production.
- Rate-limit inbound per phone and honor SusuMate's 429s (its routes are throttled).

---

## 10. Reference

- **SusuMate API** — the public HTTP API this agent consumes: `https://susumate.app/api`
  (`/auth`, `/groups`, `/contributions`, `/payouts`, `/wallet`, `/transfers`, `/conversations`,
  `/notifications`). Every agent action is a real, authenticated call to this API.
- This repo's runtime: `src/` (`channels/`, `agent/`, `susumate/`, `sessions/`, `runtime/`,
  `gateway.ts`, `config.ts`).
