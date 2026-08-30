import Fastify from "fastify";
import cookie from "@fastify/cookie";
import { ZodError } from "zod";
import { getDb, type Db } from "@naka/db";
import { createRazorpayClient, webhookSecrets, RecordedRazorpayClient } from "@naka/razorpay";
import { loadPolicy, releaseExpiredReservations, merchantDisplayName } from "@naka/engine";
import { registerToolRoutes } from "./mcp/tools.js";
import { registerCheckoutSessionRoutes } from "./rest/checkout-sessions.js";
import { registerWebhookRoutes } from "./webhooks/route.js";
import { verifyAndApplyWebhook } from "./webhooks/apply.js";
import { registerPayRoutes } from "./web/pay.js";
import { registerConsoleRoutes } from "./web/console.js";
import { registerOnboardRoutes } from "./web/onboard.js";
import { registerLandingRoutes } from "./web/landing.js";
import { startReconcileLoop } from "./reconcile/poller.js";
import { env } from "./config/env.js";
import { Tenants } from "./tenants.js";
import { TelegramHost } from "./channels/telegram-host.js";

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
  registerCheckoutSessionRoutes(app, db);
  await registerWebhookRoutes(app, db, tenants);
  registerPayRoutes(app, db, tenants);
  const telegram = new TelegramHost(db, `http://127.0.0.1:${env.port}`);
  registerConsoleRoutes(app, db, tenants, telegram);
  registerOnboardRoutes(app, db);
  registerLandingRoutes(app, db);

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

function manifest(db: Db, merchantId: string) {
  return {
    name: "naka",
    merchant: { id: merchantId, display_name: merchantDisplayName(db, merchantId) },
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
