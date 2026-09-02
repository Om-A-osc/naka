import type { FastifyInstance } from "fastify";
import type { Db } from "@naka/db";
import type { Tenants } from "../tenants.js";
import type { TelegramHost } from "../channels/telegram-host.js";
import { verifyLedger, exportLedgerArray, exportLedgerCsv } from "@naka/ledger";
import { requestRefund, approveRefund, denyRefund, policyForCheckout, setMerchantPolicy } from "@naka/engine";
import { executeRefund, ExecutorError } from "@naka/executor";
import { insertLedgerRow } from "@naka/ledger";
import { newId, sha256hex } from "@naka/shared";
import { timingSafeEqual } from "node:crypto";
import { env } from "../config/env.js";
import { setFault, clearFault, isFaultActive } from "../jobs/fault-flags.js";
import { importCatalog, exportCatalog } from "@naka/catalog";
import { merchantDisplayName, policyFor, merchantCredentials } from "@naka/engine";
import { mintBuyerAgent, mcpConfigFor } from "./onboard.js";
import { CatalogFileSchema } from "./catalog-schema.js";
import { BASE_CSS, nav } from "./ui.js";

/** Console sessions are per merchant. */
function passwordHashFor(db: Db, merchantId: string): string | null {
  if (merchantId === env.merchantId) return sha256hex(`${merchantId}:${env.consolePassword}`);
  const row = db.prepare("SELECT console_password_hash FROM merchants WHERE id = ?").get(merchantId) as { console_password_hash: string | null } | undefined;
  return row?.console_password_hash ?? null;
}
const cookieTokenFor = (passwordHash: string) => sha256hex(`cookie:${passwordHash}`);
function safeEq(a: string, b: string): boolean {
  const x = Buffer.from(a), y = Buffer.from(b);
  return x.length === y.length && timingSafeEqual(x, y);
}

export function registerConsoleRoutes(app: FastifyInstance, db: Db, tenants: Tenants, telegram: TelegramHost) {
  /** The merchant id this request's session belongs to, or null. */
  const checkAuth = (req: any): string | null => {
    const raw = req.cookies?.naka_console as string | undefined;
    if (!raw) return null;
    const dot = raw.lastIndexOf(".");
    if (dot < 1) return null;
    const merchantId = raw.slice(0, dot);
    const hash = passwordHashFor(db, merchantId);
    return hash && safeEq(raw.slice(dot + 1), cookieTokenFor(hash)) ? merchantId : null;
  };
  const refundOwner = (refundId: string): string | null => {
    const r = db.prepare("SELECT checkout_id FROM refunds WHERE id = ?").get(refundId) as { checkout_id: string } | undefined;
    return r ? tenants.merchantOfCheckout(r.checkout_id) : null;
  };
  const notFound = (reply: any) => reply.code(404).send({ error: { code: "NOT_FOUND" } });

  app.post("/console/login", async (req, reply) => {
    const { merchant_id, password } = (req.body ?? {}) as { merchant_id?: string; password?: string };
    const merchantId = (merchant_id ?? "").trim() || env.merchantId;
    const hash = passwordHashFor(db, merchantId);
    if (!hash || !safeEq(sha256hex(`${merchantId}:${password ?? ""}`), hash)) return reply.code(401).send({ error: { code: "BAD_PASSWORD" } });
    reply.setCookie("naka_console", `${merchantId}.${cookieTokenFor(hash)}`, { path: "/", httpOnly: true, sameSite: "lax" });
    return { ok: true, merchant_id: merchantId };
  });

  app.get("/console", async (req, reply) => {
    if (!checkAuth(req)) {
      return reply.type("text/html").send(loginPage());
    }
    return reply.type("text/html").send(dashboardPage());
  });

  // ---- Channels: a Telegram bot the merchant owns, hosted by Naka ---------
  app.get("/api/console/telegram", async (req, reply) => {
    const merchantId = checkAuth(req);
    if (!merchantId) return reply.code(401).send({ error: { code: "UNAUTHORIZED" } });
    return telegram.status(merchantId);
  });
  app.post("/api/console/telegram", async (req, reply) => {
    const merchantId = checkAuth(req);
    if (!merchantId) return reply.code(401).send({ error: { code: "UNAUTHORIZED" } });
    const { token } = (req.body ?? {}) as { token?: string };
    if (!token) return reply.code(400).send({ error: { code: "INVALID_ARGUMENT", message: "token is required" } });
    try {
      const r = await telegram.connect(merchantId, token);
      return { ok: true, ...r, status: telegram.status(merchantId) };
    } catch (err) {
      return reply.code(400).send({ error: { code: "BAD_TOKEN", message: (err as Error).message } });
    }
  });
  app.delete("/api/console/telegram", async (req, reply) => {
    const merchantId = checkAuth(req);
    if (!merchantId) return reply.code(401).send({ error: { code: "UNAUTHORIZED" } });
    await telegram.disconnect(merchantId);
    return { ok: true };
  });

  // ---- Settings: the policy numbers a merchant actually tunes ------------
  app.post("/api/console/policy", async (req, reply) => {
    const merchantId = checkAuth(req);
    if (!merchantId) return reply.code(401).send({ error: { code: "UNAUTHORIZED" } });
    const body = (req.body ?? {}) as Record<string, unknown>;
    const patch: Record<string, number> = {};
    for (const k of ["max_per_checkout_paise", "merchant_approval_over_paise", "per_agent_daily_cap_paise", "max_qty_per_line"]) {
      const v = body[k];
      if (v === undefined || v === null || v === "") continue;
      if (typeof v !== "number" || !Number.isInteger(v) || v <= 0) return reply.code(400).send({ error: { code: "INVALID_ARGUMENT", message: `${k} must be a positive integer` } });
      patch[k] = v;
    }
    const policy = setMerchantPolicy(db, merchantId, patch);
    insertLedgerRow(db, { actor: "merchant", action: "POLICY_UPDATED", inputs: { merchant_id: merchantId, ...patch } });
    return { ok: true, policy: { max_per_checkout_paise: policy.max_per_checkout_paise, merchant_approval_over_paise: policy.merchant_approval_over_paise, per_agent_daily_cap_paise: policy.per_agent_daily_cap_paise, max_qty_per_line: policy.max_qty_per_line, kill_switch: policy.kill_switch } };
  });

  // ---- Dashboard data -------------------------------------------------------
  app.get("/api/console/stats", async (req, reply) => {
    const merchantId = checkAuth(req);
    if (!merchantId) return reply.code(401).send({ error: { code: "UNAUTHORIZED" } });
    const one = (sql: string, ...args: unknown[]) => db.prepare(sql).get(...args) as any;
    const completed = one("SELECT COUNT(*) AS n, COALESCE(SUM(total_paise),0) AS paise FROM checkouts WHERE merchant_id = ? AND status = 'completed'", merchantId);
    const today = one("SELECT COUNT(*) AS n, COALESCE(SUM(total_paise),0) AS paise FROM checkouts WHERE merchant_id = ? AND status = 'completed' AND completed_at >= strftime('%Y-%m-%dT00:00:00Z','now')", merchantId);
    const byStatus = Object.fromEntries((db.prepare("SELECT status, COUNT(*) AS n FROM checkouts WHERE merchant_id = ? GROUP BY status").all(merchantId) as Array<{ status: string; n: number }>).map((r) => [r.status, r.n]));
    const payments = Object.fromEntries((db.prepare("SELECT p.status, COUNT(*) AS n FROM rzp_payments p JOIN checkouts c ON c.id = p.checkout_id WHERE c.merchant_id = ? GROUP BY p.status").all(merchantId) as Array<{ status: string; n: number }>).map((r) => [r.status, r.n]));
    const refundsPending = one("SELECT COUNT(*) AS n FROM refunds r JOIN checkouts c ON c.id = r.checkout_id WHERE c.merchant_id = ? AND r.status = 'requested'", merchantId).n;
    const agents = one("SELECT COUNT(*) AS n, SUM(CASE WHEN status = 'active' THEN 1 ELSE 0 END) AS active FROM agents WHERE merchant_id = ?", merchantId);
    const catalog = one("SELECT COUNT(DISTINCT p.id) AS products, COUNT(v.id) AS variants, SUM(CASE WHEN v.stock_qty - v.reserved_qty <= 3 THEN 1 ELSE 0 END) AS low_stock FROM products p JOIN variants v ON v.product_id = p.id WHERE p.merchant_id = ? AND p.active = 1 AND v.active = 1", merchantId);
    const { policy } = policyFor(db, merchantId);
    const creds = merchantCredentials(db, merchantId);
    const daily = db
      .prepare(
        `SELECT substr(completed_at, 1, 10) AS day, COUNT(*) AS orders, COALESCE(SUM(total_paise), 0) AS paise
         FROM checkouts WHERE merchant_id = ? AND status = 'completed' AND completed_at >= strftime('%Y-%m-%dT00:00:00Z','now','-13 days')
         GROUP BY day ORDER BY day`
      )
      .all(merchantId) as Array<{ day: string; orders: number; paise: number }>;
    const mode = merchantId === env.merchantId ? env.mode : creds?.razorpay_key_id ? "real" : "recorded";
    return {
      merchant: { id: merchantId, display_name: merchantDisplayName(db, merchantId), mode, webhook_url: `${env.baseUrl.replace(/\/$/, "")}/webhooks/razorpay${merchantId === env.merchantId ? "" : "/" + merchantId}` },
      revenue: { all_time_paise: completed.paise, today_paise: today.paise, orders_all_time: completed.n, orders_today: today.n },
      checkouts: byStatus,
      payments,
      refunds_pending: refundsPending,
      agents: { total: agents.n, active: agents.active ?? 0 },
      catalog,
      daily,
      telegram: telegram.status(merchantId),
      policy: { kill_switch: policy.kill_switch, max_per_checkout_paise: policy.max_per_checkout_paise, merchant_approval_over_paise: policy.merchant_approval_over_paise, per_agent_daily_cap_paise: policy.per_agent_daily_cap_paise, max_qty_per_line: policy.max_qty_per_line },
    };
  });

  app.get("/api/console/orders", async (req, reply) => {
    const merchantId = checkAuth(req);
    if (!merchantId) return reply.code(401).send({ error: { code: "UNAUTHORIZED" } });
    const rows = db
      .prepare(
        `SELECT c.id, c.agent_id, c.buyer_ref, c.status, c.total_paise, c.created_at, c.completed_at,
                (SELECT p.razorpay_payment_id FROM rzp_payments p WHERE p.checkout_id = c.id AND p.status = 'captured' LIMIT 1) AS payment_id,
                (SELECT group_concat(l.title || ' ×' || l.quantity, ', ') FROM checkout_lines l WHERE l.checkout_id = c.id) AS items
         FROM checkouts c WHERE c.merchant_id = ? ORDER BY c.created_at DESC LIMIT 30`
      )
      .all(merchantId);
    return { orders: rows };
  });

  /** Everything the console knows about one checkout, for the order drawer: lines, every decision with its rule hits, payment attempts, Razorpay payments. */
  app.get("/api/console/orders/:id", async (req, reply) => {
    const merchantId = checkAuth(req);
    if (!merchantId) return reply.code(401).send({ error: { code: "UNAUTHORIZED" } });
    const { id } = req.params as { id: string };
    if (tenants.merchantOfCheckout(id) !== merchantId) return notFound(reply);
    const checkout = db.prepare("SELECT id, status, buyer_ref, agent_id, mandate_id, subtotal_paise, discount_paise, total_paise, coupon_code, attempts, cancel_reason, created_at, completed_at FROM checkouts WHERE id = ?").get(id);
    if (!checkout) return notFound(reply);
    const lines = db.prepare("SELECT title, quantity, unit_price_paise, line_total_paise, is_addon FROM checkout_lines WHERE checkout_id = ?").all(id);
    const decisions = (db.prepare("SELECT action, outcome, rule_hits, explanation, created_at FROM decisions WHERE checkout_id = ? ORDER BY created_at").all(id) as any[]).map((d) => ({
      ...d,
      rule_hits: (() => { try { return JSON.parse(d.rule_hits ?? "[]"); } catch { return []; } })(),
    }));
    const attempts = db.prepare("SELECT attempt_no, kind, status, razorpay_order_id, plink_id, amount_paise, failure_category, opened_at, closed_at FROM payment_attempts WHERE checkout_id = ? ORDER BY attempt_no").all(id);
    const payments = db.prepare("SELECT razorpay_payment_id, razorpay_order_id, status, method, amount, error_description, created_at_rzp, source FROM rzp_payments WHERE checkout_id = ? ORDER BY created_at_rzp").all(id);
    const ledger = db.prepare("SELECT seq, ts, actor, action, decision, amount_paise, razorpay_order_id, razorpay_payment_id FROM ledger WHERE checkout_id = ? ORDER BY seq").all(id);
    return { checkout, lines, decisions, attempts, payments, ledger };
  });

  app.get("/api/console/agents", async (req, reply) => {
    const merchantId = checkAuth(req);
    if (!merchantId) return reply.code(401).send({ error: { code: "UNAUTHORIZED" } });
    const rows = db
      .prepare(
        `SELECT a.id, a.name, a.status, a.created_at,
                COUNT(c.id) AS checkouts,
                SUM(CASE WHEN c.status = 'completed' THEN 1 ELSE 0 END) AS completed,
                COALESCE(SUM(CASE WHEN c.status = 'completed' THEN c.total_paise END), 0) AS spent_paise,
                MAX(c.created_at) AS last_seen
         FROM agents a LEFT JOIN checkouts c ON c.agent_id = a.id
         WHERE a.merchant_id = ? GROUP BY a.id ORDER BY last_seen DESC, a.created_at DESC`
      )
      .all(merchantId);
    return { agents: rows };
  });

  app.post("/api/console/agents/new", async (req, reply) => {
    const merchantId = checkAuth(req);
    if (!merchantId) return reply.code(401).send({ error: { code: "UNAUTHORIZED" } });
    const { name } = (req.body ?? {}) as { name?: string };
    const minted = mintBuyerAgent(db, merchantId, (name ?? "").trim() || `buyer-${Date.now().toString(36)}`);
    return { ...minted, mcp: mcpConfigFor(merchantId, minted.agent_id, minted.mandate_id) };
  });

  app.post("/console/logout", async (_req, reply) => {
    reply.clearCookie("naka_console", { path: "/" });
    return { ok: true };
  });

  app.get("/api/console/escalations", async (req, reply) => {
    const merchantId = checkAuth(req);
    if (!merchantId) return reply.code(401).send({ error: { code: "UNAUTHORIZED" } });
    const rows = db
      .prepare(
        `SELECT c.id AS checkout_id, c.agent_id, c.mandate_id, c.total_paise, c.created_at,
                d.rule_hits, d.explanation
         FROM checkouts c JOIN decisions d ON d.id = (SELECT id FROM decisions WHERE checkout_id = c.id ORDER BY created_at DESC LIMIT 1)
         WHERE c.merchant_id = ? AND c.status = 'requires_escalation' ORDER BY c.created_at DESC`
      )
      .all(merchantId);
    return { escalations: rows };
  });

  app.post("/api/console/escalations/:checkoutId/approve", async (req, reply) => {
    const merchantId = checkAuth(req);
    if (!merchantId) return reply.code(401).send({ error: { code: "UNAUTHORIZED" } });
    const { checkoutId } = req.params as { checkoutId: string };
    if (tenants.merchantOfCheckout(checkoutId) !== merchantId) return notFound(reply);
    const { policy } = policyForCheckout(db, checkoutId);
    const approvalId = newId("appr");
    const expiresAt = Math.floor(Date.now() / 1000) + policy.escalation_approval_ttl_seconds;
    db.prepare(`INSERT INTO approvals (id, checkout_id, kind, token_hash, expires_at, decided_by, decision, decided_at) VALUES (?, ?, 'escalation', '', ?, 'merchant', 'approved', strftime('%Y-%m-%dT%H:%M:%fZ','now'))`).run(approvalId, checkoutId, expiresAt);
    insertLedgerRow(db, { actor: "merchant", action: "ESCALATION_APPROVED", checkout_id: checkoutId });
    return { approval_id: approvalId, expires_at: expiresAt };
  });

  app.post("/api/console/escalations/:checkoutId/deny", async (req, reply) => {
    const merchantId = checkAuth(req);
    if (!merchantId) return reply.code(401).send({ error: { code: "UNAUTHORIZED" } });
    const { checkoutId } = req.params as { checkoutId: string };
    if (tenants.merchantOfCheckout(checkoutId) !== merchantId) return notFound(reply);
    const { reason } = (req.body as { reason?: string }) ?? {};
    const { cancelCheckout } = await import("@naka/engine");
    const view = cancelCheckout(db, { checkoutId, reason: reason ?? "merchant_denied" });
    insertLedgerRow(db, { actor: "merchant", action: "ESCALATION_DENIED", checkout_id: checkoutId, inputs: { reason } });
    return view;
  });

  app.get("/api/console/refunds", async (req, reply) => {
    const merchantId = checkAuth(req);
    if (!merchantId) return reply.code(401).send({ error: { code: "UNAUTHORIZED" } });
    return {
      refunds: db
        .prepare(`SELECT r.* FROM refunds r JOIN checkouts c ON c.id = r.checkout_id WHERE c.merchant_id = ? ORDER BY r.created_at DESC`)
        .all(merchantId),
    };
  });

  app.post("/api/console/refunds", async (req, reply) => {
    const merchantId = checkAuth(req);
    if (!merchantId) return reply.code(401).send({ error: { code: "UNAUTHORIZED" } });
    const { razorpay_payment_id, amount_paise, reason, checkout_id } = req.body as {
      razorpay_payment_id: string; amount_paise?: number; reason: string; checkout_id: string;
    };
    if (tenants.merchantOfCheckout(checkout_id) !== merchantId) return notFound(reply);
    const payment = db.prepare("SELECT amount, amount_refunded FROM rzp_payments WHERE razorpay_payment_id = ?").get(razorpay_payment_id) as
      | { amount: number; amount_refunded: number }
      | undefined;
    const capturedPaise = payment ? payment.amount - payment.amount_refunded : 0;
    const { refundId, decision } = requestRefund(db, { checkoutId: checkout_id, razorpayPaymentId: razorpay_payment_id, amountPaise: amount_paise ?? null, reason, capturedPaise });
    return { refund_id: refundId, decision };
  });

  app.post("/api/console/refunds/:id/approve", async (req, reply) => {
    const merchantId = checkAuth(req);
    if (!merchantId) return reply.code(401).send({ error: { code: "UNAUTHORIZED" } });
    const { id } = req.params as { id: string };
    if (refundOwner(id) !== merchantId) return notFound(reply);
    const { approvalId, token } = approveRefund(db, id, "merchant");
    try {
      const owner = db.prepare("SELECT checkout_id FROM refunds WHERE id = ?").get(id) as { checkout_id: string } | undefined;
      const result = await executeRefund(db, owner ? tenants.rzpForCheckout(owner.checkout_id) : tenants.rzpFor(tenants.defaultMerchantId), { refundId: id, token });
      return { approval_id: approvalId, razorpay_refund_id: result.id, status: result.status };
    } catch (err) {
      return reply.code(err instanceof ExecutorError ? 409 : 500).send({ error: { code: err instanceof ExecutorError ? err.code : "INTERNAL", message: (err as Error).message } });
    }
  });

  app.post("/api/console/refunds/:id/deny", async (req, reply) => {
    const merchantId = checkAuth(req);
    if (!merchantId) return reply.code(401).send({ error: { code: "UNAUTHORIZED" } });
    const { id } = req.params as { id: string };
    if (refundOwner(id) !== merchantId) return notFound(reply);
    denyRefund(db, id, "merchant");
    return { ok: true };
  });

  app.post("/api/console/agents/:id/:action", async (req, reply) => {
    const merchantId = checkAuth(req);
    if (!merchantId) return reply.code(401).send({ error: { code: "UNAUTHORIZED" } });
    const { id, action } = req.params as { id: string; action: "suspend" | "activate" };
    const agent = db.prepare("SELECT merchant_id FROM agents WHERE id = ?").get(id) as { merchant_id: string } | undefined;
    if (agent?.merchant_id !== merchantId) return notFound(reply);
    const { setAgentStatus } = await import("@naka/identity");
    setAgentStatus(db, id, action === "suspend" ? "suspended" : "active");
    insertLedgerRow(db, { actor: "merchant", agent_id: id, action: action === "suspend" ? "AGENT_SUSPENDED" : "AGENT_ACTIVATED" });
    return { ok: true };
  });

  app.post("/api/console/kill-switch", async (req, reply) => {
    const merchantId = checkAuth(req);
    if (!merchantId) return reply.code(401).send({ error: { code: "UNAUTHORIZED" } });
    const { on } = req.body as { on: boolean };
    // Persisted on the merchant's row: the gate reads it on the next checkout in every process sharing this database.
    setMerchantPolicy(db, merchantId, { kill_switch: on });
    insertLedgerRow(db, { actor: "merchant", action: on ? "KILL_SWITCH_ON" : "KILL_SWITCH_OFF" });
    return { on };
  });

  app.post("/api/console/faults/webhook-500", async (req, reply) => {
    const merchantId = checkAuth(req);
    if (!merchantId) return reply.code(401).send({ error: { code: "UNAUTHORIZED" } });
    const { seconds } = req.body as { seconds: number };
    const expiresAt = setFault(db, "webhook_500", seconds);
    insertLedgerRow(db, { actor: "merchant", action: "FAULT_WEBHOOK_500_ENABLED", inputs: { seconds } });
    return { expires_at: expiresAt };
  });
  app.post("/api/console/faults/webhook-500/clear", async (req, reply) => {
    const merchantId = checkAuth(req);
    if (!merchantId) return reply.code(401).send({ error: { code: "UNAUTHORIZED" } });
    clearFault(db, "webhook_500");
    return { ok: true };
  });

  app.get("/api/console/ledger", async (req, reply) => {
    const merchantId = checkAuth(req);
    if (!merchantId) return reply.code(401).send({ error: { code: "UNAUTHORIZED" } });
    const after = Number((req.query as any).after_seq ?? 0);
    const limit = Math.min(200, Number((req.query as any).limit ?? 50));
    return {
      rows: db
        .prepare(
          `SELECT * FROM ledger WHERE seq > ? AND (
             checkout_id IN (SELECT id FROM checkouts WHERE merchant_id = ?)
             OR agent_id IN (SELECT id FROM agents WHERE merchant_id = ?)
             OR (checkout_id IS NULL AND agent_id IS NULL))
           ORDER BY seq DESC LIMIT ?`
        )
        .all(after, merchantId, merchantId, limit),
    };
  });

  app.get("/api/console/ledger/verify", async (req, reply) => {
    const merchantId = checkAuth(req);
    if (!merchantId) return reply.code(401).send({ error: { code: "UNAUTHORIZED" } });
    return verifyLedger(db);
  });

  app.get("/api/console/ledger/export", async (req, reply) => {
    const merchantId = checkAuth(req);
    if (!merchantId) return reply.code(401).send({ error: { code: "UNAUTHORIZED" } });
    reply.type("application/x-ndjson");
    return scopeLedgerRows(db, exportLedgerArray(db), merchantId).map((r) => JSON.stringify(r)).join("\n");
  });

  app.get("/api/console/ledger/export.csv", async (req, reply) => {
    const merchantId = checkAuth(req);
    if (!merchantId) return reply.code(401).send({ error: { code: "UNAUTHORIZED" } });
    reply.type("text/csv").header("Content-Disposition", "inline; filename=naka-ledger.csv");
    return merchantId === env.merchantId ? exportLedgerCsv(db) : toCsv(scopeLedgerRows(db, exportLedgerArray(db), merchantId));
  });

  // Demonstrates why the ledger's append-only trigger matters: temporarily lifts it, corrupts one row, restores the trigger.
  app.post("/api/console/ledger/tamper-demo", async (req, reply) => {
    const merchantId = checkAuth(req);
    if (!merchantId) return reply.code(401).send({ error: { code: "UNAUTHORIZED" } });
    const rows = db.prepare("SELECT seq FROM ledger ORDER BY seq ASC").all() as Array<{ seq: number }>;
    if (rows.length === 0) return reply.code(400).send({ error: { code: "LEDGER_EMPTY" } });
    const target = rows[Math.floor(rows.length / 2)].seq;
    db.exec("DROP TRIGGER IF EXISTS trg_ledger_no_update");
    try {
      db.prepare("UPDATE ledger SET action = 'TAMPERED_DEMO' WHERE seq = ?").run(target);
    } finally {
      db.exec(`CREATE TRIGGER trg_ledger_no_update BEFORE UPDATE ON ledger BEGIN SELECT RAISE(ABORT, 'ledger rows are append-only: UPDATE is not permitted'); END;`);
    }
    return { tampered_seq: target };
  });

  app.get("/api/console/webhook-fault-status", async (req, reply) => {
    const merchantId = checkAuth(req);
    if (!merchantId) return reply.code(401).send({ error: { code: "UNAUTHORIZED" } });
    return { active: isFaultActive(db, "webhook_500") };
  });
  // ---- Catalog: the merchant's side of onboarding ------------------------- The console used to be decisions only.
  app.get("/api/console/catalog", async (req, reply) => {
    const merchantId = checkAuth(req);
    if (!merchantId) return reply.code(401).send({ error: { code: "UNAUTHORIZED" } });
    const rows = db
      .prepare(
        `SELECT p.id AS product_id, p.title, p.category, v.id AS variant_id, v.title AS variant_title, v.price_paise, v.stock_qty, v.reserved_qty
         FROM products p JOIN variants v ON v.product_id = p.id
         WHERE p.merchant_id = ? AND p.active = 1 AND v.active = 1 ORDER BY p.category, p.title, v.title`
      )
      .all(merchantId);
    return { merchant: { id: merchantId, display_name: merchantDisplayName(db, merchantId) }, variants: rows };
  });

  app.get("/api/console/catalog/export.json", async (req, reply) => {
    const merchantId = checkAuth(req);
    if (!merchantId) return reply.code(401).send({ error: { code: "UNAUTHORIZED" } });
    const file = exportCatalog(db, merchantId);
    if (!file) return reply.code(404).send({ error: { code: "NOT_FOUND" } });
    return reply.header("Content-Disposition", `attachment; filename="${merchantId}-catalog.json"`).send(file);
  });

  app.post("/api/console/catalog/import", { bodyLimit: 2_097_152 }, async (req, reply) => {
    const merchantId = checkAuth(req);
    if (!merchantId) return reply.code(401).send({ error: { code: "UNAUTHORIZED" } });
    const parsed = CatalogFileSchema.safeParse(req.body);
    if (!parsed.success) {
      const detail = parsed.error.issues.slice(0, 8).map((i) => `${i.path.join(".") || "(root)"}: ${i.message}`).join("; ");
      return reply.code(400).send({ error: { code: "INVALID_CATALOG", message: detail } });
    }
    const file = parsed.data;
    const merchant = { id: merchantId, name: file.merchant.name ?? merchantId, display_name: file.merchant.display_name, currency: file.merchant.currency };
    importCatalog(db, { ...file, merchant }, { deactivateMissing: true });
    const counts = { products: file.products.length, variants: file.products.reduce((n, p) => n + p.variants.length, 0), coupons: file.coupons.length };
    insertLedgerRow(db, { actor: "merchant", action: "CATALOG_IMPORTED", inputs: counts });
    return { ok: true, merchant, ...counts };
  });
}

function scopeLedgerRows(db: Db, rows: unknown[], merchantId: string): any[] {
  const checkouts = new Set((db.prepare("SELECT id FROM checkouts WHERE merchant_id = ?").all(merchantId) as Array<{ id: string }>).map((r) => r.id));
  const agents = new Set((db.prepare("SELECT id FROM agents WHERE merchant_id = ?").all(merchantId) as Array<{ id: string }>).map((r) => r.id));
  return (rows as any[]).filter((r) => (r.checkout_id && checkouts.has(r.checkout_id)) || (r.agent_id && agents.has(r.agent_id)) || (!r.checkout_id && !r.agent_id));
}

function toCsv(rows: any[]): string {
  if (rows.length === 0) return "";
  const keys = Object.keys(rows[0]);
  const cell = (v: unknown) => `"${String(v ?? "").replace(/"/g, '""')}"`;
  return [keys.join(","), ...rows.map((r) => keys.map((k) => cell(typeof r[k] === "object" && r[k] !== null ? JSON.stringify(r[k]) : r[k])).join(","))].join("\n");
}

function loginPage(): string {
  return `<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><style>${BASE_CSS}</style><title>Naka console</title>
  <style>body{font-family:system-ui;margin:0;background:var(--bg)}.box{max-width:420px;margin:60px auto;padding:24px;background:#fff;border:1px solid var(--line);border-radius:10px}label{display:block;margin:12px 0 4px;font-weight:600}
  input{width:100%;box-sizing:border-box;padding:8px;border:1px solid #ccc;border-radius:6px;font:inherit}button{margin-top:16px;background:#2b6cb0;color:#fff;border:none;padding:10px 18px;border-radius:6px;font-size:1em}
  .muted{color:#666;font-size:0.9em}</style></head><body>${nav("console")}<div class="box">
    <h2 style="margin-top:0">Sign in to your console</h2>
    <label>Merchant id <span class="muted">(leave blank for the default shop)</span></label><input id="m" placeholder="${env.merchantId}">
    <label>Password</label><input id="p" type="password">
    <button onclick="login()">Sign in</button> <p id="e" style="color:#c53030"></p>
    <p class="muted">New here? <a href="/onboard">Onboard your shop</a>.</p></div>
    <script>
      async function login() {
        const r = await fetch('/console/login', { method: 'POST', headers: {'Content-Type':'application/json'},
          body: JSON.stringify({ merchant_id: document.getElementById('m').value, password: document.getElementById('p').value }) });
        if (r.ok) location.reload(); else document.getElementById('e').textContent = 'Wrong merchant id or password';
      }
    </script></body></html>`;
}

function dashboardPage(): string {
  return `<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><style>${BASE_CSS}</style><title>Naka console</title>
  <style>
  body{margin:0;font-family:system-ui,-apple-system,"Segoe UI",Roboto,sans-serif;color:var(--ink);background:var(--bg)}
  .app{display:grid;grid-template-columns:230px 1fr;min-height:calc(100vh - 53px)}
  aside{background:#fff;border-right:1px solid var(--line);padding:16px 12px}
  aside .who{padding:8px 10px 14px;border-bottom:1px solid var(--line);margin-bottom:10px}aside .who b{display:block;font-size:1.05em}aside .who span{color:var(--muted);font-size:.8em}
  aside a{display:flex;justify-content:space-between;align-items:center;padding:9px 10px;border-radius:8px;color:#334;text-decoration:none;font-size:.95em;margin:2px 0}
  aside a:hover{background:#f1f4f8}aside a.on{background:#e8f0fb;color:var(--accent);font-weight:600}
  aside a .n{background:var(--warn);color:#fff;border-radius:999px;font-size:.72em;padding:1px 7px}aside a .n:empty{display:none}
  main{padding:22px 26px 60px;min-width:0}
  .top{display:flex;justify-content:space-between;align-items:center;margin-bottom:16px;gap:10px;flex-wrap:wrap}.top h1{margin:0;font-size:1.45em}
  .badge{display:inline-block;padding:2px 10px;border-radius:999px;font-size:.78em;background:#e8f0fb;color:var(--accent);margin-left:8px;vertical-align:middle}.badge.recorded{background:#fff4e0;color:var(--warn)}
  .muted{color:var(--muted);font-size:.9em}
  .grid{display:grid;grid-template-columns:repeat(auto-fit,minmax(170px,1fr));gap:12px;margin:0 0 18px}
  .stat{background:#fff;border:1px solid var(--line);border-radius:12px;padding:14px 16px}.stat .l{color:var(--muted);font-size:.8em;text-transform:uppercase;letter-spacing:.04em}.stat b{display:block;font-size:1.55em;margin:4px 0 2px;letter-spacing:-.01em}.stat .sub{color:var(--muted);font-size:.8em}
  .card{background:#fff;border:1px solid var(--line);border-radius:12px;padding:16px 18px;margin:0 0 16px}.card h3{margin:0 0 10px;font-size:1.02em;display:flex;justify-content:space-between;align-items:center;gap:10px}
  aside .who .ext{display:block;margin-top:6px;font-size:.8em;color:var(--accent);padding:0;border:none;background:none}
  .two{display:grid;grid-template-columns:1.4fr 1fr;gap:16px}@media(max-width:1000px){.two{grid-template-columns:1fr}.app{grid-template-columns:1fr}aside{display:flex;flex-wrap:wrap;gap:4px;border-right:none;border-bottom:1px solid var(--line)}aside .who{display:none}}
  table{width:100%;border-collapse:collapse}td,th{border-bottom:1px solid var(--line);padding:8px 6px;text-align:left;font-size:.9em;vertical-align:top}th{color:var(--muted);font-weight:600;font-size:.76em;text-transform:uppercase;letter-spacing:.04em}tr:last-child td{border-bottom:none}
  code,.id{font-family:ui-monospace,SFMono-Regular,Menlo,monospace;font-size:.84em}.id{color:#556}
  .pill{display:inline-block;padding:2px 9px;border-radius:999px;font-size:.76em;background:#eef2f7;color:#456;white-space:nowrap}
  .pill.completed,.pill.captured,.pill.active,.pill.ok{background:#e6f4ea;color:var(--ok)}.pill.requires_escalation,.pill.requested,.pill.complete_in_progress,.pill.ready_for_complete{background:#fff4e0;color:var(--warn)}.pill.canceled,.pill.failed,.pill.suspended,.pill.denied{background:#fde8e8;color:var(--bad)}
  button{background:var(--accent);color:#fff;border:none;padding:8px 13px;border-radius:7px;cursor:pointer;font-size:.9em;margin-right:6px}button.ghost{background:#fff;color:var(--accent);border:1px solid var(--accent)}button.danger{background:var(--bad)}button.sm{padding:5px 9px;font-size:.82em}
  input,select{padding:8px 10px;border:1px solid #ccd;border-radius:7px;font:inherit}label{display:block;font-size:.82em;color:var(--muted);margin:10px 0 4px}
  pre{background:#1f2430;color:#e6e8ec;padding:12px;border-radius:8px;overflow:auto;font-size:.8em;margin:8px 0}
  .kill{padding:10px 14px;border-radius:10px;background:#fde8e8;color:var(--bad);display:none;margin-bottom:14px;font-weight:600}
  .chart{width:100%;height:150px}.empty{color:var(--muted);padding:14px 0}
  section.page{display:none}section.page.on{display:block;animation:nk-fade-up .25s}
  @keyframes grow{from{transform:scaleY(0)}}
  tr.rowlink{cursor:pointer;transition:background .15s}tr.rowlink:hover{background:#f6f9ff}
  .ov{position:fixed;inset:0;background:rgba(20,24,31,.35);opacity:0;pointer-events:none;transition:opacity .25s;z-index:60}.ov.on{opacity:1;pointer-events:auto}
  .drawer{position:fixed;top:0;right:0;height:100vh;width:min(560px,100vw);background:#fff;box-shadow:-20px 0 50px -30px rgba(0,0,0,.4);transform:translateX(105%);transition:transform .3s cubic-bezier(.2,.7,.2,1);z-index:70;overflow:auto;padding:20px 22px}.drawer.on{transform:none}
  .drawer h2{margin:0 0 4px;font-size:1.15em}.drawer h4{margin:18px 0 8px;font-size:.82em;text-transform:uppercase;letter-spacing:.05em;color:var(--muted)}
  .drawer .x{position:absolute;top:14px;right:16px;background:none;border:none;font-size:1.4em;color:var(--muted);cursor:pointer;margin:0;padding:4px}
  .hit{display:grid;grid-template-columns:24px 1fr auto;gap:8px;align-items:center;padding:6px 0;border-bottom:1px solid var(--line);font-size:.88em}.hit .dot{width:10px;height:10px;border-radius:50%}.hit .dot.p{background:var(--ok)}.hit .dot.f{background:var(--bad)}.hit code{font-size:.85em}
  .tl{list-style:none;margin:0;padding:0;border-left:2px solid var(--line);margin-left:6px}.tl li{position:relative;padding:4px 0 8px 14px;font-size:.86em}.tl li:before{content:"";position:absolute;left:-7px;top:9px;width:10px;height:10px;border-radius:50%;background:#fff;border:2px solid var(--accent)}
  @media(prefers-reduced-motion:reduce){section.page.on,.drawer{animation:none;transition:none}}
  .steps{margin:0;padding-left:18px;color:#334;font-size:.92em}.steps li{margin:4px 0}
  .ok-dot{display:inline-block;width:9px;height:9px;border-radius:50%;background:var(--ok);margin-right:6px}.bad-dot{display:inline-block;width:9px;height:9px;border-radius:50%;background:var(--bad);margin-right:6px}
  </style></head><body>${nav("console")}
  <div class="app">
  <aside>
    <div class="who"><b id="sName">…</b><span id="sId"></span><a id="sShop" class="ext" href="/shop" target="_blank" rel="noopener">Open storefront ↗</a></div>
    <a href="#overview" data-p="overview">Overview</a>
    <a href="#orders" data-p="orders">Orders</a>
    <a href="#approvals" data-p="approvals">Approvals <span class="n" id="nEsc"></span></a>
    <a href="#agents" data-p="agents">Buyer agents</a>
    <a href="#channels" data-p="channels">Channels</a>
    <a href="#refunds" data-p="refunds">Refunds <span class="n" id="nRef"></span></a>
    <a href="#catalog" data-p="catalog">Catalog</a>
    <a href="#ledger" data-p="ledger">Ledger</a>
    <a href="#settings" data-p="settings">Settings</a>
    <a href="#" onclick="logout();return false" style="margin-top:12px;color:var(--muted)">Sign out</a>
  </aside>
  <main>
    <div class="top"><h1 id="title">Overview <span id="mode" class="badge"></span></h1><span class="muted" id="clock"></span></div>
    <div id="kill" class="kill">Kill switch is ON, every new checkout is being denied. Turn it off in Settings.</div>

    <section class="page on" id="p-overview">
      <div class="grid" id="stats"></div>
      <div class="two">
        <div class="card"><h3>Revenue, last 14 days</h3><svg class="chart" id="chart" viewBox="0 0 700 150" preserveAspectRatio="none"></svg><div class="muted" id="chartNote"></div></div>
        <div class="card"><h3>Needs you <span class="muted" id="needsNote"></span></h3><div id="needs"></div></div>
      </div>
      <div class="card"><h3>Latest orders <a href="#orders" class="muted" style="font-weight:400">all orders →</a></h3><div id="ordersMini"></div></div>
    </section>

    <section class="page" id="p-orders"><div class="card"><h3>Orders</h3><div id="orders"></div></div></section>

    <section class="page" id="p-approvals"><div class="card"><h3>Orders waiting for your approval</h3><p class="muted">These exceeded your approval threshold. Nothing is charged until you approve and the buyer confirms on the pay page.</p><div id="escalations"></div></div></section>

    <section class="page" id="p-agents">
      <div class="card"><h3>Buyer agents <span><button onclick="mint()">Mint a buyer agent</button></span></h3>
        <p class="muted">Each agent holds its own Ed25519 key and buys under a mandate you control. Minting returns a key once, plus a ready <code>.mcp.json</code> block for Claude Code.</p>
        <div id="kit"></div><div id="agents"></div></div>
    </section>

    <section class="page" id="p-channels">
      <div class="card"><h3>Telegram shop bot <span id="tgState"></span></h3><div id="telegram"></div></div>
      <div class="card"><h3>Claude Code / MCP</h3><p class="muted">Any MCP client can shop here. Mint a buyer agent on the Buyer agents page and paste the block it gives you into <code>.mcp.json</code>.</p></div>
    </section>

    <section class="page" id="p-refunds"><div class="card"><h3>Refunds</h3><p class="muted">Refunds are requested by you and executed only after a separate approval, buyer agents cannot start one.</p><div id="refunds"></div></div></section>

    <section class="page" id="p-catalog"><div class="card"><h3>Catalog <span class="muted" id="catCount"></span></h3>
      <p class="muted">Download the current catalog, edit it, and upload it back. An upload replaces the catalog: anything missing from the file is deactivated (never deleted).</p>
      <a href="/api/console/catalog/export.json">Download catalog.json</a> &nbsp; <input type="file" id="catalogFile" accept="application/json"> <button onclick="uploadCatalog()">Upload catalog</button> <span id="catalogResult" class="muted"></span>
      <div id="catalog"></div></div></section>

    <section class="page" id="p-ledger"><div class="card"><h3>Ledger <span><button class="ghost sm" onclick="verify()">Verify chain</button><button class="ghost sm" onclick="tamperDemo()">Tamper demo</button> <a href="/api/console/ledger/export.csv">CSV</a></span></h3>
      <div id="verifyResult" class="muted"></div><div id="ledger"></div></div></section>

    <section class="page" id="p-settings">
      <div class="two">
        <div class="card"><h3>Policy</h3>
          <label>Max per checkout (₹)</label><input id="pMax" type="number" min="1">
          <label>Ask me before any order over (₹)</label><input id="pAppr" type="number" min="1">
          <label>Per agent, per day (₹)</label><input id="pDaily" type="number" min="1">
          <label>Max quantity per line</label><input id="pQty" type="number" min="1">
          <p><button onclick="savePolicy()">Save policy</button> <span id="policyResult" class="muted"></span></p>
        </div>
        <div class="card"><h3>Emergency</h3>
          <p class="muted">The kill switch denies every new checkout for this shop immediately, in every process sharing this database. Existing paid orders are untouched.</p>
          <button class="danger" onclick="kill(true)">Kill switch ON</button><button class="ghost" onclick="kill(false)">Kill switch OFF</button>
          <h3 style="margin-top:18px">Razorpay</h3>
          <p class="muted">Webhook URL for your Razorpay dashboard:</p><pre id="whUrl" style="background:#f4f5f7;color:#223"></pre>
          <p class="muted">Demo tools: <button class="ghost sm" onclick="fault()">Webhook 500 for 90s</button><button class="ghost sm" onclick="clearFault()">Clear</button></p>
        </div>
      </div>
    </section>
  </main></div>
  <div id="ov" class="ov" onclick="closeOrder()"></div>
  <aside id="drawer" class="drawer" aria-hidden="true"><button class="x" onclick="closeOrder()" aria-label="Close">×</button><div id="drawerBody"></div></aside>

  <script>
    const rs = (p) => '₹' + ((p || 0) / 100).toLocaleString('en-IN', { maximumFractionDigits: 2 });
    const esc = (s) => String(s ?? '').replace(/&/g,'&amp;').replace(/</g,'&lt;');
    const pill = (s) => '<span class="pill ' + esc(s) + '">' + esc(String(s).replace(/_/g,' ')) + '</span>';
    const when = (t) => t ? new Date(t).toLocaleString('en-IN', { dateStyle: 'medium', timeStyle: 'short' }) : '';
    async function j(url, opts) { const r = await fetch(url, opts); if (r.status === 401) { location.reload(); return {}; } return r.json(); }
    const post = (url, body, method) => j(url, { method: method || 'POST', headers: {'Content-Type':'application/json'}, body: JSON.stringify(body ?? {}) });
    const TITLES = { overview:'Overview', orders:'Orders', approvals:'Approvals', agents:'Buyer agents', channels:'Channels', refunds:'Refunds', catalog:'Catalog', ledger:'Ledger', settings:'Settings' };
    function show(p) {
      if (!TITLES[p]) p = 'overview';
      document.querySelectorAll('section.page').forEach(s => s.classList.toggle('on', s.id === 'p-' + p));
      document.querySelectorAll('aside a[data-p]').forEach(a => a.classList.toggle('on', a.dataset.p === p));
      document.getElementById('title').firstChild.textContent = TITLES[p] + ' ';
    }
    window.addEventListener('hashchange', () => show(location.hash.slice(1)));
    show(location.hash.slice(1));

    function chart(daily) {
      const days = []; for (let i = 13; i >= 0; i--) { const d = new Date(Date.now() - i*864e5).toISOString().slice(0,10); days.push({ day: d, paise: 0, orders: 0 }); }
      (daily || []).forEach(r => { const d = days.find(x => x.day === r.day); if (d) { d.paise = r.paise; d.orders = r.orders; } });
      const max = Math.max(1, ...days.map(d => d.paise)); const w = 700/14;
      const anim = window.chartDrawn ? '' : ' style="transform-box:fill-box;transform-origin:bottom;animation:grow .7s cubic-bezier(.2,.7,.2,1) ' + '0ms both"';
      document.getElementById('chart').innerHTML = days.map((d, i) => { const h = Math.round(120 * d.paise / max); return '<rect' + (anim ? anim.replace('0ms', (i*40) + 'ms') : '') + ' x="' + (i*w+6) + '" y="' + (130-h) + '" width="' + (w-12) + '" height="' + h + '" rx="3" fill="' + (d.paise ? '#2b6cb0' : '#e6e8ec') + '"><title>' + d.day + ': ' + rs(d.paise) + ' (' + d.orders + ' orders)</title></rect><text x="' + (i*w+w/2) + '" y="146" font-size="9" text-anchor="middle" fill="#889">' + d.day.slice(8) + '</text>'; }).join('');
      const total = days.reduce((a, d) => a + d.paise, 0), n = days.reduce((a, d) => a + d.orders, 0);
      document.getElementById('chartNote').textContent = n ? rs(total) + ' across ' + n + ' paid orders in 14 days' : 'No paid orders in the last 14 days yet.';
      window.chartDrawn = true;
    }

    async function openOrder(id) {
      const d = await j('/api/console/orders/' + id); if (!d.checkout) return;
      const c = d.checkout;
      const hits = (dec) => dec.rule_hits.map(h => '<div class="hit"><span class="dot ' + (h.passed ? 'p' : 'f') + '"></span><code>' + esc(h.rule_id) + '</code><span class="muted">' + esc(h.left) + ' vs ' + esc(h.right) + '</span></div>').join('');
      document.getElementById('drawerBody').innerHTML =
        '<h2>' + rs(c.total_paise) + ' ' + pill(c.status) + '</h2><span class="id">' + esc(c.id) + '</span><br><span class="muted">' + when(c.created_at) + (c.completed_at ? ' · paid ' + when(c.completed_at) : '') + ' · agent <span class="id">' + esc(c.agent_id) + '</span></span>' +
        '<h4>Items</h4><table>' + d.lines.map(l => '<tr><td>' + esc(l.title) + (l.is_addon ? ' <span class="pill">add-on</span>' : '') + '</td><td>×' + l.quantity + '</td><td style="text-align:right"><b>' + rs(l.line_total_paise) + '</b></td></tr>').join('') +
        (c.discount_paise ? '<tr><td colspan="2">Discount ' + esc(c.coupon_code || '') + '</td><td style="text-align:right">−' + rs(c.discount_paise) + '</td></tr>' : '') + '</table>' +
        '<h4>Decisions, every rule, with the numbers compared</h4>' + (d.decisions.length ? d.decisions.map(dec => '<div style="margin-bottom:10px"><b>' + esc(dec.action) + '</b> → ' + pill(dec.outcome) + ' <span class="muted">' + when(dec.created_at) + '</span><div class="muted" style="margin:4px 0 6px">' + esc(dec.explanation) + '</div>' + hits(dec) + '</div>').join('') : '<p class="muted">No decision recorded.</p>') +
        '<h4>Payment attempts</h4>' + (d.attempts.length ? '<table>' + d.attempts.map(a => '<tr><td>#' + a.attempt_no + ' ' + esc(a.kind) + '</td><td>' + pill(a.status) + (a.failure_category ? ' <span class="muted">' + esc(a.failure_category) + '</span>' : '') + '</td><td class="id">' + esc(a.razorpay_order_id || a.plink_id || '') + '</td><td style="text-align:right">' + rs(a.amount_paise) + '</td></tr>').join('') + '</table>' : '<p class="muted">No payment attempt yet, the buyer has not confirmed.</p>') +
        '<h4>Razorpay payments</h4>' + (d.payments.length ? '<table>' + d.payments.map(p => '<tr><td class="id">' + esc(p.razorpay_payment_id) + '</td><td>' + pill(p.status) + '</td><td>' + esc(p.method || '') + '</td><td style="text-align:right">' + rs(p.amount) + '</td></tr>' + (p.error_description ? '<tr><td colspan="4" class="muted">' + esc(p.error_description) + ' <span class="pill">' + esc(p.source) + '</span></td></tr>' : '')).join('') + '</table>' : '<p class="muted">None.</p>') +
        '<h4>Ledger trail</h4><ul class="tl">' + d.ledger.map(l => '<li><b>' + esc(l.action) + '</b> <span class="muted">' + esc(l.actor) + ' · ' + when(l.ts) + (l.amount_paise ? ' · ' + rs(l.amount_paise) : '') + '</span>' + (l.decision ? ' ' + pill(l.decision) : '') + '</li>').join('') + '</ul>';
      document.getElementById('ov').classList.add('on'); document.getElementById('drawer').classList.add('on'); document.getElementById('drawer').setAttribute('aria-hidden', 'false');
    }
    function closeOrder() { document.getElementById('ov').classList.remove('on'); document.getElementById('drawer').classList.remove('on'); document.getElementById('drawer').setAttribute('aria-hidden', 'true'); }
    document.addEventListener('keydown', (e) => { if (e.key === 'Escape') closeOrder(); });

    async function refresh() {
      const s = await j('/api/console/stats'); if (!s.merchant) return;
      document.getElementById('sName').textContent = s.merchant.display_name; document.getElementById('sId').textContent = s.merchant.id; document.getElementById('sShop').href = '/shop/' + encodeURIComponent(s.merchant.id);
      const mode = document.getElementById('mode'); mode.textContent = s.merchant.mode === 'real' ? 'Razorpay test mode' : 'simulated payments'; mode.className = 'badge ' + s.merchant.mode;
      document.getElementById('clock').textContent = 'updated ' + new Date().toLocaleTimeString('en-IN');
      document.getElementById('kill').style.display = s.policy.kill_switch ? 'block' : 'none';
      for (const [id, k] of [['pMax','max_per_checkout_paise'],['pAppr','merchant_approval_over_paise'],['pDaily','per_agent_daily_cap_paise']]) { const el = document.getElementById(id); if (document.activeElement !== el) el.value = Math.round(s.policy[k]/100); }
      const q = document.getElementById('pQty'); if (document.activeElement !== q) q.value = s.policy.max_qty_per_line;
      document.getElementById('whUrl').textContent = s.merchant.webhook_url;
      const c = s.checkouts || {}, p = s.payments || {};
      document.getElementById('nEsc').textContent = c.requires_escalation || ''; document.getElementById('nRef').textContent = s.refunds_pending || '';
      document.getElementById('stats').innerHTML = [
        ['Revenue', rs(s.revenue.all_time_paise), s.revenue.orders_all_time + ' paid orders, all time'],
        ['Today', rs(s.revenue.today_paise), s.revenue.orders_today + ' paid today'],
        ['Awaiting approval', c.requires_escalation || 0, 'orders over your threshold'],
        ['Open carts', (c.ready_for_complete || 0) + (c.complete_in_progress || 0), 'reserved, not yet paid'],
        ['Payments', p.captured || 0, (p.failed || 0) + ' failed, recovered in-session'],
        ['Buyer agents', s.agents.active + '/' + s.agents.total, 'active / registered'],
        ['Catalog', s.catalog.variants || 0, (s.catalog.products || 0) + ' products · ' + (s.catalog.low_stock || 0) + ' low stock'],
        ['Telegram bot', s.telegram.connected ? (s.telegram.running ? 'live' : 'idle') : 'off', s.telegram.username ? '@' + s.telegram.username : 'connect in Channels'],
      ].map(([l, v, sub]) => '<div class="stat"><span class="l">' + l + '</span><b>' + v + '</b><span class="sub">' + sub + '</span></div>').join('');
      chart(s.daily);

      const e = await j('/api/console/escalations');
      const escHtml = e.escalations.length ? e.escalations.map(x =>
        '<div style="padding:10px 0;border-bottom:1px solid var(--line)"><b>' + rs(x.total_paise) + '</b> · <span class="id">' + esc(x.checkout_id) + '</span> · <span class="muted">' + when(x.created_at) + '</span><br><span class="muted">' + esc(x.explanation) + '</span><br>' +
        '<button class="sm" onclick="approve(\\''+x.checkout_id+'\\')">Approve</button><button class="ghost sm" onclick="deny(\\''+x.checkout_id+'\\')">Deny</button><button class="ghost sm" onclick="openOrder(\\''+x.checkout_id+'\\')">Why?, see the rules</button></div>').join('') : '<p class="empty">Nothing waiting on you.</p>';
      document.getElementById('escalations').innerHTML = escHtml;
      const rf = await j('/api/console/refunds');
      document.getElementById('needs').innerHTML = (e.escalations.length || s.refunds_pending) ? escHtml + (s.refunds_pending ? '<p><a href="#refunds">' + s.refunds_pending + ' refund' + (s.refunds_pending === 1 ? '' : 's') + ' waiting for approval →</a></p>' : '') : '<p class="empty">All clear.</p>';
      document.getElementById('needsNote').textContent = e.escalations.length ? e.escalations.length + ' escalation' + (e.escalations.length === 1 ? '' : 's') : '';

      const o = await j('/api/console/orders');
      const orderRows = (rows) => rows.length ? '<table><tr><th>when</th><th>items</th><th>total</th><th>status</th><th>agent</th><th>payment</th></tr>' + rows.map(r =>
        '<tr class="rowlink" onclick="openOrder(\\''+r.id+'\\')"><td>' + when(r.created_at) + '</td><td>' + esc(r.items || '') + '<br><span class="id">' + esc(r.id) + '</span></td><td><b>' + rs(r.total_paise) + '</b></td><td>' + pill(r.status) + '</td><td class="id">' + esc(r.agent_id) + '</td><td class="id">' + esc(r.payment_id || '') + '</td></tr>').join('') + '</table>' : '<p class="empty">No checkouts yet. Connect a buyer and ask it to shop.</p>';
      document.getElementById('orders').innerHTML = orderRows(o.orders); document.getElementById('ordersMini').innerHTML = orderRows(o.orders.slice(0, 6));

      const a = await j('/api/console/agents');
      const busy = a.agents.filter(x => x.checkouts > 0 || x.status !== 'active'), idle = a.agents.length - busy.length, shown = window.showAllAgents ? a.agents : busy;
      document.getElementById('agents').innerHTML = (shown.length ? '<table><tr><th>agent</th><th>name</th><th>status</th><th>checkouts</th><th>paid</th><th>spent</th><th>last seen</th><th></th></tr>' + shown.map(x =>
        '<tr><td class="id">' + esc(x.id) + '</td><td>' + esc(x.name) + '</td><td>' + pill(x.status) + '</td><td>' + x.checkouts + '</td><td>' + (x.completed || 0) + '</td><td><b>' + rs(x.spent_paise) + '</b></td><td>' + when(x.last_seen) + '</td><td>' +
        (x.status === 'active' ? '<button class="ghost sm" onclick="agentAction(\\''+x.id+'\\',\\'suspend\\')">Suspend</button>' : '<button class="ghost sm" onclick="agentAction(\\''+x.id+'\\',\\'activate\\')">Activate</button>') + '</td></tr>').join('') + '</table>' : '<p class="empty">No agent has transacted yet.</p>') +
        (idle ? '<p class="muted">' + idle + ' registered agent' + (idle === 1 ? '' : 's') + ' with no checkouts. <a href="#agents" onclick="window.showAllAgents=!window.showAllAgents;refresh();return false">' + (window.showAllAgents ? 'Hide' : 'Show all') + '</a></p>' : '');

      document.getElementById('refunds').innerHTML = rf.refunds.length ? '<table><tr><th>id</th><th>payment</th><th>amount</th><th>reason</th><th>status</th><th></th></tr>' + rf.refunds.map(r =>
        '<tr><td class="id">'+esc(r.id)+'</td><td class="id">'+esc(r.razorpay_payment_id)+'</td><td>'+(r.amount_paise ? rs(r.amount_paise) : 'full')+'</td><td>'+esc(r.reason||'')+'</td><td>'+pill(r.status)+'</td><td>' +
        (r.status==='requested' ? '<button class="sm" onclick="approveRefund(\\''+r.id+'\\')">Approve &amp; execute</button><button class="ghost sm" onclick="denyRefund(\\''+r.id+'\\')">Deny</button>' : '') + '</td></tr>').join('') + '</table>' : '<p class="empty">No refunds.</p>';

      const l = await j('/api/console/ledger?limit=25');
      document.getElementById('ledger').innerHTML = '<table><tr><th>#</th><th>actor</th><th>action</th><th>decision</th><th>checkout</th></tr>' + l.rows.map(r =>
        '<tr><td>'+r.seq+'</td><td>'+esc(r.actor)+'</td><td>'+esc(r.action)+'</td><td>'+esc(r.decision||'')+'</td><td class="id">'+esc(r.checkout_id||'')+'</td></tr>').join('') + '</table>';

      renderTelegram(s.telegram);
    }
    function renderTelegram(t) {
      const st = document.getElementById('tgState');
      if (!t.connected) {
        st.innerHTML = '<span class="pill">not connected</span>';
        document.getElementById('telegram').innerHTML =
          '<p class="muted">Give your shop a Telegram bot. Customers chat with it, it proposes carts under your policy, and hands them a pay link, Naka runs it for you.</p>' +
          '<ol class="steps"><li>In Telegram, open <b>@BotFather</b> and send <code>/newbot</code>.</li><li>Give it a name (your shop) and a username ending in <code>bot</code>.</li><li>Paste the token BotFather replies with here.</li></ol>' +
          '<label>Bot token</label><input id="tgToken" style="width:420px;max-width:100%" placeholder="123456789:AA…"> <button onclick="tgConnect()">Connect</button> <span id="tgResult" class="muted"></span>' +
          (t.llm_available ? '' : '<p class="muted" style="color:var(--bad)">This server has no LLM key configured (OPENROUTER_API_KEY / GEMINI_API_KEY / OPENAI_API_KEY), so a connected bot cannot answer yet.</p>');
      } else {
        st.innerHTML = t.running ? '<span class="pill ok">live</span>' : '<span class="pill">idle</span>';
        document.getElementById('telegram').innerHTML =
          '<p><b>@' + esc(t.username) + '</b>, share <a href="' + esc(t.link) + '" target="_blank">' + esc(t.link) + '</a> with customers.</p>' +
          '<p class="muted">' + (t.running ? '<span class="live-dot"></span>Running on this server' : '<span class="bad-dot"></span>Not running' + (t.llm_available ? '' : ', no LLM key on the server')) + ' · ' + t.chats_served + ' chats · ' + t.messages_handled + ' messages' + (t.last_error ? ' · last error: ' + esc(t.last_error) : '') + '</p>' +
          '<p class="muted small">Models, in fallback order: ' + esc((t.providers || []).join(' → ') || 'none configured') + '</p>' +
          (t.last_error && /per-day|per_day|daily/i.test(t.last_error) ? '<p class="muted small">OpenRouter\'s free tier allows 50 requests a day and resets at 05:30 IST. Add $10 of credits there for 1,000 a day, or let the bot fall through to Gemini (set GEMINI_API_KEY on the server).</p>' : '') +
          '<p class="muted">Escalation alerts: ' + (t.alerts_chat_set ? '<span class="ok-dot"></span>on, sent to the chat that said <code>/alerts</code>' : 'open your bot and send <code>/alerts</code> to receive approval requests there') + '</p>' +
          '<button class="ghost sm" onclick="tgDisconnect()">Disconnect bot</button>';
      }
    }
    async function tgConnect() {
      const out = document.getElementById('tgResult'); out.textContent = 'Checking with Telegram…';
      const r = await fetch('/api/console/telegram', { method:'POST', headers:{'Content-Type':'application/json'}, body: JSON.stringify({ token: document.getElementById('tgToken').value }) });
      const d = await r.json();
      if (!r.ok) { out.textContent = d.error?.message || d.error?.code || 'Failed'; nkToast(out.textContent, 'bad'); return; }
      nkToast('Telegram bot connected: @' + d.username, 'ok');
      refresh();
    }
    async function tgDisconnect() { if (!confirm('Disconnect the Telegram bot?')) return; await post('/api/console/telegram', {}, 'DELETE'); nkToast('Telegram bot disconnected', 'warn'); refresh(); }
    async function savePolicy() {
      const v = (id) => Math.round(Number(document.getElementById(id).value) * 100) || undefined;
      const r = await fetch('/api/console/policy', { method:'POST', headers:{'Content-Type':'application/json'}, body: JSON.stringify({ max_per_checkout_paise: v('pMax'), merchant_approval_over_paise: v('pAppr'), per_agent_daily_cap_paise: v('pDaily'), max_qty_per_line: Number(document.getElementById('pQty').value) || undefined }) });
      const d = await r.json(); document.getElementById('policyResult').textContent = r.ok ? 'Saved.' : (d.error?.message || 'Failed'); nkToast(r.ok ? 'Policy saved, applies to the next checkout' : (d.error?.message || 'Policy not saved'), r.ok ? 'ok' : 'bad'); refresh();
    }
    async function loadCatalog() {
      const c = await j('/api/console/catalog'); if (!c.variants) return;
      document.getElementById('catCount').textContent = c.variants.length + ' variants';
      document.getElementById('catalog').innerHTML = c.variants.length ? '<table><tr><th>category</th><th>product</th><th>variant</th><th>price</th><th>sellable</th></tr>' + c.variants.map(v =>
        '<tr><td>'+esc(v.category)+'</td><td>'+esc(v.title)+'</td><td>'+esc(v.variant_title)+'</td><td>'+rs(v.price_paise)+'</td><td>'+(v.stock_qty - v.reserved_qty)+'</td></tr>').join('') + '</table>' : '<p class="empty">No products yet, upload a catalog.</p>';
    }
    async function uploadCatalog() {
      const f = document.getElementById('catalogFile').files[0], out = document.getElementById('catalogResult');
      if (!f) { out.textContent = 'Choose a JSON file first.'; return; }
      let body; try { body = JSON.parse(await f.text()); } catch (e) { out.textContent = 'Not valid JSON: ' + e.message; return; }
      const r = await fetch('/api/console/catalog/import', {method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(body)});
      const d = await r.json();
      out.textContent = r.ok ? ('Imported ' + d.products + ' products / ' + d.variants + ' variants') : ('Rejected: ' + (d.error?.message || d.error?.code));
      nkToast(out.textContent, r.ok ? 'ok' : 'bad');
      loadCatalog(); refresh();
    }
    async function mint() {
      const name = prompt('Name for this buyer agent (e.g. "claude-laptop")', 'claude-laptop'); if (name === null) return;
      const k = await post('/api/console/agents/new', { name }); if (!k.agent_id) return;
      nkToast('Agent minted, the private key is shown once', 'ok');
      document.getElementById('kit').innerHTML =
        '<div style="border:1px dashed var(--accent);border-radius:10px;padding:12px 14px;margin-bottom:12px"><b>New agent ' + esc(k.agent_id) + '</b>, the private key below is shown once.<br>' +
        '<span class="muted">Mandate: up to ' + rs(k.mandate.max_per_checkout_paise) + ' per checkout in ' + esc(k.mandate.allowed_categories.join(', ')) + ' for ' + k.mandate.expires_in_days + ' days. Every checkout still needs a human on the pay page.</span>' +
        '<p><button class="ghost sm" onclick="dl(\\'pem\\',\\'' + esc(k.agent_id) + '.private.pem\\')">Download key</button><button class="ghost sm" onclick="cp(\\'pem\\')">Copy key</button> <button class="ghost sm" onclick="cp(\\'mcp\\')">Copy .mcp.json</button></p>' +
        '<pre id="pem">' + esc(k.private_key_pem) + '</pre><pre id="mcp">' + esc(JSON.stringify(k.mcp.config, null, 2)) + '</pre></div>';
      refresh();
    }
    function cp(id) { navigator.clipboard.writeText(document.getElementById(id).textContent); }
    function dl(id, name) { const a = document.createElement('a'); a.href = URL.createObjectURL(new Blob([document.getElementById(id).textContent])); a.download = name; a.click(); }
    async function approve(id) { await post('/api/console/escalations/'+id+'/approve'); nkToast('Approved, the buyer can now confirm and pay', 'ok'); refresh(); }
    async function deny(id) { await post('/api/console/escalations/'+id+'/deny', {}); nkToast('Denied and cancelled; stock released', 'warn'); refresh(); }
    async function approveRefund(id) { const r = await post('/api/console/refunds/'+id+'/approve'); nkToast(r.razorpay_refund_id ? 'Refund sent to Razorpay: ' + r.razorpay_refund_id : (r.error?.message || 'Refund failed'), r.razorpay_refund_id ? 'ok' : 'bad'); refresh(); }
    async function denyRefund(id) { await post('/api/console/refunds/'+id+'/deny'); nkToast('Refund denied', 'warn'); refresh(); }
    async function agentAction(id, action) { await post('/api/console/agents/'+id+'/'+action); nkToast(action === 'suspend' ? 'Agent suspended, its calls are now denied' : 'Agent activated', action === 'suspend' ? 'warn' : 'ok'); refresh(); }
    async function kill(on) { await post('/api/console/kill-switch', { on }); nkToast(on ? 'Kill switch ON, every new checkout is denied' : 'Kill switch off', on ? 'bad' : 'ok'); refresh(); }
    async function fault() { await post('/api/console/faults/webhook-500', { seconds: 90 }); nkToast('Webhook route will answer 500 for 90 s, watch the reconciler finish the payment anyway', 'warn'); }
    async function clearFault() { await post('/api/console/faults/webhook-500/clear'); nkToast('Webhook fault cleared', 'ok'); }
    async function verify() { const r = await j('/api/console/ledger/verify'); const t = r.ok ? ('Chain OK, ' + r.checked + ' rows verified') : ('TAMPERED at seq ' + r.first_bad_seq); document.getElementById('verifyResult').textContent = t; nkToast(t, r.ok ? 'ok' : 'bad'); }
    async function tamperDemo() { const r = await post('/api/console/ledger/tamper-demo'); nkToast('Row #' + r.tampered_seq + ' was edited outside the app. Now click Verify chain.', 'warn'); refresh(); }
    async function logout() { await post('/console/logout'); location.reload(); }
    refresh(); loadCatalog(); setInterval(refresh, 6000);
  </script></body></html>`;
}
