export type LedgerActor =
  | "agent" | "engine" | "gate" | "executor" | "webhook" | "reconciler" | "merchant" | "buyer" | "system";

export interface LedgerRowInput {
  actor: LedgerActor;
  agent_id?: string | null;
  action: string;
  decision?: string | null;
  rule_hits?: unknown;
  inputs?: unknown;
  checkout_id?: string | null;
  attempt_id?: string | null;
  razorpay_order_id?: string | null;
  razorpay_payment_id?: string | null;
  razorpay_refund_id?: string | null;
  event_id?: string | null;
  amount_paise?: number | null;
}

export interface LedgerRow extends LedgerRowInput {
  seq: number;
  ts: string;
  prev_hash: string;
  hash: string;
}
