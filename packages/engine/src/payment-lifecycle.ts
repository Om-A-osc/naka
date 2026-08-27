import type { Db } from "@naka/db";
import type { RazorpayOrder, RazorpayPayment, RazorpayRefund, RazorpayPaymentLink } from "@naka/razorpay";
import { insertLedgerRow } from "@naka/ledger";
import { newId, hashPii } from "@naka/shared";
import { classifyFailure } from "./failure-table.js";
import { consumeReservations, extendReservations } from "./reservations.js";
import { currentPolicy } from "./policy.js";
import { policyForCheckout } from "./tenant.js";
import { STATUS_RANK } from "./checkout.js";

export type EventSource = "webhook" | "reconcile" | "api_fetch";

const ATTEMPT_RANK: Record<string, number> = { created: 0, opened: 1, failed: 2, authorized: 3, captured: 4 };

interface AttemptRow {
  id: string;
  checkout_id: string;
  attempt_no: number;
  status: string;
  status_rank: number;
}

function findAttemptByOrderId(db: Db, razorpayOrderId: string): AttemptRow | undefined {
  return db.prepare("SELECT * FROM payment_attempts WHERE razorpay_order_id = ?").get(razorpayOrderId) as AttemptRow | undefined;
}

function upsertRzpPayment(db: Db, p: RazorpayPayment, attempt: AttemptRow, checkoutId: string, role: "primary" | "surplus", source: EventSource) {
  db.prepare(
    `INSERT INTO rzp_payments (razorpay_payment_id, razorpay_order_id, attempt_id, checkout_id, status, status_rank, captured,
                                amount, currency, method, role, error_code, error_description, error_source, error_step, error_reason,
                                acquirer_rrn, created_at_rzp, last_snapshot, source)
     VALUES (@id,@order_id,@attempt_id,@checkout_id,@status,@status_rank,@captured,@amount,@currency,@method,@role,
             @error_code,@error_description,@error_source,@error_step,@error_reason,@acquirer_rrn,@created_at_rzp,@snapshot,@source)
     ON CONFLICT(razorpay_payment_id) DO UPDATE SET
       status=excluded.status, status_rank=excluded.status_rank, captured=excluded.captured,
       error_code=excluded.error_code, error_description=excluded.error_description, error_source=excluded.error_source,
       error_step=excluded.error_step, error_reason=excluded.error_reason, last_snapshot=excluded.last_snapshot, source=excluded.source
     WHERE rzp_payments.status_rank < excluded.status_rank`
  ).run({
    id: p.id,
    order_id: p.order_id,
    attempt_id: attempt.id,
    checkout_id: checkoutId,
    status: p.status,
    status_rank: ATTEMPT_RANK[p.status] ?? 0,
    captured: p.captured ? 1 : 0,
    amount: p.amount,
    currency: p.currency,
    method: p.method ?? null,
    role,
    error_code: p.error_code ?? null,
    error_description: p.error_description ?? null,
    error_source: p.error_source ?? null,
    error_step: p.error_step ?? null,
    error_reason: p.error_reason ?? null,
    acquirer_rrn: p.acquirer_data?.rrn ?? null,
    created_at_rzp: p.created_at,
    snapshot: JSON.stringify(p),
    source,
  });
}

function hasPrimaryCaptured(db: Db, checkoutId: string, excludingPaymentId?: string): boolean {
  const row = db
    .prepare(
      `SELECT COUNT(*) AS n FROM rzp_payments WHERE checkout_id = ? AND role='primary' AND status='captured' AND razorpay_payment_id != ?`
    )
    .get(checkoutId, excludingPaymentId ?? "") as { n: number };
  return row.n > 0;
}

function completeCheckoutRow(db: Db, checkoutId: string, attemptId: string, paymentId: string, source: EventSource) {
  const row = db.prepare("SELECT status_rank FROM checkouts WHERE id = ?").get(checkoutId) as { status_rank: number } | undefined;
  if (!row || row.status_rank >= STATUS_RANK.completed) return; // already completed, idempotent no-op
  db.prepare(`UPDATE checkouts SET status='completed', status_rank=4, completed_at=strftime('%Y-%m-%dT%H:%M:%fZ','now') WHERE id=?`).run(checkoutId);
  db.prepare(`UPDATE payment_attempts SET status='captured', status_rank=4, closed_at=strftime('%Y-%m-%dT%H:%M:%fZ','now') WHERE id=?`).run(attemptId);
  consumeReservations(db, checkoutId);
  insertLedgerRow(db, {
    actor: source === "webhook" ? "webhook" : "reconciler",
    action: "CHECKOUT_COMPLETED",
    checkout_id: checkoutId,
    attempt_id: attemptId,
    razorpay_payment_id: paymentId,
  });
}

/** payment.authorized (or a manual-capture fetch showing authorized) */
export function onPaymentAuthorized(db: Db, p: RazorpayPayment, source: EventSource): void {
  db.transaction(() => {
    const attempt = findAttemptByOrderId(db, p.order_id);
    if (!attempt) {
      insertLedgerRow(db, { actor: source === "webhook" ? "webhook" : "reconciler", action: "WEBHOOK_ORPHAN", razorpay_payment_id: p.id, razorpay_order_id: p.order_id });
      return;
    }
    if (ATTEMPT_RANK.authorized > attempt.status_rank) {
      db.prepare("UPDATE payment_attempts SET status='authorized', status_rank=3 WHERE id=?").run(attempt.id);
    }
    upsertRzpPayment(db, p, attempt, attempt.checkout_id, hasPrimaryCaptured(db, attempt.checkout_id) ? "surplus" : "primary", source);
    insertLedgerRow(db, { actor: source === "webhook" ? "webhook" : "reconciler", action: "PAYMENT_AUTHORIZED", checkout_id: attempt.checkout_id, attempt_id: attempt.id, razorpay_payment_id: p.id, razorpay_order_id: p.order_id, amount_paise: p.amount });
  })();
}

/** payment.captured (from webhook, from a Checkout-handler hint fetch, or from reconciliation) */
export function onPaymentCaptured(db: Db, p: RazorpayPayment, source: EventSource): void {
  db.transaction(() => {
    const attempt = findAttemptByOrderId(db, p.order_id);
    if (!attempt) {
      insertLedgerRow(db, { actor: source === "webhook" ? "webhook" : "reconciler", action: "WEBHOOK_ORPHAN", razorpay_payment_id: p.id, razorpay_order_id: p.order_id });
      return;
    }
    const checkoutId = attempt.checkout_id;
    const checkoutRow = db.prepare("SELECT status_rank FROM checkouts WHERE id = ?").get(checkoutId) as { status_rank: number };
    const alreadyDone = checkoutRow.status_rank >= STATUS_RANK.completed || checkoutRow.status_rank === STATUS_RANK.canceled;
    const alreadyHasPrimary = hasPrimaryCaptured(db, checkoutId, p.id);

    if (ATTEMPT_RANK.captured > attempt.status_rank) {
      db.prepare("UPDATE payment_attempts SET status='captured', status_rank=4, closed_at=strftime('%Y-%m-%dT%H:%M:%fZ','now') WHERE id=?").run(attempt.id);
    }

    if (alreadyDone || alreadyHasPrimary) {
      // Surplus or late capture: checkout is already completed/canceled by another attempt.
      upsertRzpPayment(db, p, attempt, checkoutId, "surplus", source);
      insertLedgerRow(db, {
        actor: source === "webhook" ? "webhook" : "reconciler",
        action: checkoutRow.status_rank === STATUS_RANK.canceled ? "LATE_CAPTURE_ON_CANCELED" : "SURPLUS_PAYMENT_CAPTURED",
        checkout_id: checkoutId,
        attempt_id: attempt.id,
        razorpay_payment_id: p.id,
        razorpay_order_id: p.order_id,
        amount_paise: p.amount,
      });
      // Never an automatic refund, queue for merchant approval instead.
      db.prepare(
        `INSERT OR IGNORE INTO refunds (id, checkout_id, razorpay_payment_id, reason, status, idempotency_key, receipt, requested_by)
         VALUES (?, ?, ?, 'surplus_or_late_capture', 'requested', ?, ?, 'system')`
      ).run(newId("refund"), checkoutId, p.id, newId("idem"), newId("rf"));
      return;
    }

    upsertRzpPayment(db, p, attempt, checkoutId, "primary", source);
    completeCheckoutRow(db, checkoutId, attempt.id, p.id, source);
  })();
}

/** order.paid, the fully-paid signal; idempotent with onPaymentCaptured if both arrive. */
export function onOrderPaid(db: Db, _order: RazorpayOrder, p: RazorpayPayment, source: EventSource): void {
  onPaymentCaptured(db, p, source);
}

/** payment.failed */
export function onPaymentFailed(db: Db, p: RazorpayPayment, source: EventSource): void {
  db.transaction(() => {
    const attempt = findAttemptByOrderId(db, p.order_id);
    if (!attempt) {
      insertLedgerRow(db, { actor: "webhook", action: "WEBHOOK_ORPHAN", razorpay_payment_id: p.id, razorpay_order_id: p.order_id });
      return;
    }
    if (ATTEMPT_RANK.failed > attempt.status_rank) {
      const category = classifyFailure(p.error_source, p.error_step, p.error_reason);
      db.prepare("UPDATE payment_attempts SET status='failed', status_rank=2, failure_category=? WHERE id=?").run(category, attempt.id);
      const { policy } = policyForCheckout(db, attempt.checkout_id);
      extendReservations(db, attempt.checkout_id, policy.reservation_extend_seconds);
    }
    upsertRzpPayment(db, p, attempt, attempt.checkout_id, "primary", source);
    insertLedgerRow(db, {
      actor: source === "webhook" ? "webhook" : "reconciler",
      action: "PAYMENT_FAILED",
      checkout_id: attempt.checkout_id,
      attempt_id: attempt.id,
      razorpay_payment_id: p.id,
      razorpay_order_id: p.order_id,
      inputs: { error_code: p.error_code, error_source: p.error_source, error_step: p.error_step, error_reason: p.error_reason },
      amount_paise: p.amount,
    });
  })();
}

/** payment_link.paid, the link path's completion signal. */
export function onPaymentLinkPaid(
  db: Db,
  link: Pick<RazorpayPaymentLink, "reference_id">,
  order: RazorpayOrder,
  payment: RazorpayPayment,
  source: EventSource
): void {
  db.transaction(() => {
    if (!link.reference_id) return;
    const attempt = db.prepare("SELECT * FROM payment_attempts WHERE reference_id = ?").get(link.reference_id) as any;
    if (!attempt) {
      insertLedgerRow(db, { actor: source === "webhook" ? "webhook" : "reconciler", action: "WEBHOOK_ORPHAN", inputs: { reference_id: link.reference_id } });
      return;
    }
    if (!attempt.razorpay_order_id) {
      db.prepare(
        `UPDATE payment_attempts SET razorpay_order_id=?, status='opened', status_rank=MAX(status_rank,1),
                opened_at=COALESCE(opened_at, strftime('%Y-%m-%dT%H:%M:%fZ','now')) WHERE id=?`
      ).run(order.id, attempt.id);
      db.prepare(
        `INSERT OR IGNORE INTO rzp_orders (razorpay_order_id, attempt_id, status, amount, amount_paid, amount_due, attempts, receipt, notes, created_at_rzp)
         VALUES (?,?,?,?,?,?,?,?,?,?)`
      ).run(order.id, attempt.id, order.status, order.amount, order.amount_paid, order.amount_due, order.attempts, order.receipt, JSON.stringify(order.notes), order.created_at);
    }
    db.prepare(`UPDATE payment_links SET status='paid', amount_paid=?, razorpay_order_id=? WHERE reference_id=?`).run(
      payment.amount,
      order.id,
      link.reference_id
    );
  })();
  onPaymentCaptured(db, payment, source);
}

export function onPaymentLinkExpired(db: Db, link: Pick<RazorpayPaymentLink, "reference_id">): void {
  if (!link.reference_id) return;
  db.transaction(() => {
    db.prepare(`UPDATE payment_links SET status='expired' WHERE reference_id=?`).run(link.reference_id);
    const attempt = db.prepare("SELECT id, checkout_id, status_rank FROM payment_attempts WHERE reference_id = ?").get(link.reference_id) as any;
    if (attempt && attempt.status_rank < ATTEMPT_RANK.captured) {
      db.prepare("UPDATE payment_attempts SET status='expired', status_rank=2 WHERE id=?").run(attempt.id);
      insertLedgerRow(db, { actor: "webhook", action: "PAYMENT_LINK_EXPIRED", checkout_id: attempt.checkout_id, attempt_id: attempt.id });
    }
  })();
}

export function onRefundProcessed(db: Db, r: RazorpayRefund): void {
  db.transaction(() => {
    db.prepare(
      `UPDATE refunds SET status='processed', razorpay_refund_id=?, speed_processed=?, processed_at=strftime('%Y-%m-%dT%H:%M:%fZ','now'), last_snapshot=?
       WHERE razorpay_payment_id=? AND (razorpay_refund_id IS NULL OR razorpay_refund_id=?)`
    ).run(r.id, r.speed_processed, JSON.stringify(r), r.payment_id, r.id);
    const refund = db.prepare("SELECT checkout_id FROM refunds WHERE razorpay_refund_id = ?").get(r.id) as { checkout_id: string } | undefined;
    insertLedgerRow(db, { actor: "webhook", action: "REFUND_PROCESSED", checkout_id: refund?.checkout_id ?? null, razorpay_refund_id: r.id, razorpay_payment_id: r.payment_id, amount_paise: r.amount });
  })();
}

export function onRefundFailed(db: Db, r: RazorpayRefund): void {
  db.transaction(() => {
    db.prepare(`UPDATE refunds SET status='failed', last_snapshot=? WHERE razorpay_payment_id=?`).run(JSON.stringify(r), r.payment_id);
    insertLedgerRow(db, { actor: "webhook", action: "REFUND_FAILED", razorpay_payment_id: r.payment_id });
  })();
}

export { hashPii };
