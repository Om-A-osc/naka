# Naka

A merchant-side storefront for AI buyer agents, built for the Razorpay AI
Buildathon (Track 01: AI Growth & Agentic Commerce). Every money action
passes a deterministic policy gate, executes exactly once on Razorpay
test-mode Orders after a server-verified human confirmation, is confirmed
only by verified webhooks or reconciliation, and lands in a hash-chained,
append-only ledger.

## Quickstart (no API keys needed)

```bash
pnpm install
pnpm demo:replay
```

That single command wipes any previous demo database, seeds a fictional
filter-coffee roaster (12 products, 16 variants, Hinglish aliases), boots
the whole server in-process against a deterministic recorded Razorpay
client (no network calls, no keys), and runs an LLM-free scripted buyer
through:

- **S1**, an in-limit purchase, a bounded add-on offered and declined, a
  real (recorded) test-mode order created only after a server-verified
  human confirmation, and payment success via webhook.
- **S2**, a purchase above the merchant's auto-approve threshold,
  escalated, approved from the merchant console, then paid.
- **Bounds checks**, an over-mandate cart, an off-category item, an
  expired mandate, a suspended agent, and an out-of-stock item, each
  correctly `DENY`ed with the exact rule that fired.
- **S3, the engineered failure**, two agents racing for the last unit of
  a variant (one wins, one is denied), a real payment failure, a truthful
  "order created, not paid, nothing charged" message, a retry that opens a
  **new** Razorpay order (never reuses a failed one), a simulated 90-second
  webhook outage, and the reconciler independently confirming the same
  payment and completing the checkout, exactly once.

It ends by verifying the entire hash-chained ledger and prints pass/fail
for every assertion.

## Run the tests

```bash
pnpm test          # gate rule unit tests (one per rule id) + a full HTTP integration test
```

## Run the long-lived server (for a real MCP client, or `RAZORPAY_MODE=real`)

```bash
pnpm cli seed       # one-time: import the catalog, register agents, issue mandates
pnpm server         # boots on NAKA_PORT (default 3000)
```

Then point any HTTP client at `POST http://localhost:3000/tools/<tool_name>`
(unsigned for `search_catalog`/`get_product`, Ed25519-signed for the rest,
see `apps/buyer/src/mcp-client.ts` for the exact signing scheme), or open
`http://localhost:3000/console` (password from `CONSOLE_PASSWORD` in
`.env`, default `change-me`).

## Onboard a merchant (any shop, not just the demo roaster)

With the server running, open **`/onboard`**. Three inputs, a shop name, a
console password, and a catalog JSON (a shoe-shop template is prefilled;
the schema is the same one `naka catalog:import` takes), plus optional
Razorpay **test** keys and two policy numbers. One click creates the tenant
end to end and shows a connection kit:

- the merchant's console login (`/console`, merchant id + password),
- the webhook URL and secret to paste into the Razorpay dashboard
  (`/webhooks/razorpay/<merchant id>`),
- a registered buyer agent's private key and mandate, shown once and never
  stored, and the `.mcp.json` snippet that lets an MCP client shop there.

Merchants are isolated: catalog, checkouts, policy (including the kill
switch), console and webhook secret are all per merchant, and a checkout
naming another shop's variant is refused. The merchant seeded from
`data/catalog.json` keeps working exactly as before and uses the `.env`
credentials. Merchants without Razorpay keys run in recorded mode
(simulated payments), so a demo tenant needs no Razorpay account.

Inside the console, **Catalog → Download / Upload** lets a merchant edit
their catalog as a file and put it back; an upload deactivates anything no
longer listed (never deletes, ledger rows and old checkouts still point at
it).

**Give the shop a Telegram bot, self-serve:** Console → Channels → paste the
token from `@BotFather` (`/newbot`, pick a name and a username ending in
`bot`). Naka validates it, mints a buyer agent for the bot, and runs the
bot inside the server, the merchant shares `t.me/<username>` and that's
it. Send the bot `/alerts` from your own Telegram to receive approval
requests there. The server needs an LLM key (`OPENROUTER_API_KEY`,
`GEMINI_API_KEY` or `OPENAI_API_KEY`); the platform pays for the model.
`pnpm telegram:bot` still exists for running a bot by hand, but do not run
it with a token the server is already hosting, Telegram allows one poller
per bot.

## Connect Claude Code (a real MCP server)

`apps/buyer/src/mcp-server.ts` is a stdio MCP server: it holds one agent's
Ed25519 key, turns every `tools/call` into a signed request to Naka, and
hands the merchant's conversational rules to the client as server
instructions. Nothing on the merchant side is relaxed, same gate, same
nonce-confirmed pay page, same ledger.

The repo root already has a `.mcp.json` for the demo roaster; open Claude
Code in the repo root with the server running and ask it to buy coffee.
For an onboarded merchant, paste the kit's snippet instead (it sets
`NAKA_MERCHANT`, the agent id, the mandate id and the key path). To try it
by hand:

```sh
pnpm mcp   # speaks MCP over stdio; logs go to stderr
```

## Deploy it

One container, one SQLite file on a volume. The `Dockerfile`, `render.yaml`
and `fly.toml` are at the repository root; the step-by-step for Railway,
Fly and Render, the environment variables, and how to connect Claude Code
and the Telegram bot to a hosted shop are in [docs/DEPLOY.md](docs/DEPLOY.md).
A fresh deploy seeds the demo merchant on first boot, so `/console` and
`/onboard` work immediately.

## Run the Claude-powered buyer

```bash
# requires ANTHROPIC_API_KEY in .env
pnpm demo:live
```

## Where things live

```
apps/server     Fastify server: signed tool routes, pay page, webhooks, reconciler, console, onboarding
apps/buyer      buyer agents: replay (no LLM), Claude/OpenAI/Gemini buyers, Telegram bot CLI, MCP server
packages/       catalog · channels · db · engine · executor · gate · identity · ledger · mandate · razorpay · shared
cli/            naka CLI (seed, catalog, agents, ledger, merchant decisions)
data/           catalog.json and policy.json for the demo merchant
tests/          end-to-end and isolation tests (vitest)
docs/           DEPLOY.md
```
