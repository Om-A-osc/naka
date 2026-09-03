import Fastify from "fastify";
import cookie from "@fastify/cookie";
import { ZodError } from "zod";
import { getDb, type Db } from "@naka/db";
import { createRazorpayClient, webhookSecrets, RecordedRazorpayClient } from "@naka/razorpay";
import { loadPolicy, releaseExpiredReservations, merchantDisplayName } from "@naka/engine";
import { registerToolRoutes } from "./mcp/tools.js";
import { registerRemoteMcpRoutes } from "./mcp/remote.js";
import { registerCheckoutSessionRoutes } from "./rest/checkout-sessions.js";
import { registerWebhookRoutes } from "./webhooks/route.js";
import { verifyAndApplyWebhook } from "./webhooks/apply.js";
import { registerPayRoutes } from "./web/pay.js";
import { registerConsoleRoutes } from "./web/console.js";
import { registerOnboardRoutes } from "./web/onboard.js";
import { registerLandingRoutes } from "./web/landing.js";
import { registerShopRoutes } from "./web/shop.js";
import { startReconcileLoop } from "./reconcile/poller.js";
import { env } from "./config/env.js";
import { Tenants } from "./tenants.js";
import { TelegramHost } from "./channels/telegram-host.js";
import { BASE_CSS, nav } from "./web/ui.js";

export async function buildServer() {
  const db = getDb();
  loadPolicy();

  const secrets = webhookSecrets();
  const rzp = createRazorpayClient((rawBody, headers) => {
    // Recorded mode: deliver the simulated webhook straight into the same verify+apply path the real HTTP route uses.
    verifyAndApplyWebhook(db, secrets, rawBody, { signature: headers["x-razorpay-signature"], eventId: headers["x-razorpay-event-id"] });
  });

  const app = Fastify({ logger: { level: process.env.LOG_LEVEL ?? "info", redact: ["req.headers.authorization", "req.headers[\"x-naka-sig\"]"] } });
  await app.register(cookie);

  // A tool argument that fails schema validation is the caller's mistake, not ours.
  app.setNotFoundHandler((req, reply) => {
    const wantsHtml = (req.headers.accept ?? "").includes("text/html");
    if (!wantsHtml) return reply.code(404).send({ error: { code: "NOT_FOUND", message: `Route ${req.method}:${req.url} not found` } });
    return reply.code(404).type("text/html").send(notFoundPage());
  });

  app.setErrorHandler((err: any, _req, reply) => {
    if (err instanceof ZodError) {
      const detail = err.issues.map((i) => `${i.path.join(".") || "(root)"}: ${i.message}`).join("; ");
      return reply.code(400).send({ error: { code: "INVALID_ARGUMENT", message: detail } });
    }
    reply.log.error(err);
    const status = typeof err?.statusCode === "number" && err.statusCode >= 400 ? err.statusCode : 500;
    return reply.code(status).send({ error: { code: status === 500 ? "INTERNAL" : "ERROR", message: err?.message ?? "error" } });
  });

  const tenants = new Tenants(db, { merchantId: env.merchantId, rzp, secrets, keyId: env.keyId, keySecret: env.keySecret });

  registerToolRoutes(app, db);
  registerRemoteMcpRoutes(app, db);
  registerCheckoutSessionRoutes(app, db);
  await registerWebhookRoutes(app, db, tenants);
  registerPayRoutes(app, db, tenants);
  const telegram = new TelegramHost(db, `http://127.0.0.1:${env.port}`);
  registerConsoleRoutes(app, db, tenants, telegram);
  registerOnboardRoutes(app, db);
  registerLandingRoutes(app, db);
  registerShopRoutes(app, db);

  app.get("/health", async () => ({ ok: true, mode: rzp.mode }));
  app.get("/.well-known/naka.json", async (req) => manifest(db, ((req.query as any)?.merchant as string | undefined) || env.merchantId));

  // Keeps browsing honest between checkouts: reserveStock already reclaims lapsed holds inside its own transaction, so allocation is correct regardless.
  const reservationSweepTimer = setInterval(() => {
    try {
      const n = releaseExpiredReservations(db);
      if (n > 0) app.log.info({ released: n }, "released expired stock reservations");
    } catch (err) {
      app.log.error(err, "reservation sweep failed");
    }
  }, 60_000);
  reservationSweepTimer.unref();

  // Always on: each attempt is polled with its own merchant's client, and recorded-mode clients are skipped inside.
  const reconcileTimer: NodeJS.Timeout | undefined = startReconcileLoop(db, (m) => tenants.rzpFor(m), 30_000);

  return {
    app,
    db,
    rzp,
    isRecorded: rzp instanceof RecordedRazorpayClient,
    telegram,
    async close() {
      await telegram.stopAll();
      if (reconcileTimer) clearInterval(reconcileTimer);
      clearInterval(reservationSweepTimer);
      await app.close();
    },
  };
}

function notFoundPage(): string {
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Not found, Naka</title>
<style>${BASE_CSS}body{margin:0;font-family:system-ui,sans-serif;background:var(--bg);color:var(--ink)}.wrap{max-width:560px;margin:80px auto;padding:0 20px;text-align:center;animation:nk-fade-up .5s}h1{font-size:4em;margin:0;letter-spacing:-.04em;background:linear-gradient(120deg,var(--accent),var(--accent2));-webkit-background-clip:text;background-clip:text;color:transparent}p{color:var(--muted)}a.b{display:inline-block;margin:6px;padding:9px 14px;border-radius:8px;background:var(--accent);color:#fff;text-decoration:none;font-weight:600}a.g{background:#fff;color:var(--accent);border:1px solid var(--accent)}</style></head>
<body>${nav("")}<div class="wrap"><h1>404</h1><p>There is nothing at this address. The shop, the console and onboarding are all one click away.</p><a class="b" href="/">Home</a><a class="b g" href="/shop">Demo shop</a><a class="b g" href="/console">Console</a></div></body></html>`;
}

function manifest(db: Db, merchantId: string) {
  const base = env.baseUrl.replace(/\/$/, "");
  const tg = db.prepare("SELECT telegram_bot_username FROM merchants WHERE id = ?").get(merchantId) as { telegram_bot_username: string | null } | undefined;
  return {
    name: "naka",
    merchant: { id: merchantId, display_name: merchantDisplayName(db, merchantId) },
    storefront_url: `${base}/shop/${merchantId}`,
    channels: { telegram: tg?.telegram_bot_username ? `https://t.me/${tg.telegram_bot_username}` : null },
    description: "Merchant-side storefront for AI buyer agents (UCP-shaped, non-conformant).",
    tools: [
      "search_catalog", "get_product", "create_checkout", "get_checkout",
      "update_checkout", "suggest_addons", "complete_checkout", "cancel_checkout",
    ],
    bindings: {
      mcp_shaped_http: "POST /tools/{tool_name}",
      rest: {
        checkout_sessions: "POST /checkout-sessions, GET/PUT /checkout-sessions/{id}, POST /checkout-sessions/{id}/complete|cancel",
        headers: ["Idempotency-Key (optional; 409 on reuse with a different body)", "Request-Id (accepted, echoed in logs, not required)"],
      },
    },
    status_enum: ["incomplete", "requires_escalation", "ready_for_complete", "complete_in_progress", "completed", "canceled"],
    payment_handler: "razorpay_orders",
    signing: "ed25519 over agent_id:tool|ts|nonce|sha256(canonical_body); headers x-naka-agent/x-naka-ts/x-naka-nonce/x-naka-sig",
  };
}

// This module is a pure library: it exports buildServer and nothing else runs on import.
export { env };
