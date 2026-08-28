import type { Db } from "@naka/db";
import { verifyWebhookSignature } from "@naka/razorpay";
import { onPaymentAuthorized, onPaymentCaptured, onPaymentFailed, onOrderPaid, onRefundProcessed, onRefundFailed, onPaymentLinkPaid, onPaymentLinkExpired } from "@naka/engine";
import { insertLedgerRow } from "@naka/ledger";
import { isFaultActive } from "../jobs/fault-flags.js";

export interface WebhookOutcome {
  status: number;
  body?: unknown;
}

/** The one function that turns a Razorpay webhook delivery into state changes. */
export function verifyAndApplyWebhook(db: Db, secrets: string[], rawBody: Buffer, headers: { signature?: string; eventId?: string }): WebhookOutcome {
  if (isFaultActive(db, "webhook_500")) {
    return { status: 500 };
  }

  if (!verifyWebhookSignature(rawBody, headers.signature, secrets)) {
    insertLedgerRow(db, { actor: "webhook", action: "WEBHOOK_REJECTED", inputs: { reason: "bad_signature" } });
    return { status: 401 };
  }

  let body: any;
  try {
    body = JSON.parse(rawBody.toString("utf8"));
  } catch {
    return { status: 400 };
  }

  const eventId = headers.eventId ?? `synth:${body.event}:${primaryEntityId(body)}:${body.created_at ?? ""}`;

  const insert = db
    .prepare(`INSERT OR IGNORE INTO webhook_events (event_id, event, account_id, payload, signature_verified, status) VALUES (?, ?, ?, ?, 1, 'received')`)
    .run(eventId, body.event, body.account_id ?? null, JSON.stringify(body));

  if (insert.changes === 0) {
    insertLedgerRow(db, { actor: "webhook", action: "WEBHOOK_DUPLICATE", event_id: eventId, inputs: { event: body.event } });
    return { status: 200 };
  }

  try {
    dispatch(db, body, eventId);
    db.prepare(`UPDATE webhook_events SET status='processed', processed_at=strftime('%Y-%m-%dT%H:%M:%fZ','now') WHERE event_id = ?`).run(eventId);
  } catch (err) {
    db.prepare(`UPDATE webhook_events SET status='error', error=? WHERE event_id = ?`).run(String(err), eventId);
    // still 200: Razorpay considers this delivered; the error is ours to fix, not theirs to retry forever
  }

  return { status: 200 };
}

function primaryEntityId(body: any): string {
  const first = (body.contains ?? [])[0];
  return body?.payload?.[first]?.entity?.id ?? "";
}

function dispatch(db: Db, body: any, eventId: string) {
  const payment = body.payload?.payment?.entity;
  const order = body.payload?.order?.entity;
  const refund = body.payload?.refund?.entity;
  const paymentLink = body.payload?.payment_link?.entity;

  switch (body.event) {
    case "payment.authorized":
      if (payment) onPaymentAuthorized(db, payment, "webhook");
      break;
    case "payment.captured":
      if (payment) onPaymentCaptured(db, payment, "webhook");
      break;
    case "payment.failed":
      if (payment) onPaymentFailed(db, payment, "webhook");
      break;
    case "order.paid":
      if (order && payment) onOrderPaid(db, order, payment, "webhook");
      break;
    case "payment_link.paid":
      if (paymentLink && order && payment) onPaymentLinkPaid(db, paymentLink, order, payment, "webhook");
      break;
    case "payment_link.expired":
    case "payment_link.cancelled":
      if (paymentLink) onPaymentLinkExpired(db, paymentLink);
      break;
    case "refund.processed":
      if (refund) onRefundProcessed(db, refund);
      break;
    case "refund.failed":
      if (refund) onRefundFailed(db, refund);
      break;
    default:
      insertLedgerRow(db, { actor: "webhook", action: "WEBHOOK_UNHANDLED_EVENT", event_id: eventId, inputs: { event: body.event } });
  }
}
