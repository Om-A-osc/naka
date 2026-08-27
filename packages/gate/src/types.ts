export type RuleId =
  | "A1_SIGNATURE" | "A2_AGENT_ACTIVE"
  | "B1_MAX_PER_CHECKOUT" | "B2_AGENT_DAILY_CAP" | "B3_MANDATE_AMOUNT" | "B4_MANDATE_EXPIRY"
  | "B5_MANDATE_SCOPE" | "B6_MAX_QTY" | "B7_COUPON"
  | "S1_STOCK"
  | "G2_MERCHANT_APPROVAL"
  | "R1_REFUND_MERCHANT_ONLY" | "R2_REFUND_BOUNDS" | "R3_REFUND_APPROVAL";

export interface RuleHit {
  rule_id: RuleId | string;
  passed: boolean;
  left: string | number;
  right: string | number;
}

export type GateOutcome = "ALLOW" | "DENY" | "NEEDS_HUMAN";

export interface Decision {
  outcome: GateOutcome;
  rule_hits: RuleHit[];
  explanation: string;
}

export interface CheckoutLineCtx {
  variant_id: string;
  category: string;
  qty: number;
}

export interface GateCtx {
  now: number; // unix seconds
  checkout: {
    total_paise: number;
    lines: CheckoutLineCtx[];
  };
  mandate: {
    max_per_checkout_paise: number;
    remaining_paise: number; // max_total - already spent, computed by @naka/mandate
    allowed_categories: string[];
    expires_at: number;
    agent_pubkey: string;
  };
  agent: {
    id: string;
    status: "active" | "suspended";
    pubkey: string;
    spent_today_paise: number;
  };
  policy: {
    max_per_checkout_paise: number;
    merchant_approval_over_paise: number;
    per_agent_daily_cap_paise: number;
    max_qty_per_line: number;
    kill_switch: boolean;
  };
  /** Result of the engine's atomic stock-reservation attempt for this proposal. */
  stock: {
    ok: boolean;
    insufficient_variant_ids: string[];
  };
  /** Result of the engine's coupon lookup, if a coupon_code was supplied. */
  coupon?: {
    code: string;
    valid: boolean;
    reason?: string;
  };
}
