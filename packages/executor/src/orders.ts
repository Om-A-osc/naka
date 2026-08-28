import type { Db } from "@naka/db";
import type { RazorpayClient } from "@naka/razorpay";
import { rzpErrorDescription, DUPLICATE_RECEIPT_PREFIX } from "@naka/razorpay";
import { confirmNonce, cancelCheckout, currentPolicy, loadOfferConfig, verifyOfferApplied, policyFor } from "@naka/engine";
import { ensureRazorpayCustomer } from "./customers.js";
import { insertLedgerRow } from "@naka/ledger";
import { newId, receiptFor } from "@naka/shared";

export class ExecutorError extends Error {
  constructor(public code: string, message?: string) {
    super(message ?? code);
  }
}

interface AttemptStart {
  attemptId: string;
  attemptNo: number;
  receipt: string;
  amountPaise: number;
  currency: string;
}

function startAttempt(db: Db, checkoutId: string): AttemptStart {
  const checkout = db.prepare("SELECT * FROM checkouts WHERE id = ?").get(checkoutId) as any;
  if (!checkout) throw new ExecutorError("NOT_FOUND");
  const { policy } = policyFor(db, checkout.merchant_id);

  const attemptCount = (db.prepare("SELECT COUNT(*) AS n FROM payment_attempts WHERE checkout_id = ?").get(checkoutId) as { n: number }).n;
  if (attemptCount >= policy.max_payment_attempts) {
    cancelCheckout(db, { checkoutId, reason: "max_payment_attempts_exceeded" });
    throw new ExecutorError("MAX_ATTEMPTS", "attempt cap reached; checkout canceled and stock released");
  }

  const attemptNo = attemptCount + 1;
  const attemptId = newId("att");
  const receipt = receiptFor(checkoutId, attemptNo);
  const expiresAt = Math.floor(Date.now() / 1000) + 1200; // 20 min to complete this specific attempt

  db.prepare(
    `INSERT INTO payment_attempts (id, checkout_id, attempt_no, kind, status, status_rank, receipt, amount_paise, currency, expires_at)
     VALUES (?, ?, ?, 'checkout', 'created', 0, ?, ?, 'INR', ?)`
  ).run(attemptId, checkoutId, attemptNo, receipt, checkout.total_paise, expiresAt);

  return { attemptId, attemptNo, receipt, amountPaise: checkout.total_paise, currency: "INR" };
}

function lastLedgerHash(db: Db): string {
  const row = db.prepare("SELECT hash FROM ledger ORDER BY seq DESC LIMIT 1").get() as { hash: string } | undefined;
  return row?.hash ?? "0".repeat(64);
}

async function createAttemptAndOrder(db: Db, rzp: RazorpayClient, checkoutId: string): Promise<{
  attemptId: string;
  razorpayOrderId: string;
  amountPaise: number;
  currency: string;
  razorpayCustomerId: string | null;
}> {
  const checkout = db.prepare("SELECT mandate_id, agent_id, buyer_ref FROM checkouts WHERE id = ?").get(checkoutId) as {
    mandate_id: string;
    agent_id: string;
    buyer_ref: string;
  };
  const attempt = startAttempt(db, checkoutId);
  const razorpayCustomerId = await ensureRazorpayCustomer(db, rzp, checkout.buyer_ref);

  const notes = {
    checkout_id: checkoutId,
    attempt_no: String(attempt.attemptNo),
    mandate_id: checkout.mandate_id,
    agent_id: checkout.agent_id,
    ledger_head: lastLedgerHash(db),
  };

  const offerCfg = loadOfferConfig();

  let order;
  try {
    order = await rzp.orders.create({
      amount: attempt.amountPaise,
      currency: attempt.currency,
      receipt: attempt.receipt,
      notes,
      partial_payment: false,
      ...(offerCfg.dashboard_offer_id ? { offers: [offerCfg.dashboard_offer_id], force_offer: true } : {}),
    });
  } catch (err) {
    const desc = rzpErrorDescription(err);
    if (desc.startsWith(DUPLICATE_RECEIPT_PREFIX)) {
      const matches = await rzp.orders.fetchByReceipt(attempt.receipt);
      const match = matches.find((o) => o.amount === attempt.amountPaise && o.currency === attempt.currency);
      if (!match) throw new ExecutorError("DUPLICATE_RECEIPT_UNRESOLVED", desc);
      order = match;
      insertLedgerRow(db, { actor: "executor", action: "DUPLICATE_RECEIPT_RECOVERED", checkout_id: checkoutId, attempt_id: attempt.attemptId, razorpay_order_id: order.id });
    } else {
      insertLedgerRow(db, { actor: "executor", action: "RAZORPAY_ORDER_ERROR", checkout_id: checkoutId, attempt_id: attempt.attemptId, inputs: { description: desc } });
      throw new ExecutorError("RAZORPAY_ERROR", desc);
    }
  }

  db.prepare(
    `UPDATE payment_attempts SET status='opened', status_rank=1, razorpay_order_id=?, opened_at=strftime('%Y-%m-%dT%H:%M:%fZ','now') WHERE id=?`
  ).run(order.id, attempt.attemptId);
  db.prepare(
    `INSERT INTO rzp_orders (razorpay_order_id, attempt_id, status, amount, amount_paid, amount_due, attempts, receipt, notes, created_at_rzp)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT(razorpay_order_id) DO UPDATE SET status=excluded.status, amount_paid=excluded.amount_paid, amount_due=excluded.amount_due, attempts=excluded.attempts`
  ).run(order.id, attempt.attemptId, order.status, order.amount, order.amount_paid, order.amount_due, order.attempts, order.receipt, JSON.stringify(order.notes), order.created_at);
  db.prepare(`UPDATE checkouts SET attempts = attempts + 1 WHERE id = ?`).run(checkoutId);

  insertLedgerRow(db, {
    actor: "executor",
    action: "ORDER_CREATED",
    checkout_id: checkoutId,
    attempt_id: attempt.attemptId,
    razorpay_order_id: order.id,
    amount_paise: order.amount,
  });

  if (offerCfg.dashboard_offer_id) {
    const verification = verifyOfferApplied(offerCfg, order.amount, order.amount_due);
    insertLedgerRow(db, {
      actor: "executor",
      action: verification.applied ? "OFFER_APPLIED" : "OFFER_NOT_APPLIED",
      checkout_id: checkoutId,
      attempt_id: attempt.attemptId,
      razorpay_order_id: order.id,
      inputs: { offer_id: offerCfg.dashboard_offer_id, expected_amount_due: verification.expectedAmountDue, actual_amount_due: verification.actualAmountDue },
    });
  }

  return { attemptId: attempt.attemptId, razorpayOrderId: order.id, amountPaise: order.amount, currency: order.currency, razorpayCustomerId };
}

/** The FIRST payment attempt on a checkout. */
export async function confirmAndPay(db: Db, rzp: RazorpayClient, args: { checkoutId: string; nonce: string }) {
  const confirmed = confirmNonce(db, args);
  if (!confirmed.ok) throw new ExecutorError(confirmed.reason ?? "NONCE_INVALID");
  return createAttemptAndOrder(db, rzp, args.checkoutId);
}

/** A retry after a failed/expired attempt on the SAME checkout. */
export async function retryPayment(db: Db, rzp: RazorpayClient, args: { checkoutId: string }) {
  const checkout = db.prepare("SELECT status FROM checkouts WHERE id = ?").get(args.checkoutId) as { status: string } | undefined;
  if (!checkout) throw new ExecutorError("NOT_FOUND");
  if (checkout.status !== "complete_in_progress") throw new ExecutorError("STATE_CONFLICT", "checkout is not awaiting payment");
  return createAttemptAndOrder(db, rzp, args.checkoutId);
}

/** Server-side fallback used right after the Checkout handler fires, treated as a HINT, never a completion signal on its own. */
export async function fetchPaymentHint(rzp: RazorpayClient, razorpayPaymentId: string) {
  return rzp.payments.fetch(razorpayPaymentId);
}
