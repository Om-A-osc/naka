import type { Db } from "@naka/db";
import type { RazorpayClient } from "@naka/razorpay";
import { rzpErrorDescription } from "@naka/razorpay";
import { hasValidRefundApproval } from "@naka/engine";
import { insertLedgerRow } from "@naka/ledger";
import { ExecutorError } from "./orders.js";

/** Step 3 of the refund gate: EXECUTE. */
export async function executeRefund(db: Db, rzp: RazorpayClient, args: { refundId: string; token: string }) {
  const refund = db.prepare("SELECT * FROM refunds WHERE id = ?").get(args.refundId) as any;
  if (!refund) throw new ExecutorError("NOT_FOUND");
  if (refund.status !== "approved") throw new ExecutorError("NEEDS_APPROVAL");
  if (!hasValidRefundApproval(db, args.refundId, args.token)) throw new ExecutorError("APPROVAL_INVALID_OR_EXPIRED");

  let result;
  try {
    result = await rzp.refunds.create(refund.razorpay_payment_id, {
      amount: refund.amount_paise ?? undefined,
      speed: "optimum",
      notes: { checkout_id: refund.checkout_id, refund_id: refund.id },
      receipt: refund.receipt,
      idempotencyKey: refund.idempotency_key,
    });
  } catch (err) {
    insertLedgerRow(db, { actor: "executor", action: "REFUND_ERROR", checkout_id: refund.checkout_id, inputs: { description: rzpErrorDescription(err) } });
    throw new ExecutorError("RAZORPAY_ERROR", rzpErrorDescription(err));
  }

  db.prepare(`UPDATE refunds SET status='submitted', razorpay_refund_id=?, speed_requested=? WHERE id=?`).run(result.id, result.speed_requested, refund.id);
  insertLedgerRow(db, {
    actor: "executor",
    action: "REFUND_SUBMITTED",
    checkout_id: refund.checkout_id,
    razorpay_refund_id: result.id,
    razorpay_payment_id: refund.razorpay_payment_id,
    amount_paise: result.amount,
  });
  return result;
}
