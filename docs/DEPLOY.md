# Deploying Naka

Naka is one Node process with one SQLite file. Deploying it means: build the
`Dockerfile` at the repository root, mount a persistent volume at `/data`,
set a handful of environment variables, and point Razorpay's webhook at the
public URL. Every onboarded merchant lives inside that one process.

The one hard requirement is the **persistent volume**. Without it the
SQLite file, every merchant, checkout and ledger row, is lost on each
deploy. Railway and Fly provide volumes on their cheap tiers; Render only on
paid plans.

## Environment variables

| Variable | Required | Notes |
|---|---|---|
| `NAKA_DB` | yes | `/data/naka.db` (already set in the image and configs) |
| `PORT` | set by platform | the image listens on it; `NAKA_PORT` overrides locally only |
| `NAKA_BASE_URL` | yes | the public `https://` URL. Used in every pay link and onboarding kit. Set it after the platform assigns a domain, then redeploy once |
| `RAZORPAY_MODE` | yes | `real` for the default merchant to use the keys below; `recorded` to simulate payments |
| `RAZORPAY_KEY_ID`, `RAZORPAY_KEY_SECRET` | if `real` | **test-mode keys only** (`rzp_test_…`); the server refuses anything else |
| `RZP_WEBHOOK_SECRET` | if `real` | the secret you set on the Razorpay webhook for the default merchant |
| `CONSOLE_PASSWORD` | yes | console login for the default merchant (onboarded merchants choose their own) |
| `LEDGER_SALT` | yes | any long random string; used to hash PII in the ledger |
| `TELEGRAM_BOT_TOKEN`, `TELEGRAM_MERCHANT_CHAT_ID` | optional | escalation notices to Telegram |
| `NAKA_MERCHANT_ID` | optional | default tenant id if it should differ from the catalog file's |

Onboarded merchants bring their own Razorpay keys and webhook secret
through `/onboard`; those are stored on their row, not in env.

## Railway (recommended: volumes on the Hobby plan)

1. Push this repository to GitHub (see the pre-push checklist below).
2. Railway → New Project → Deploy from GitHub repo. It detects the
   `Dockerfile` at the root.
3. Service → Volumes → Add volume, mount path `/data`.
4. Service → Variables: add the table above. Leave `NAKA_BASE_URL` for step 6.
5. Service → Settings → Networking → Generate domain.
6. Set `NAKA_BASE_URL=https://<that domain>` and redeploy.
7. Open `https://<domain>/health` → `{"ok":true,"mode":"real"}`, then
   `/console` (default merchant, `CONSOLE_PASSWORD`) and `/onboard`.

## Fly.io

```sh
fly launch --copy-config --no-deploy      # uses fly.toml; pick an app name
fly volumes create naka_data --size 1 --region sin
fly secrets set RAZORPAY_KEY_ID=rzp_test_... RAZORPAY_KEY_SECRET=... RZP_WEBHOOK_SECRET=... \
  CONSOLE_PASSWORD=... LEDGER_SALT=$(openssl rand -hex 24) NAKA_BASE_URL=https://<app>.fly.dev
fly deploy
```

## Render

`render.yaml` is a Blueprint: New → Blueprint → select the repo. Add the
`sync: false` variables in the dashboard. The disk requires a paid plan.

## After the first boot

- The server seeds the demo merchant from `data/catalog.json` on an
  empty database, so `/console` works immediately.
- **Razorpay webhook (default merchant):** Dashboard → Settings → Webhooks →
  Add: URL `https://<domain>/webhooks/razorpay`, secret =
  `RZP_WEBHOOK_SECRET`, events `payment.authorized`, `payment.captured`,
  `payment.failed`, `order.paid`, `payment_link.*`, `refund.processed`,
  `refund.failed`. Onboarded merchants get their own URL
  (`/webhooks/razorpay/<merchant id>`) and secret in their kit.
- Without a webhook the reconciler still confirms payments by polling
  every 30 s; the webhook just makes it instant.

## Connecting buyers to the deployed shop

- **Claude Code / Claude Desktop:** the MCP server runs on your machine and
  talks to the deployed URL. In the console, *Agents → Mint a buyer agent*
  gives you a key and a ready `.mcp.json` block (onboarded merchants get
  the same in their kit). Set `NAKA_URL` to the deployed URL.
- **Telegram bots:** nothing to run separately. Each merchant pastes its
  BotFather token in Console → Channels and the server hosts the bot;
  bots resume on every boot. Set at least one LLM key on the server
  (`OPENROUTER_API_KEY`, `GEMINI_API_KEY` or `OPENAI_API_KEY`), the
  platform pays for the model. If `TELEGRAM_BOT_TOKEN` is set in the
  environment, the default merchant adopts it on first boot. The
  standalone `pnpm telegram:bot` is only for running a bot by hand against
  a token the server is *not* hosting.

## Pre-push checklist

`.gitignore` now excludes `.env`, `*.db`, `data/agents/`,
`data/seed-output.json` and their per-database variants. Before the first
push, confirm with `git status` that no `.pem`, `.db` or `.env` file is
staged. If any secret was ever committed, rotate it: Razorpay keys from the
dashboard, the Telegram token from @BotFather.
