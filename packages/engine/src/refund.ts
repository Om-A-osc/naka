import type { Db } from "@naka/db";
import { decideRefund } from "@naka/gate";
import { insertLedgerRow } from "@naka/ledger";
import { newId, refundReceiptFor, sha256hex } from "@naka/shared";
import { currentPolicy } from "./policy.js";
import { policyForRefund } from "./tenant.js";

export interface RequestRefundArgs {
  checkoutId: string;
  razorpayPaymentId: string;
  amountPaise: number | null;
  reason: string;
  capturedPaise: number;
}

/** Step 1 of the two-step refund gate: the merchant REQUESTS a refund. */
export function requestRefund(db: Db, args: RequestRefundArgs): { refundId: string; decision: ReturnType<typeof decideRefund> } {
  return db.transaction(() => {
    const alreadyRefunded = !!db.prepare("SELECT 1 FROM refunds WHERE razorpay_payment_id = ? AND status IN ('processed','pending')").get(args.razorpayPaymentId);
    const decision = decideRefund({
      requestedBy: "merchant",
      amountPaise: args.amountPaise,
      capturedPaise: args.capturedPaise,
      alreadyRefunded,
      hasApproval: false,
    });

    const refundId = newId("refund");
    db.prepare(
      `INSERT INTO refunds (id, checkout_id, razorpay_payment_id, amount_paise, reason, status, idempotency_key, receipt, requested_by)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'merchant')`
    ).run(
      refundId,
      args.checkoutId,
      args.razorpayPaymentId,
      args.amountPaise,
      args.reason,
      decision.outcome === "DENY" ? "denied" : "requested",
      newId("idem"),
      refundReceiptFor(refundId)
    );

    insertLedgerRow(db, {
      actor: "merchant",
      action: "REFUND_REQUESTED",
      decision: decision.outcome,
      rule_hits: decision.rule_hits,
      checkout_id: args.checkoutId,
      razorpay_payment_id: args.razorpayPaymentId,
      amount_paise: args.amountPaise ?? args.capturedPaise,
    });

    return { refundId, decision };
  })();
}

/** Step 2: a separate merchant action approves the pending request, minting a short-lived, single-use approval token. */
export function approveRefund(db: Db, refundId: string, decidedBy: string): { approvalId: string; token: string } {
  const { policy } = policyForRefund(db, refundId);
  return db.transaction(() => {
    const refund = db.prepare("SELECT * FROM refunds WHERE id = ?").get(refundId) as any;
    if (!refund || refund.status !== "requested") throw new Error("refund not in a requestable state");

    const token = newId("tok");
    const approvalId = newId("appr");
    const expiresAt = Math.floor(Date.now() / 1000) + policy.refund_approval_ttl_seconds;
    db.prepare(
      `INSERT INTO approvals (id, refund_id, kind, token_hash, expires_at, decided_by, decision, decided_at)
       VALUES (?, ?, 'refund', ?, ?, ?, 'approved', strftime('%Y-%m-%dT%H:%M:%fZ','now'))`
    ).run(approvalId, refundId, sha256hex(token), expiresAt, decidedBy);
    db.prepare(`UPDATE refunds SET status='approved', approval_id=? WHERE id=?`).run(approvalId, refundId);

    insertLedgerRow(db, { actor: "merchant", action: "REFUND_APPROVED", razorpay_payment_id: refund.razorpay_payment_id, inputs: { refund_id: refundId, decided_by: decidedBy } });
    return { approvalId, token };
  })();
}

export function denyRefund(db: Db, refundId: string, decidedBy: string): void {
  db.transaction(() => {
    db.prepare(`UPDATE refunds SET status='denied' WHERE id=?`).run(refundId);
    insertLedgerRow(db, { actor: "merchant", action: "REFUND_DENIED", inputs: { refund_id: refundId, decided_by: decidedBy } });
  })();
}

export function hasValidRefundApproval(db: Db, refundId: string, token: string): boolean {
  const row = db
    .prepare(`SELECT * FROM approvals WHERE refund_id = ? AND kind='refund' AND decision='approved' AND expires_at > ? ORDER BY decided_at DESC LIMIT 1`)
    .get(refundId, Math.floor(Date.now() / 1000)) as any;
  return !!row && row.token_hash === sha256hex(token);
}
