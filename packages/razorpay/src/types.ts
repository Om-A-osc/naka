export interface RazorpayOrder {
  id: string;
  entity: "order";
  amount: number;
  amount_paid: number;
  amount_due: number;
  currency: string;
  receipt: string;
  status: "created" | "attempted" | "paid";
  attempts: number;
  notes: Record<string, string>;
  created_at: number;
}

export interface RazorpayPayment {
  id: string;
  entity: "payment";
  order_id: string;
  amount: number;
  currency: string;
  status: "created" | "authorized" | "captured" | "refunded" | "failed";
  captured: boolean;
  method?: string;
  error_code?: string | null;
  error_description?: string | null;
  error_source?: string | null;
  error_step?: string | null;
  error_reason?: string | null;
  amount_refunded: number;
  refund_status: "partial" | "full" | null;
  acquirer_data?: Record<string, string>;
  created_at: number;
}

export interface RazorpayRefund {
  id: string;
  entity: "refund";
  payment_id: string;
  amount: number;
  currency: string;
  status: "pending" | "processed" | "failed";
  speed_requested: "normal" | "optimum";
  speed_processed: "instant" | "normal" | null;
  receipt: string | null;
  notes: Record<string, string>;
  created_at: number;
}

export interface CreateOrderArgs {
  amount: number;
  currency: string;
  receipt: string;
  notes: Record<string, string>;
  partial_payment?: boolean;
  /** Secondary-scope Offers adapter: a single dashboard-created test-mode Offer id, forced. */
  offers?: string[];
  force_offer?: boolean;
}

export interface CreateRefundArgs {
  amount?: number; // omit for full
  speed?: "normal" | "optimum";
  notes?: Record<string, string>;
  receipt: string;
  idempotencyKey: string; // sent as X-Refund-Idempotency
}

export interface RazorpayPaymentLink {
  id: string;
  entity: "payment_link";
  short_url: string;
  status: "created" | "partially_paid" | "paid" | "expired" | "cancelled";
  amount: number;
  amount_paid: number;
  currency: string;
  reference_id: string | null;
  order_id: string | null;
  expire_by: number | null;
  expired_at: number | null;
  cancelled_at: number | null;
  created_at: number;
}

export interface CreatePaymentLinkArgs {
  amount: number;
  currency: string;
  reference_id: string;
  description?: string;
  expire_by: number; // unix seconds, must be >= 15 min ahead
  notes?: Record<string, string>;
  callback_url?: string;
  callback_method?: "get";
}

export interface RazorpayCustomer {
  id: string;
  entity: "customer";
  name: string;
  email: string | null;
  contact: string | null;
  created_at: number;
}

export interface CreateCustomerArgs {
  name: string;
  email?: string;
  contact?: string;
}

export interface RazorpayClient {
  mode: "real" | "recorded";
  orders: {
    create(args: CreateOrderArgs): Promise<RazorpayOrder>;
    fetch(id: string): Promise<RazorpayOrder>;
    fetchByReceipt(receipt: string): Promise<RazorpayOrder[]>;
    fetchPayments(orderId: string): Promise<RazorpayPayment[]>;
  };
  payments: {
    fetch(id: string): Promise<RazorpayPayment>;
  };
  refunds: {
    create(paymentId: string, args: CreateRefundArgs): Promise<RazorpayRefund>;
    fetch(id: string): Promise<RazorpayRefund>;
  };
  paymentLinks: {
    create(args: CreatePaymentLinkArgs): Promise<RazorpayPaymentLink>;
    fetch(id: string): Promise<RazorpayPaymentLink>;
    fetchByReferenceId(referenceId: string): Promise<RazorpayPaymentLink[]>;
    cancel(id: string): Promise<RazorpayPaymentLink>;
  };
  customers: {
    /** fail_existing:"0" semantics: returns the existing customer instead of erroring if one already matches. */
    createOrFetch(args: CreateCustomerArgs): Promise<RazorpayCustomer>;
  };
}
