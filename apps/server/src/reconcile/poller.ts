import type { Db } from "@naka/db";
import type { RazorpayClient } from "@naka/razorpay";
import { onPaymentAuthorized, onPaymentCaptured, onPaymentFailed } from "@naka/engine";
import { insertLedgerRow } from "@naka/ledger";

/** The reconciler: for any payment attempt that has an open Razorpay order but no terminal state yet. */
export type RzpResolver = (merchantId: string) => RazorpayClient;

export async function reconcileAttempt(db: Db, rzpFor: RzpResolver, attemptId: string): Promise<void> {
  const attempt = db.prepare("SELECT a.*, c.merchant_id FROM payment_attempts a JOIN checkouts c ON c.id = a.checkout_id WHERE a.id = ?").get(attemptId) as
    | { id: string; razorpay_order_id: string | null; status: string; merchant_id: string }
    | undefined;
  if (!attempt || !attempt.razorpay_order_id) return;
  const rzp = rzpFor(attempt.merchant_id);
  if (rzp.mode !== "real") return; // a recorded tenant has nothing to poll
  // Only worth polling an attempt that has an order but no settled truth yet.
  const worthPolling = new Set(["opened", "authorized", "failed"]);
  if (!worthPolling.has(attempt.status)) return;

  try {
    const payments = await rzp.orders.fetchPayments(attempt.razorpay_order_id);
    for (const p of payments) {
      if (p.status === "captured") onPaymentCaptured(db, p, "reconcile");
      else if (p.status === "authorized") onPaymentAuthorized(db, p, "reconcile");
      else if (p.status === "failed") onPaymentFailed(db, p, "reconcile");
    }
    insertLedgerRow(db, { actor: "reconciler", action: "RECONCILED_BY_POLL", attempt_id: attemptId, razorpay_order_id: attempt.razorpay_order_id });
  } catch (err) {
    insertLedgerRow(db, { actor: "reconciler", action: "RECONCILE_ERROR", attempt_id: attemptId, inputs: { error: String(err) } });
  }
}

/** Reconciles every attempt still open across all checkouts, called on an interval by the long-running server. */
export async function reconcileAllOpen(db: Db, rzpFor: RzpResolver): Promise<void> {
  const open = db
    .prepare(`SELECT id FROM payment_attempts WHERE status IN ('opened','authorized') AND razorpay_order_id IS NOT NULL`)
    .all() as Array<{ id: string }>;
  for (const a of open) await reconcileAttempt(db, rzpFor, a.id);
}

export function startReconcileLoop(db: Db, rzpFor: RzpResolver, intervalMs = 30_000): NodeJS.Timeout {
  return setInterval(() => {
    reconcileAllOpen(db, rzpFor).catch(() => {});
  }, intervalMs);
}
