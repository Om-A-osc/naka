import type { Db } from "@naka/db";
import type { RazorpayClient } from "@naka/razorpay";
import { rzpErrorDescription } from "@naka/razorpay";
import { insertLedgerRow } from "@naka/ledger";
import { newId, referenceIdFor } from "@naka/shared";
import { currentPolicy, confirmNonce, merchantDisplayName, policyFor } from "@naka/engine";
import { ExecutorError } from "./orders.js";

const LINK_TTL_SECONDS = 1800; // 30 min; Razorpay requires >= 15 min ahead

/** Ensures a merchant has a link_budget row (idempotent), defaulting to the documented test-mode cap of 30 with 10 held in reserve. */
export function ensureLinkBudget(db: Db, merchantId: string, total = 30, reserve = 10): void {
  db.prepare(`INSERT OR IGNORE INTO link_budget (merchant_id, total, reserve, used) VALUES (?, ?, ?, 0)`).run(merchantId, total, reserve);
}

export function linkBudgetRemaining(db: Db, merchantId: string): number {
  const row = db.prepare("SELECT total, reserve, used FROM link_budget WHERE merchant_id = ?").get(merchantId) as
    | { total: number; reserve: number; used: number }
    | undefined;
  if (!row) return 0;
  return Math.max(0, row.total - row.reserve - row.used);
}

/** The Payment Link fallback: for a channel without a browser handoff, issues a standard link instead of opening Checkout.js. */
export async function sendPaymentLink(
  db: Db,
  rzp: RazorpayClient,
  args: { checkoutId: string; nonce: string; merchantId: string }
): Promise<{ shortUrl: string; plinkId: string; referenceId: string }> {
  const confirmed = confirmNonce(db, { checkoutId: args.checkoutId, nonce: args.nonce });
  if (!confirmed.ok) throw new ExecutorError(confirmed.reason ?? "NONCE_INVALID");

  ensureLinkBudget(db, args.merchantId);
  const remaining = linkBudgetRemaining(db, args.merchantId);
  if (remaining <= 0) throw new ExecutorError("LINK_BUDGET_EXHAUSTED", "Payment link budget exhausted for this test-mode account");

  const checkout = db.prepare("SELECT total_paise, agent_id, mandate_id FROM checkouts WHERE id = ?").get(args.checkoutId) as
    | { total_paise: number; agent_id: string; mandate_id: string }
    | undefined;
  if (!checkout) throw new ExecutorError("NOT_FOUND");

  const { policy } = policyFor(db, args.merchantId);
  const attemptCount = (db.prepare("SELECT COUNT(*) AS n FROM payment_attempts WHERE checkout_id = ?").get(args.checkoutId) as { n: number }).n;
  if (attemptCount >= policy.max_payment_attempts) throw new ExecutorError("MAX_ATTEMPTS");

  const attemptNo = attemptCount + 1;
  const attemptId = newId("att");
  const referenceId = referenceIdFor(args.checkoutId, attemptNo);
  const expiresAt = Math.floor(Date.now() / 1000) + LINK_TTL_SECONDS;

  db.prepare(
    `INSERT INTO payment_attempts (id, checkout_id, attempt_no, kind, status, status_rank, receipt, reference_id, amount_paise, currency, expires_at)
     VALUES (?, ?, ?, 'link', 'created', 0, ?, ?, ?, 'INR', ?)`
  ).run(attemptId, args.checkoutId, attemptNo, `linkrcpt-${referenceId}`, referenceId, checkout.total_paise, expiresAt);

  let link;
  try {
    link = await rzp.paymentLinks.create({
      amount: checkout.total_paise,
      currency: "INR",
      reference_id: referenceId,
      description: `${merchantDisplayName(db, args.merchantId)} order`,
      expire_by: expiresAt,
      notes: { checkout_id: args.checkoutId, attempt_no: String(attemptNo), mandate_id: checkout.mandate_id, agent_id: checkout.agent_id },
    });
  } catch (err) {
    insertLedgerRow(db, { actor: "executor", action: "PAYMENT_LINK_ERROR", checkout_id: args.checkoutId, attempt_id: attemptId, inputs: { description: rzpErrorDescription(err) } });
    throw new ExecutorError("RAZORPAY_ERROR", rzpErrorDescription(err));
  }

  db.prepare(`UPDATE payment_attempts SET status='opened', opened_at=strftime('%Y-%m-%dT%H:%M:%fZ','now') WHERE id=?`).run(attemptId);
  db.prepare(
    `INSERT INTO payment_links (plink_id, attempt_id, reference_id, short_url, status, amount, amount_paid, razorpay_order_id, expire_by)
     VALUES (?, ?, ?, ?, ?, ?, 0, ?, ?)`
  ).run(link.id, attemptId, referenceId, link.short_url, link.status, link.amount, link.order_id, link.expire_by);
  db.prepare(`UPDATE link_budget SET used = used + 1 WHERE merchant_id = ?`).run(args.merchantId);

  insertLedgerRow(db, { actor: "executor", action: "PAYMENT_LINK_SENT", checkout_id: args.checkoutId, attempt_id: attemptId, amount_paise: checkout.total_paise });

  return { shortUrl: link.short_url, plinkId: link.id, referenceId };
}
