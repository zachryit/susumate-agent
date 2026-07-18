# WhatsApp Cloud API setup (Meta)

How to run the agent on the **official WhatsApp Cloud API** (the transport used for the
hackathon). The agent exposes a webhook that Meta calls for inbound messages, and sends replies
through the Graph API. Baileys (QR) is an alternative for local dev — see the README.

## 0. What you need from Meta

Create a Meta app with the **WhatsApp** product, add/verify a business phone number, then note:

| Value | Where | Env var |
|---|---|---|
| **Access token** (System User, permanent) | Business Settings → System users, or App → WhatsApp → API Setup | `WHATSAPP_CLOUD_TOKEN` |
| **Phone number ID** | App → WhatsApp → API Setup (under the number) | `WHATSAPP_CLOUD_PHONE_NUMBER_ID` |
| **WhatsApp Business Account (WABA) ID** | API Setup, or WhatsApp Manager → Account tools → Overview | (used once, to subscribe the app) |
| **App Secret** (optional) | App → Settings → Basic | `WHATSAPP_CLOUD_APP_SECRET` |
| **Verify token** (you choose it) | — generate: `openssl rand -hex 16` | `WHATSAPP_CLOUD_VERIFY_TOKEN` |

The token needs the `whatsapp_business_messaging` and `whatsapp_business_management` scopes.

## 1. Configure the agent

In `.env`:

```env
WA_CHANNEL=cloud                       # or "both" to also run Baileys
WHATSAPP_CLOUD_TOKEN=<system-user-token>
WHATSAPP_CLOUD_PHONE_NUMBER_ID=<phone-number-id>
WHATSAPP_CLOUD_VERIFY_TOKEN=<random-string-you-generated>
WHATSAPP_CLOUD_APP_SECRET=<app-secret>          # optional; enables request-signature checks
WHATSAPP_CLOUD_GRAPH_VERSION=v21.0
WHATSAPP_CLOUD_WEBHOOK_PATH=/wa-cloud-webhook
```

Start it: `npm run gateway:start`. The log shows
`[whatsapp_cloud] webhook on /wa-cloud-webhook (phone_number_id …)` and
`curl localhost:8787/health` lists `whatsapp_cloud` in `channels`.

The agent serves the webhook on its HTTP port (`HTTP_PORT`, default `8787`):
- `GET  <webhook>` — Meta verification handshake (echoes `hub.challenge` when the verify token matches)
- `POST <webhook>` — inbound messages

## 2. Expose the webhook publicly (nginx)

Meta needs a public HTTPS URL; the agent listens on `localhost:8787`. Add an **exact-match**
location to the site that serves your domain, proxying just the webhook path to the agent. On
this deployment the domain is `susumate.app` (nginx site file
`/etc/nginx/sites-available/susu.ownaradio.com`, the `443` server block):

```nginx
# SusuMate WhatsApp agent — Meta Cloud API webhook -> agent on 127.0.0.1:8787
location = /wa-cloud-webhook {
    proxy_pass http://127.0.0.1:8787/wa-cloud-webhook;
    proxy_set_header Host $host;
    proxy_set_header X-Real-IP $remote_addr;
    proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
    proxy_set_header X-Forwarded-Proto $scheme;
}
```

Then validate and reload (never reload without `-t` passing first):

```bash
sudo nginx -t && sudo systemctl reload nginx
```

Public callback URL becomes: `https://susumate.app/wa-cloud-webhook`

Smoke-test the handshake (should echo the challenge):

```bash
curl "https://susumate.app/wa-cloud-webhook?hub.mode=subscribe&hub.verify_token=<VERIFY_TOKEN>&hub.challenge=OK123"
# -> OK123
```

## 3. Point Meta at the webhook

App → **WhatsApp → Configuration** (the `wa-configurations-v2` page):

1. **Callback URL:** `https://susumate.app/wa-cloud-webhook`
2. **Verify token:** the value in `WHATSAPP_CLOUD_VERIFY_TOKEN`
3. Click **Verify and save**.
4. **Webhook fields → Manage → subscribe `messages`.**

## 4. Register the phone number (one-time)

Cloud API numbers must be registered with a 6-digit two-step-verification PIN:

```bash
curl -X POST "https://graph.facebook.com/v21.0/<PHONE_NUMBER_ID>/register" \
  -H "Authorization: Bearer <TOKEN>" -H "Content-Type: application/json" \
  -d '{"messaging_product":"whatsapp","pin":"<6-digit-pin>"}'
# -> {"success":true}
```

Change the PIN later with:

```bash
curl -X POST "https://graph.facebook.com/v21.0/<PHONE_NUMBER_ID>" \
  -H "Authorization: Bearer <TOKEN>" --data-urlencode "pin=<new-6-digit-pin>"
```

## 5. Subscribe the app to your WABA (the step everyone misses)

Subscribing the `messages` **field** (step 3.4) is **not** enough — the **app must also be
subscribed to the WABA**, or Meta never POSTs your inbound messages (you'll see `GET 200`
verifications but zero `POST`s). Do it once:

```bash
curl -X POST "https://graph.facebook.com/v21.0/<WABA_ID>/subscribed_apps" \
  -H "Authorization: Bearer <TOKEN>"
# -> {"success":true}

# confirm:
curl "https://graph.facebook.com/v21.0/<WABA_ID>/subscribed_apps?access_token=<TOKEN>"
```

(Equivalent to flipping the **"Subscribe webhooks"** toggle next to the WABA on the Production
setup page.)

## 6. Verify end-to-end

Message your WhatsApp Business number, then watch:

```bash
# Meta delivering inbound (should show POST /wa-cloud-webhook):
sudo grep "POST /wa-cloud-webhook" /var/log/nginx/access.log | tail
# Mate handled it (a whatsapp_cloud session appears):
cat sessions/store.json | grep -o 'whatsapp_cloud[^"]*'
```

To publish beyond testers, **publish the app** (App dashboard) so any number can message it.

## Troubleshooting

| Symptom | Cause / fix |
|---|---|
| Meta "Callback URL couldn't be validated" | nginx proxy missing or agent not running; test `curl localhost:8787/wa-cloud-webhook?...` then the public URL |
| Verification `GET 200` but **no `POST`s** ever | App not subscribed to the WABA → run step 5 |
| Replies stall / connection flaps (`440`) | Two gateway instances (Baileys) sharing one link → `npm run gateway:restart` (only one instance allowed) |
| Sending fails, `graph 4xx` | `WHATSAPP_CLOUD_PHONE_NUMBER_ID` missing/wrong, or number not registered (step 4) |
| Only admins/testers get replies | App is unpublished → publish it |

## Notes

- Free-form text replies are allowed within 24h of a user's message (customer-service window);
  outside it, Meta requires an approved template.
- Keep the token secret (it lives only in `.env`, which is git-ignored). Rotate it if exposed.
