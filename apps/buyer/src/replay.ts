/** The LLM-free replay buyer. */
import { existsSync, unlinkSync, readFileSync } from "node:fs";
import { randomBytes } from "node:crypto";
import { getDb } from "@naka/db";
import { seedAll } from "../../../cli/seed.js";
import { buildServer } from "@naka/server";
import { verifyLedger } from "@naka/ledger";
import { canonicalJson, sha256hex } from "@naka/shared";
import { signMessage, signingMessage } from "@naka/identity";
import { NakaClient } from "./mcp-client.js";

const DB_PATH = process.env.NAKA_DB ?? "./data/naka.db";
let failures = 0;

function assert(cond: unknown, msg: string): asserts cond {
  if (!cond) {
    failures++;
    console.error(`  ASSERTION FAILED: ${msg}`);
  } else {
    console.log(`  ok ${msg}`);
  }
}

function nonceFromContinueUrl(url: string): string {
  const u = new URL(url);
  const t = u.searchParams.get("t");
  if (!t) throw new Error(`no nonce in continue_url: ${url}`);
  return t;
}

async function confirmPay(baseUrl: string, checkoutId: string, nonce: string) {
  const res = await fetch(`${baseUrl}/api/checkouts/${checkoutId}/confirm`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ nonce }),
  });
  const json = await res.json();
  if (!res.ok) throw new Error(`confirm failed: ${JSON.stringify(json)}`);
  return json as { attemptId: string; razorpayOrderId: string; amountPaise: number; currency: string };
}

async function retryPay(baseUrl: string, checkoutId: string) {
  const res = await fetch(`${baseUrl}/api/checkouts/${checkoutId}/retry`, { method: "POST" });
  const json = await res.json();
  if (!res.ok) throw new Error(`retry failed: ${JSON.stringify(json)}`);
  return json as { attemptId: string; razorpayOrderId: string; amountPaise: number; currency: string };
}

async function simulatePayment(baseUrl: string, orderId: string, result: "captured" | "failed", errorReason?: string) {
  const res = await fetch(`${baseUrl}/api/attempts/${orderId}/simulate`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ result, errorReason }),
  });
  return res.json();
}

async function consoleLogin(baseUrl: string): Promise<string> {
  const password = process.env.CONSOLE_PASSWORD ?? "change-me";
  const res = await fetch(`${baseUrl}/console/login`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ password }),
  });
  const setCookie = res.headers.get("set-cookie");
  if (!setCookie) throw new Error("console login did not set a cookie");
  return setCookie.split(";")[0];
}

async function approveEscalation(baseUrl: string, cookie: string, checkoutId: string) {
  const res = await fetch(`${baseUrl}/api/console/escalations/${checkoutId}/approve`, { method: "POST", headers: { Cookie: cookie } });
  return res.json();
}

/** Signs a request the same way NakaClient does, for hitting the REST wrapper directly rather than through the MCP-shaped /tools/* client. */
function signedHeaders(agentId: string, privateKeyPath: string, tool: string, body: unknown, extra: Record<string, string> = {}): Record<string, string> {
  const privateKeyPem = readFileSync(privateKeyPath, "utf8");
  const ts = Math.floor(Date.now() / 1000);
  const nonce = randomBytes(16).toString("base64url");
  const bodyHash = sha256hex(canonicalJson(body ?? {}));
  const message = signingMessage({ subject: `${agentId}:${tool}`, ts, nonce, bodyHash });
  const sig = signMessage(message, privateKeyPem);
  return { "Content-Type": "application/json", "x-naka-agent": agentId, "x-naka-ts": String(ts), "x-naka-nonce": nonce, "x-naka-sig": sig, ...extra };
}

async function setWebhookFault(baseUrl: string, cookie: string, seconds: number) {
  await fetch(`${baseUrl}/api/console/faults/webhook-500`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Cookie: cookie },
    body: JSON.stringify({ seconds }),
  });
}
async function clearWebhookFault(baseUrl: string, cookie: string) {
  await fetch(`${baseUrl}/api/console/faults/webhook-500/clear`, { method: "POST", headers: { Cookie: cookie } });
}

async function main() {
  console.log("=== Naka replay buyer (no LLM) ===\n");

  for (const suffix of ["", "-wal", "-shm"]) {
    if (existsSync(DB_PATH + suffix)) unlinkSync(DB_PATH + suffix);
  }
  const db = getDb();
  console.log("--- seeding demo merchant (Kaapi Kottai Roasters) ---");
  const seed = seedAll(db);
  console.log(`agents: ${Object.keys(seed.agents).join(", ")}`);

  const { app, close, isRecorded, rzp } = await buildServer();
  await app.listen({ port: Number(process.env.NAKA_PORT ?? 3000), host: "127.0.0.1" });
  const baseUrl = `http://127.0.0.1:${Number(process.env.NAKA_PORT ?? 3000)}`;
  console.log(`server up at ${baseUrl} (RAZORPAY_MODE=${isRecorded ? "recorded" : "real"})\n`);

  const buyer = new NakaClient(baseUrl, seed.agents["buyer-claude"].id, seed.agents["buyer-claude"].privateKeyPath);
  const replayBot = new NakaClient(baseUrl, seed.agents["replay-bot"].id, seed.agents["replay-bot"].privateKeyPath);
  const rogue = new NakaClient(baseUrl, seed.agents["rogue-bot"].id, seed.agents["rogue-bot"].privateKeyPath);
  const suspended = new NakaClient(baseUrl, seed.agents["suspended-bot"].id, seed.agents["suspended-bot"].privateKeyPath);

  // ---------------------------------------------------------------- S1 ---
  console.log("--- S1: in-limit Hinglish purchase with a declined add-on ---");
  console.log('buyer says: "500 gram filter kaapi aur ek steel filter chahiye"');
  const search1 = await buyer.searchCatalog({ query: "filter kaapi", category: "coffee", limit: 5 });
  assert(search1.results?.some((r: any) => r.variant_id === "var_fc8020_500"), "search finds the 500g filter coffee by Hinglish alias");

  const s1 = await buyer.createCheckout({
    mandate_id: seed.mandates.buyer_claude,
    // Deliberately NOT var_filter_2cup here: that variant has stock_qty=1 and is reserved for the S3 last-unit-race scenario below.
    line_items: [{ variant_id: "var_fc8020_500", quantity: 1 }, { variant_id: "var_filter_4cup", quantity: 1 }],
    buyer_ref: "buyer_demo_1",
  });
  assert(s1.decision?.outcome === "ALLOW", `S1 checkout ALLOWed (total ₹${(s1.totals?.total_paise ?? 0) / 100})`);

  const addons1 = await buyer.suggestAddons({ checkout_id: s1.checkout_id });
  assert(Array.isArray(addons1.candidates), "suggest_addons returns a bounded candidate list");
  if (addons1.candidates?.length) {
    console.log(`  agent mentions one add-on: "${addons1.candidates[0].title}" for ₹${addons1.candidates[0].price_paise / 100}, buyer declines`);
  }

  const complete1 = await buyer.completeCheckout({ checkout_id: s1.checkout_id, line_items_hash: s1.line_items_hash });
  assert(!!complete1.continue_url, "complete_checkout returns a continue_url (nonce-gated pay page)");
  const nonce1 = nonceFromContinueUrl(complete1.continue_url);
  const attempt1 = await confirmPay(baseUrl, s1.checkout_id, nonce1);
  assert(!!attempt1.razorpayOrderId, "human confirmation (G1) creates exactly one Razorpay test-mode order");
  await simulatePayment(baseUrl, attempt1.razorpayOrderId, "captured");
  await sleep(150);
  const final1 = await buyer.getCheckout({ checkout_id: s1.checkout_id });
  assert(final1.status === "completed", "S1 checkout reaches 'completed' after payment.captured + order.paid webhooks");

  // ---------------------------------------------------------------- S2 ---
  console.log("\n--- S2: escalated purchase, approved by the merchant ---");
  const s2 = await buyer.createCheckout({
    mandate_id: seed.mandates.buyer_claude,
    line_items: [{ variant_id: "var_gift_box", quantity: 1 }, { variant_id: "var_arabica_250", quantity: 1 }],
    buyer_ref: "buyer_demo_1",
  });
  assert(s2.decision?.outcome === "NEEDS_HUMAN", `S2 checkout escalates (total ₹${(s2.totals?.total_paise ?? 0) / 100} > merchant approval threshold)`);

  const cookie = await consoleLogin(baseUrl);
  await approveEscalation(baseUrl, cookie, s2.checkout_id);
  const complete2 = await buyer.completeCheckout({ checkout_id: s2.checkout_id, line_items_hash: s2.line_items_hash });
  assert(!!complete2.continue_url, "complete_checkout succeeds once the merchant has approved the escalation");
  const nonce2 = nonceFromContinueUrl(complete2.continue_url);
  const attempt2 = await confirmPay(baseUrl, s2.checkout_id, nonce2);
  await simulatePayment(baseUrl, attempt2.razorpayOrderId, "captured");
  await sleep(150);
  const final2 = await buyer.getCheckout({ checkout_id: s2.checkout_id });
  assert(final2.status === "completed", "S2 checkout completes after approval + payment");

  // ---------------------------------------------------------------- extra: bounds ---
  console.log("\n--- extra: bounds that must hold regardless of the model ---");
  const overMandate = await rogue.createCheckout({ mandate_id: seed.mandates.rogue_bot, line_items: [{ variant_id: "var_fc8020_500", quantity: 1 }], buyer_ref: "rogue" });
  assert(overMandate.decision?.outcome === "DENY", "rogue-bot's tiny mandate correctly DENIES a ₹649 cart (B3_MANDATE_AMOUNT)");

  const offCategory = await buyer.createCheckout({ mandate_id: seed.mandates.buyer_claude, line_items: [{ variant_id: "var_jaggery_500", quantity: 1 }], buyer_ref: "buyer_demo_1" });
  assert(offCategory.decision?.outcome === "DENY", "grocery item outside the mandate's allowed categories is DENIED (B5_MANDATE_SCOPE)");

  const expiredMandate = await buyer.createCheckout({ mandate_id: seed.mandates.expired, line_items: [{ variant_id: "var_fc8020_250", quantity: 1 }], buyer_ref: "buyer_demo_1" });
  assert(expiredMandate.decision?.outcome === "DENY", "an expired mandate is DENIED (B4_MANDATE_EXPIRY)");

  const suspendedAttempt = await suspended.createCheckout({ mandate_id: seed.mandates.buyer_claude, line_items: [{ variant_id: "var_fc8020_250", quantity: 1 }], buyer_ref: "x" });
  assert(suspendedAttempt.decision?.outcome === "DENY" || suspendedAttempt.error, "a suspended agent cannot create a checkout (A2_AGENT_ACTIVE)");

  const outOfStock = await buyer.createCheckout({ mandate_id: seed.mandates.buyer_claude, line_items: [{ variant_id: "var_peaberry_500", quantity: 1 }], buyer_ref: "buyer_demo_1" });
  assert(outOfStock.decision?.outcome === "DENY", "an out-of-stock variant is DENIED (S1_STOCK)");

  // ---------------------------------------------------------------- S3 ---
  console.log("\n--- S3: the engineered failure (last unit race, failed payment, retry, webhook outage, reconciliation) ---");
  const s3 = await buyer.createCheckout({ mandate_id: seed.mandates.buyer_claude, line_items: [{ variant_id: "var_filter_2cup", quantity: 1 }], buyer_ref: "buyer_demo_1" });
  assert(s3.decision?.outcome === "ALLOW", "buyer-claude reserves the last steel filter (stock_qty=1)");

  const race = await replayBot.createCheckout({ mandate_id: seed.mandates.replay_bot, line_items: [{ variant_id: "var_filter_2cup", quantity: 1 }], buyer_ref: "buyer_demo_replay" });
  assert(race.decision?.outcome === "DENY" && race.decision.rule_hits.some((h: any) => h.rule_id === "S1_STOCK" && !h.passed), "a second agent racing for the same last unit is DENIED (S1_STOCK)");

  const complete3 = await buyer.completeCheckout({ checkout_id: s3.checkout_id, line_items_hash: s3.line_items_hash });
  const nonce3 = nonceFromContinueUrl(complete3.continue_url);
  const attempt3a = await confirmPay(baseUrl, s3.checkout_id, nonce3);
  await simulatePayment(baseUrl, attempt3a.razorpayOrderId, "failed", "payment_failed");
  await sleep(150);
  const afterFail = await buyer.getCheckout({ checkout_id: s3.checkout_id });
  assert(afterFail.last_payment?.status === "failed", "payment.failed is recorded; checkout stays complete_in_progress (order created, not paid, nothing charged)");
  assert(afterFail.last_payment?.retries_remaining > 0, "a retry is still available");

  console.log("  buyer retries with a NEW Razorpay order on the SAME checkout...");
  const attempt3b = await retryPay(baseUrl, s3.checkout_id);
  assert(attempt3b.razorpayOrderId !== attempt3a.razorpayOrderId, "the retry creates a brand-new Razorpay order (never reuses a failed order id)");

  console.log("  merchant flips the webhook-500 fault toggle for 3s to prove reconciliation...");
  await setWebhookFault(baseUrl, cookie, 3);
  await simulatePayment(baseUrl, attempt3b.razorpayOrderId, "captured"); // this webhook delivery gets 500'd and is NOT applied
  await sleep(200);
  const stillOpen = await buyer.getCheckout({ checkout_id: s3.checkout_id });
  assert(stillOpen.status !== "completed", "while the webhook endpoint is down, the checkout has NOT silently completed");

  // Reconcile directly against Razorpay's payments-for-order truth, exactly as the scheduled reconciler would once the fault window passes.
  const { reconcileAttempt } = await import("@naka/server/reconcile");
  const attemptRow = db.prepare("SELECT id FROM payment_attempts WHERE razorpay_order_id = ?").get(attempt3b.razorpayOrderId) as { id: string };
  await reconcileAttempt(db, () => rzp, attemptRow.id);
  await clearWebhookFault(baseUrl, cookie);

  const reconciled = await buyer.getCheckout({ checkout_id: s3.checkout_id });
  assert(reconciled.status === "completed", "the reconciler independently confirms the same captured payment and completes the checkout exactly once");

  await sleep(50);
  const orderCount = db.prepare("SELECT COUNT(*) AS n FROM payment_attempts WHERE checkout_id = ?").get(s3.checkout_id) as { n: number };
  assert(orderCount.n === 2, "exactly two Razorpay orders exist for this checkout, one per attempt, never a duplicate");
  const capturedCount = db
    .prepare("SELECT COUNT(*) AS n FROM rzp_payments WHERE checkout_id = ? AND role='primary' AND status='captured'")
    .get(s3.checkout_id) as { n: number };
  assert(capturedCount.n === 1, "exactly one primary captured payment exists for the checkout");

  // ---------------------------------------------------------------- S4 ---
  console.log("\n--- S4: the REST wrapper (Idempotency-Key) and the Payment Link fallback ---");
  const buyerAgentId = seed.agents["buyer-claude"].id;
  const buyerKeyPath = seed.agents["buyer-claude"].privateKeyPath;
  const idemKey = "idem-" + Date.now().toString(36);
  const s4Body = { mandate_id: seed.mandates.buyer_claude, line_items: [{ variant_id: "var_arabica_250", quantity: 1 }], buyer_ref: "buyer_demo_1" };

  const create1Res = await fetch(`${baseUrl}/checkout-sessions`, {
    method: "POST",
    headers: signedHeaders(buyerAgentId, buyerKeyPath, "create_checkout", s4Body, { "Idempotency-Key": idemKey }),
    body: JSON.stringify(s4Body),
  });
  const s4 = (await create1Res.json()) as any;
  assert(create1Res.status === 200 && s4.decision?.outcome === "ALLOW", "POST /checkout-sessions (REST wrapper) creates a checkout via the same engine as /tools/create_checkout");

  const create2Res = await fetch(`${baseUrl}/checkout-sessions`, {
    method: "POST",
    headers: signedHeaders(buyerAgentId, buyerKeyPath, "create_checkout", s4Body, { "Idempotency-Key": idemKey }),
    body: JSON.stringify(s4Body),
  });
  const s4Replayed = (await create2Res.json()) as any;
  assert(create2Res.status === 200 && s4Replayed.checkout_id === s4.checkout_id, "the same Idempotency-Key + same body replays the cached response (same checkout_id, no second checkout created)");
  const checkoutCountForRef = db.prepare("SELECT COUNT(*) AS n FROM checkouts WHERE buyer_ref = 'buyer_demo_1' AND id = ?").get(s4.checkout_id) as { n: number };
  assert(checkoutCountForRef.n === 1, "exactly one checkout row exists despite the replayed request");

  const conflictBody = { ...s4Body, line_items: [{ variant_id: "var_arabica_250", quantity: 2 }] };
  const conflictRes = await fetch(`${baseUrl}/checkout-sessions`, {
    method: "POST",
    headers: signedHeaders(buyerAgentId, buyerKeyPath, "create_checkout", conflictBody, { "Idempotency-Key": idemKey }),
    body: JSON.stringify(conflictBody),
  });
  const conflictJson = (await conflictRes.json()) as any;
  assert(conflictRes.status === 409 && conflictJson.error?.code === "IDEMPOTENCY_KEY_CONFLICT", "reusing the same Idempotency-Key with a DIFFERENT body is a 409, not silently applied");

  const complete4Res = await fetch(`${baseUrl}/checkout-sessions/${s4.checkout_id}/complete`, {
    method: "POST",
    headers: signedHeaders(buyerAgentId, buyerKeyPath, "complete_checkout", { checkout_id: s4.checkout_id, line_items_hash: s4.line_items_hash }),
    body: JSON.stringify({ checkout_id: s4.checkout_id, line_items_hash: s4.line_items_hash }),
  });
  const complete4 = (await complete4Res.json()) as any;
  assert(!!complete4.continue_url, "complete via the REST wrapper also returns a nonce-gated continue_url");
  const nonce4 = nonceFromContinueUrl(complete4.continue_url);

  const linkRes = await fetch(`${baseUrl}/api/checkouts/${s4.checkout_id}/send-payment-link`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ nonce: nonce4 }),
  });
  const link = (await linkRes.json()) as any;
  assert(linkRes.ok && !!link.shortUrl, "the Payment Link fallback creates a real (recorded-mode) link instead of opening Checkout.js");

  await fetch(`${baseUrl}/api/links/${link.plinkId}/simulate`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ result: "captured" }) });
  await sleep(150);
  const s4Final = await buyer.getCheckout({ checkout_id: s4.checkout_id });
  assert(s4Final.status === "completed", "the checkout completes via payment_link.paid through the identical completion path as Checkout.js orders");

  const linkBudget = db.prepare("SELECT used FROM link_budget WHERE merchant_id = ?").get(seed.merchant_id) as { used: number };
  assert(linkBudget.used === 1, "the payment-link budget counter is incremented (1 of the 30-per-business test-mode cap used)");

  // ---------------------------------------------------------------- ledger ---
  console.log("\n--- ledger integrity ---");
  const v = verifyLedger(db);
  assert(v.ok, `hash-chained ledger verifies clean across ${v.checked} rows`);

  console.log(`\n${failures === 0 ? "ALL SCENARIOS PASSED" : `${failures} ASSERTION(S) FAILED`}\n`);
  await close();
  process.exit(failures === 0 ? 0 : 1);
}

function sleep(ms: number) {
  return new Promise((r) => setTimeout(r, ms));
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
