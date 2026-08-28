import { newId } from "@naka/shared";
import { RazorpayApiError, DUPLICATE_RECEIPT_PREFIX } from "./errors.js";
import { signWebhookBody } from "./signatures.js";
import type {
  RazorpayClient,
  RazorpayOrder,
  RazorpayPayment,
  RazorpayRefund,
  RazorpayPaymentLink,
  RazorpayCustomer,
  CreateOrderArgs,
  CreateRefundArgs,
  CreatePaymentLinkArgs,
  CreateCustomerArgs,
} from "./types.js";

export type WebhookSink = (rawBody: Buffer, headers: { "x-razorpay-signature": string; "x-razorpay-event-id": string }) => void | Promise<void>;

export interface SimulatePaymentArgs {
  result: "captured" | "failed";
  method?: string;
  errorCode?: string;
  errorDescription?: string;
  errorSource?: string;
  errorStep?: string;
  errorReason?: string;
}

const nowSeconds = () => Math.floor(Date.now() / 1000);

/** A fully deterministic, in-memory Razorpay test-mode stand-in. */
export class RecordedRazorpayClient implements RazorpayClient {
  mode = "recorded" as const;

  private ordersById = new Map<string, RazorpayOrder>();
  private ordersByReceipt = new Map<string, string>();
  private paymentsById = new Map<string, RazorpayPayment>();
  private paymentsByOrder = new Map<string, string[]>();
  private refundsById = new Map<string, RazorpayRefund>();
  private refundReceipts = new Set<string>();
  private linksById = new Map<string, RazorpayPaymentLink>();
  private linksByReferenceId = new Map<string, string>();
  private customersByKey = new Map<string, RazorpayCustomer>();
  private refundIdempotency = new Map<string, string>(); // idempotencyKey -> refundId

  constructor(private webhookSecret: string, private sink?: WebhookSink) {}

  setSink(sink: WebhookSink) {
    this.sink = sink;
  }

  orders = {
    create: async (args: CreateOrderArgs): Promise<RazorpayOrder> => {
      if (this.ordersByReceipt.has(args.receipt)) {
        throw new RazorpayApiError(DUPLICATE_RECEIPT_PREFIX);
      }
      const order: RazorpayOrder = {
        id: newId("order"),
        entity: "order",
        amount: args.amount,
        amount_paid: 0,
        amount_due: args.amount,
        currency: args.currency,
        receipt: args.receipt,
        status: "created",
        attempts: 0,
        notes: args.notes,
        created_at: nowSeconds(),
      };
      this.ordersById.set(order.id, order);
      this.ordersByReceipt.set(args.receipt, order.id);
      return { ...order };
    },
    fetch: async (id: string): Promise<RazorpayOrder> => {
      const o = this.ordersById.get(id);
      if (!o) throw new RazorpayApiError("The id provided does not exist");
      return { ...o };
    },
    fetchByReceipt: async (receipt: string): Promise<RazorpayOrder[]> => {
      const id = this.ordersByReceipt.get(receipt);
      return id ? [{ ...this.ordersById.get(id)! }] : [];
    },
    fetchPayments: async (orderId: string): Promise<RazorpayPayment[]> => {
      const ids = this.paymentsByOrder.get(orderId) ?? [];
      return ids.map((id) => ({ ...this.paymentsById.get(id)! }));
    },
  };

  payments = {
    fetch: async (id: string): Promise<RazorpayPayment> => {
      const p = this.paymentsById.get(id);
      if (!p) throw new RazorpayApiError("The id provided does not exist");
      return { ...p };
    },
  };

  refunds = {
    create: async (paymentId: string, args: CreateRefundArgs): Promise<RazorpayRefund> => {
      const existingByKey = this.refundIdempotency.get(args.idempotencyKey);
      if (existingByKey) return { ...this.refundsById.get(existingByKey)! };

      if (this.refundReceipts.has(args.receipt)) {
        throw new RazorpayApiError(
          "The value passed in the receipt parameter has already been used for an earlier refund on the same payment."
        );
      }
      const payment = this.paymentsById.get(paymentId);
      if (!payment) throw new RazorpayApiError("The id provided does not exist");
      if (payment.status !== "captured") {
        throw new RazorpayApiError("You can initiate refunds only on those payments that are in captured state.");
      }
      const remaining = payment.amount - payment.amount_refunded;
      const amount = args.amount ?? remaining;
      if (amount <= 0 || amount > remaining) {
        throw new RazorpayApiError("The refund amount is greater than the amount captured/refundable.");
      }

      const refund: RazorpayRefund = {
        id: newId("rfnd"),
        entity: "refund",
        payment_id: paymentId,
        amount,
        currency: payment.currency,
        status: "processed", // recorded mode: synchronous, deterministic
        speed_requested: args.speed ?? "normal",
        speed_processed: args.speed === "optimum" ? "instant" : "normal",
        receipt: args.receipt,
        notes: args.notes ?? {},
        created_at: nowSeconds(),
      };
      this.refundsById.set(refund.id, refund);
      this.refundReceipts.add(args.receipt);
      this.refundIdempotency.set(args.idempotencyKey, refund.id);

      payment.amount_refunded += amount;
      payment.refund_status = payment.amount_refunded >= payment.amount ? "full" : "partial";
      this.paymentsById.set(paymentId, payment);

      await this.emitWebhook("refund.processed", { refund, payment });
      return { ...refund };
    },
    fetch: async (id: string): Promise<RazorpayRefund> => {
      const r = this.refundsById.get(id);
      if (!r) throw new RazorpayApiError("The id provided does not exist");
      return { ...r };
    },
  };

  paymentLinks = {
    create: async (args: CreatePaymentLinkArgs): Promise<RazorpayPaymentLink> => {
      if (this.linksByReferenceId.has(args.reference_id)) {
        throw new RazorpayApiError("payment link creation with reference ID already attempted");
      }
      // Real Razorpay backs every payment link with an order created lazily.
      const order: RazorpayOrder = {
        id: newId("order"),
        entity: "order",
        amount: args.amount,
        amount_paid: 0,
        amount_due: args.amount,
        currency: args.currency,
        receipt: args.reference_id,
        status: "created",
        attempts: 0,
        notes: args.notes ?? {},
        created_at: nowSeconds(),
      };
      this.ordersById.set(order.id, order);

      const link: RazorpayPaymentLink = {
        id: newId("plink"),
        entity: "payment_link",
        short_url: `https://rzp.io/i/${newId().slice(0, 8)}`,
        status: "created",
        amount: args.amount,
        amount_paid: 0,
        currency: args.currency,
        reference_id: args.reference_id,
        order_id: order.id,
        expire_by: args.expire_by,
        expired_at: null,
        cancelled_at: null,
        created_at: nowSeconds(),
      };
      this.linksById.set(link.id, link);
      this.linksByReferenceId.set(args.reference_id, link.id);
      return { ...link };
    },
    fetch: async (id: string): Promise<RazorpayPaymentLink> => {
      const l = this.linksById.get(id);
      if (!l) throw new RazorpayApiError("The id provided does not exist");
      return { ...l };
    },
    fetchByReferenceId: async (referenceId: string): Promise<RazorpayPaymentLink[]> => {
      const id = this.linksByReferenceId.get(referenceId);
      return id ? [{ ...this.linksById.get(id)! }] : [];
    },
    cancel: async (id: string): Promise<RazorpayPaymentLink> => {
      const l = this.linksById.get(id);
      if (!l) throw new RazorpayApiError("The id provided does not exist");
      if (l.status !== "created") {
        throw new RazorpayApiError("cannot cancel or expire an already paid/partially paid/expired link");
      }
      l.status = "cancelled";
      l.cancelled_at = nowSeconds();
      this.linksById.set(id, l);
      return { ...l };
    },
  };

  customers = {
    createOrFetch: async (args: CreateCustomerArgs): Promise<RazorpayCustomer> => {
      const key = args.email ?? args.contact ?? args.name;
      const existing = this.customersByKey.get(key);
      if (existing) return { ...existing };
      const customer: RazorpayCustomer = {
        id: newId("cust"),
        entity: "customer",
        name: args.name,
        email: args.email ?? null,
        contact: args.contact ?? null,
        created_at: nowSeconds(),
      };
      this.customersByKey.set(key, customer);
      return { ...customer };
    },
  };

  /** Plays "the human paid via the payment link", mirrors simulatePayment() for the link path. */
  async simulateLinkPayment(linkId: string, result: "captured" | "failed"): Promise<RazorpayPayment> {
    const link = this.linksById.get(linkId);
    if (!link || !link.order_id) throw new RazorpayApiError("The id provided does not exist");
    const order = this.ordersById.get(link.order_id)!;

    const payment: RazorpayPayment = {
      id: newId("pay"),
      entity: "payment",
      order_id: order.id,
      amount: order.amount,
      currency: order.currency,
      status: result === "captured" ? "captured" : "failed",
      captured: result === "captured",
      method: "upi",
      error_code: result === "failed" ? "BAD_REQUEST_ERROR" : null,
      error_description: result === "failed" ? "Payment failed" : null,
      error_source: result === "failed" ? "customer" : null,
      error_step: result === "failed" ? "payment_authentication" : null,
      error_reason: result === "failed" ? "payment_failed" : null,
      amount_refunded: 0,
      refund_status: null,
      acquirer_data: { rrn: newId().slice(0, 12) },
      created_at: nowSeconds(),
    };
    this.paymentsById.set(payment.id, payment);
    const list = this.paymentsByOrder.get(order.id) ?? [];
    list.push(payment.id);
    this.paymentsByOrder.set(order.id, list);

    if (result === "captured") {
      order.amount_paid = order.amount;
      order.amount_due = 0;
      order.status = "paid";
      link.status = "paid";
      link.amount_paid = link.amount;
    }
    this.ordersById.set(order.id, order);
    this.linksById.set(linkId, link);

    if (result === "captured") {
      await this.emitWebhook("payment_link.paid", { payment, order, paymentLink: link });
    } else {
      await this.emitWebhook("payment.failed", { payment });
    }
    return { ...payment };
  }

  /** Called by scenario scripts to play "the human paid / the payment failed" in the Checkout modal. */
  async simulatePayment(orderId: string, args: SimulatePaymentArgs): Promise<RazorpayPayment> {
    const order = this.ordersById.get(orderId);
    if (!order) throw new RazorpayApiError("The id provided does not exist");

    const payment: RazorpayPayment = {
      id: newId("pay"),
      entity: "payment",
      order_id: orderId,
      amount: order.amount,
      currency: order.currency,
      status: args.result === "captured" ? "captured" : "failed",
      captured: args.result === "captured",
      method: args.method ?? "upi",
      error_code: args.result === "failed" ? args.errorCode ?? "BAD_REQUEST_ERROR" : null,
      error_description: args.result === "failed" ? args.errorDescription ?? "Payment failed" : null,
      error_source: args.result === "failed" ? args.errorSource ?? "customer" : null,
      error_step: args.result === "failed" ? args.errorStep ?? "payment_authentication" : null,
      error_reason: args.result === "failed" ? args.errorReason ?? "payment_failed" : null,
      amount_refunded: 0,
      refund_status: null,
      acquirer_data: { rrn: newId().slice(0, 12) },
      created_at: nowSeconds(),
    };

    this.paymentsById.set(payment.id, payment);
    const list = this.paymentsByOrder.get(orderId) ?? [];
    list.push(payment.id);
    this.paymentsByOrder.set(orderId, list);

    order.attempts += 1;
    if (args.result === "captured") {
      order.amount_paid = order.amount;
      order.amount_due = 0;
      order.status = "paid";
    } else {
      order.status = "attempted";
    }
    this.ordersById.set(orderId, order);

    if (args.result === "failed") {
      await this.emitWebhook("payment.failed", { payment });
    } else {
      await this.emitWebhook("payment.captured", { payment });
      await this.emitWebhook("order.paid", { payment, order });
    }
    return { ...payment };
  }

  private async emitWebhook(event: string, entities: { payment?: RazorpayPayment; order?: RazorpayOrder; refund?: RazorpayRefund; paymentLink?: RazorpayPaymentLink }) {
    if (!this.sink) return;
    const payload: Record<string, { entity: unknown }> = {};
    if (entities.payment) payload.payment = { entity: entities.payment };
    if (entities.order) payload.order = { entity: entities.order };
    if (entities.refund) payload.refund = { entity: entities.refund };
    if (entities.paymentLink) payload.payment_link = { entity: entities.paymentLink };

    const body = {
      entity: "event",
      account_id: "acc_test_recorded",
      event,
      contains: Object.keys(payload),
      payload,
      created_at: nowSeconds(),
    };
    const rawBody = Buffer.from(JSON.stringify(body), "utf8");
    const signature = signWebhookBody(rawBody, this.webhookSecret);
    const eventId = newId("evt");
    await this.sink(rawBody, { "x-razorpay-signature": signature, "x-razorpay-event-id": eventId });
  }
}
