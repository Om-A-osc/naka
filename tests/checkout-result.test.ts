import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { existsSync, unlinkSync } from "node:fs";

/** Covers the Checkout.js result endpoint, whose whole job is to decide whether to believe the browser's claim that a payment succeeded. */
const DB_PATH = "./data/test-checkout-result.db";
const PORT = 34119;
const KEY_SECRET = "test_secret_for_signing";

let close: () => Promise<void>;
let db: import("better-sqlite3").Database;
let baseUrl: string;
let seed: any;
let signCheckoutPayload: (orderId: string, paymentId: string, secret: string) => string;

/** Drives a real checkout to the point where a Razorpay order exists. */
async function openAttempt(): Promise<{ checkoutId: string; razorpayOrderId: string }> {
  const { NakaClient } = await import("../apps/buyer/src/mcp-client.js");
  const client: any = new NakaClient(baseUrl, seed.agents["buyer-claude"].id, seed.agents["buyer-claude"].privateKeyPath);

  const checkout = await client.createCheckout({
    mandate_id: seed.mandates.buyer_claude,
    line_items: [{ variant_id: "var_fc8020_250", quantity: 1 }],
    buyer_ref: "sig_test_buyer",
  });
  const completed = await client.completeCheckout({ checkout_id: checkout.checkout_id, line_items_hash: checkout.line_items_hash });
  const nonce = new URL(completed.continue_url).searchParams.get("t")!;
  const res = await fetch(`${baseUrl}/api/checkouts/${checkout.checkout_id}/confirm`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ nonce }),
  });
  const attempt = (await res.json()) as { razorpayOrderId: string };
  return { checkoutId: checkout.checkout_id, razorpayOrderId: attempt.razorpayOrderId };
}

beforeAll(async () => {
  for (const suffix of ["", "-wal", "-shm"]) if (existsSync(DB_PATH + suffix)) unlinkSync(DB_PATH + suffix);
  process.env.NAKA_DB = DB_PATH;
  process.env.NAKA_PORT = String(PORT);
  process.env.RAZORPAY_MODE = "recorded";
  process.env.RAZORPAY_KEY_ID = "rzp_test_fake";
  process.env.RAZORPAY_KEY_SECRET = KEY_SECRET;
  process.env.CONSOLE_PASSWORD = "test-password";
  process.env.NAKA_BASE_URL = `http://127.0.0.1:${PORT}`;
  process.env.RAZORPAY_WEBHOOK_SECRET = "test-webhook-secret";

  const { getDb } = await import("@naka/db");
  const { seedAll } = await import("../cli/seed.js");
  const { buildServer } = await import("@naka/server");
  ({ signCheckoutPayload } = await import("@naka/razorpay"));

  db = getDb();
  seed = seedAll(db);
  const built = await buildServer();
  await built.app.listen({ port: PORT, host: "127.0.0.1" });
  close = built.close;
  baseUrl = `http://127.0.0.1:${PORT}`;
});

afterAll(async () => {
  await close();
});

async function post(orderId: string, body: unknown) {
  const res = await fetch(`${baseUrl}/api/attempts/${orderId}/checkout-result`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  return { status: res.status, body: (await res.json()) as any };
}

describe("POST /api/attempts/:orderId/checkout-result", () => {
  it("rejects a forged signature and leaves the attempt untouched", async () => {
    const { checkoutId, razorpayOrderId } = await openAttempt();
    const before = db.prepare("SELECT status FROM payment_attempts WHERE razorpay_order_id = ?").get(razorpayOrderId) as { status: string };

    const res = await post(razorpayOrderId, {
      razorpay_order_id: razorpayOrderId,
      razorpay_payment_id: "pay_forged",
      razorpay_signature: "f".repeat(64),
    });
    expect(res.status).toBe(401);
    expect(res.body.error.code).toBe("BAD_SIGNATURE");

    // The forged claim must not have advanced anything.
    const after = db.prepare("SELECT status FROM payment_attempts WHERE razorpay_order_id = ?").get(razorpayOrderId) as { status: string };
    expect(after.status).toBe(before.status);
    const checkout = db.prepare("SELECT status FROM checkouts WHERE id = ?").get(checkoutId) as { status: string };
    expect(checkout.status).not.toBe("completed");

    const rejected = db.prepare("SELECT COUNT(*) AS n FROM ledger WHERE action = 'CHECKOUT_RESULT_REJECTED'").get() as { n: number };
    expect(rejected.n).toBeGreaterThan(0);
  });

  it("accepts a correctly signed result and settles the checkout from it", async () => {
    const { checkoutId, razorpayOrderId } = await openAttempt();

    // Produce a real payment against the order the way the recorded client would, then hand its id back exactly as Checkout.js's handler does.
    await fetch(`${baseUrl}/api/attempts/${razorpayOrderId}/simulate`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ result: "captured" }),
    });
    const payment = db
      .prepare("SELECT razorpay_payment_id FROM rzp_payments WHERE razorpay_order_id = ? ORDER BY rowid DESC LIMIT 1")
      .get(razorpayOrderId) as { razorpay_payment_id: string };

    const res = await post(razorpayOrderId, {
      razorpay_order_id: razorpayOrderId,
      razorpay_payment_id: payment.razorpay_payment_id,
      razorpay_signature: signCheckoutPayload(razorpayOrderId, payment.razorpay_payment_id, KEY_SECRET),
    });
    expect(res.status).toBe(200);
    expect(res.body.ok).toBe(true);

    const checkout = db.prepare("SELECT status FROM checkouts WHERE id = ?").get(checkoutId) as { status: string };
    expect(checkout.status).toBe("completed");

    const verified = db.prepare("SELECT COUNT(*) AS n FROM ledger WHERE action = 'CHECKOUT_RESULT_VERIFIED'").get() as { n: number };
    expect(verified.n).toBeGreaterThan(0);
  });

  it("the same capture arriving again by webhook and by reconciler confirms the order and never queues a refund", async () => {
    const { checkoutId, razorpayOrderId } = await openAttempt();
    await fetch(`${baseUrl}/api/attempts/${razorpayOrderId}/simulate`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ result: "captured" }) });
    const row = db.prepare("SELECT * FROM rzp_payments WHERE razorpay_order_id = ? ORDER BY rowid DESC LIMIT 1").get(razorpayOrderId) as any;
    const paymentId = row.razorpay_payment_id as string;

    // 1) Checkout.js result: the browser's claim, verified and settled from the API.
    const first = await post(razorpayOrderId, { razorpay_order_id: razorpayOrderId, razorpay_payment_id: paymentId, razorpay_signature: signCheckoutPayload(razorpayOrderId, paymentId, KEY_SECRET) });
    expect(first.status).toBe(200);
    expect((db.prepare("SELECT status FROM checkouts WHERE id = ?").get(checkoutId) as any).status).toBe("completed");

    // 2) The webhook for the very same payment, as Razorpay sends it moments later.
    const { signWebhookBody, webhookSecrets } = await import("@naka/razorpay");
    const snapshot = { id: paymentId, entity: "payment", order_id: razorpayOrderId, status: "captured", captured: true, amount: row.amount, currency: "INR", method: "card", created_at: Math.floor(Date.now() / 1000) };
    const payload = JSON.stringify({ event: "payment.captured", payload: { payment: { entity: snapshot } } });
    const hook = await fetch(`${baseUrl}/webhooks/razorpay`, {
      method: "POST",
      headers: { "Content-Type": "application/json", "X-Razorpay-Signature": signWebhookBody(payload, webhookSecrets()[0]), "X-Razorpay-Event-Id": `evt_dup_${paymentId}` },
      body: payload,
    });
    expect(hook.status).toBe(200);

    // 3) The reconciler, polling the same payment a third time.
    const { onPaymentCaptured } = await import("@naka/engine");
    onPaymentCaptured(db, snapshot as any, "reconcile");

    expect((db.prepare("SELECT COUNT(*) AS n FROM refunds WHERE checkout_id = ?").get(checkoutId) as any).n).toBe(0);
    expect((db.prepare("SELECT COUNT(*) AS n FROM rzp_payments WHERE checkout_id = ?").get(checkoutId) as any).n).toBe(1);
    expect((db.prepare("SELECT role FROM rzp_payments WHERE razorpay_payment_id = ?").get(paymentId) as any).role).toBe("primary");
    const actions = (db.prepare("SELECT action FROM ledger WHERE checkout_id = ? ORDER BY seq").all(checkoutId) as any[]).map((r) => r.action);
    expect(actions).not.toContain("SURPLUS_PAYMENT_CAPTURED");
    expect(actions.filter((a) => a === "PAYMENT_CAPTURE_CONFIRMED").length).toBeGreaterThanOrEqual(2);
    expect((db.prepare("SELECT status FROM checkouts WHERE id = ?").get(checkoutId) as any).status).toBe("completed");
  });

  it("rejects a signature that is valid for a different order", async () => {
    // A real signature is still only valid for the pair it was issued for: replaying one order's signature against another must not pass.
    const good = signCheckoutPayload("order_AAA", "pay_AAA", KEY_SECRET);
    const res = await post("order_BBB", {
      razorpay_order_id: "order_BBB",
      razorpay_payment_id: "pay_AAA",
      razorpay_signature: good,
    });
    expect([401, 404]).toContain(res.status);
    expect(res.body.ok).toBeUndefined();
  });

  it("rejects a body whose signed order does not match the path", async () => {
    const res = await post("order_IN_PATH", {
      razorpay_order_id: "order_IN_BODY",
      razorpay_payment_id: "pay_x",
      razorpay_signature: signCheckoutPayload("order_IN_BODY", "pay_x", KEY_SECRET),
    });
    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe("ORDER_MISMATCH");
  });

  it("rejects an incomplete body", async () => {
    const res = await post("order_x", { razorpay_order_id: "order_x" });
    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe("INVALID_ARGUMENT");
  });
});
