import Razorpay from "razorpay";
import { RazorpayApiError, rzpErrorDescription } from "./errors.js";
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

const BASE_URL = "https://api.razorpay.com/v1";

/** Real Razorpay test-mode client: the official `razorpay` SDK for most calls. */
export function createRealRazorpayClient(keyId: string, keySecret: string): RazorpayClient {
  if (!keyId.startsWith("rzp_test_")) {
    throw new Error(
      `refusing to start: RAZORPAY_KEY_ID does not look like a test-mode key (expected an "rzp_test_" prefix). ` +
        `This project only ever runs against Razorpay test mode.`
    );
  }
  const sdk = new (Razorpay as any)({ key_id: keyId, key_secret: keySecret });
  const authHeader = "Basic " + Buffer.from(`${keyId}:${keySecret}`).toString("base64");

  async function wrap<T>(fn: () => Promise<T>): Promise<T> {
    try {
      return await fn();
    } catch (err) {
      throw new RazorpayApiError(rzpErrorDescription(err));
    }
  }

  const client: RazorpayClient = {
    mode: "real",
    orders: {
      create: (args: CreateOrderArgs) =>
        wrap<RazorpayOrder>(() =>
          sdk.orders.create({
            amount: args.amount,
            currency: args.currency,
            receipt: args.receipt,
            notes: args.notes,
            partial_payment: args.partial_payment ?? false,
            ...(args.offers ? { offers: args.offers } : {}),
            ...(args.force_offer !== undefined ? { force_offer: args.force_offer } : {}),
          })
        ),
      fetch: (id: string) => wrap<RazorpayOrder>(() => sdk.orders.fetch(id)),
      fetchByReceipt: (receipt: string) =>
        wrap<RazorpayOrder[]>(async () => {
          const list = await sdk.orders.all({ receipt, count: 10 });
          return (list.items ?? []).filter((o: RazorpayOrder) => o.receipt === receipt);
        }),
      fetchPayments: (orderId: string) =>
        wrap<RazorpayPayment[]>(async () => {
          const list = await sdk.orders.fetchPayments(orderId);
          return list.items ?? [];
        }),
    },
    payments: {
      fetch: (id: string) => wrap<RazorpayPayment>(() => sdk.payments.fetch(id)),
    },
    refunds: {
      create: (paymentId: string, args: CreateRefundArgs) =>
        wrap<RazorpayRefund>(async () => {
          const res = await fetch(`${BASE_URL}/payments/${paymentId}/refund`, {
            method: "POST",
            headers: {
              Authorization: authHeader,
              "Content-Type": "application/json",
              "X-Refund-Idempotency": args.idempotencyKey,
            },
            body: JSON.stringify({
              amount: args.amount,
              speed: args.speed ?? "normal",
              notes: args.notes ?? {},
              receipt: args.receipt,
            }),
          });
          const json = (await res.json()) as any;
          if (!res.ok) throw json;
          return json as RazorpayRefund;
        }),
      fetch: (id: string) => wrap<RazorpayRefund>(() => sdk.refunds.fetch(id)),
    },
    paymentLinks: {
      // Raw fetch throughout so the exact documented endpoints/fields are what's called, matching the researched behavior.
      create: (args: CreatePaymentLinkArgs) =>
        wrap<RazorpayPaymentLink>(async () => {
          const res = await fetch(`${BASE_URL}/payment_links/`, {
            method: "POST",
            headers: { Authorization: authHeader, "Content-Type": "application/json" },
            body: JSON.stringify({
              amount: args.amount,
              currency: args.currency,
              accept_partial: false,
              reference_id: args.reference_id,
              description: args.description ?? "Naka checkout",
              expire_by: args.expire_by,
              notes: args.notes ?? {},
              reminder_enable: false,
              callback_url: args.callback_url,
              callback_method: args.callback_method ?? "get",
            }),
          });
          const json = (await res.json()) as any;
          if (!res.ok) throw json;
          return json as RazorpayPaymentLink;
        }),
      fetch: (id: string) =>
        wrap<RazorpayPaymentLink>(async () => {
          const res = await fetch(`${BASE_URL}/payment_links/${id}`, { headers: { Authorization: authHeader } });
          const json = (await res.json()) as any;
          if (!res.ok) throw json;
          return json as RazorpayPaymentLink;
        }),
      fetchByReferenceId: (referenceId: string) =>
        wrap<RazorpayPaymentLink[]>(async () => {
          const res = await fetch(`${BASE_URL}/payment_links/?reference_id=${encodeURIComponent(referenceId)}`, {
            headers: { Authorization: authHeader },
          });
          const json = (await res.json()) as any;
          if (!res.ok) throw json;
          return (json.payment_links ?? []) as RazorpayPaymentLink[];
        }),
      cancel: (id: string) =>
        wrap<RazorpayPaymentLink>(async () => {
          const res = await fetch(`${BASE_URL}/payment_links/${id}/cancel`, {
            method: "POST",
            headers: { Authorization: authHeader },
          });
          const json = (await res.json()) as any;
          if (!res.ok) throw json;
          return json as RazorpayPaymentLink;
        }),
    },
    customers: {
      createOrFetch: (args: CreateCustomerArgs) =>
        wrap<RazorpayCustomer>(async () => {
          const res = await fetch(`${BASE_URL}/customers`, {
            method: "POST",
            headers: { Authorization: authHeader, "Content-Type": "application/json" },
            body: JSON.stringify({ name: args.name, email: args.email, contact: args.contact, fail_existing: "0" }),
          });
          const json = (await res.json()) as any;
          if (!res.ok) throw json;
          return json as RazorpayCustomer;
        }),
    },
  };

  return client;
}
