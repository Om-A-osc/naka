import type { RuleHit } from "./types.js";

const MESSAGES: Record<string, (h: RuleHit) => string> = {
  A2_AGENT_ACTIVE: () => "This agent is suspended or the merchant kill switch is on.",
  B1_MAX_PER_CHECKOUT: (h) => `The cart total (${h.left}) exceeds the merchant's per-checkout limit (${h.right}).`,
  B2_AGENT_DAILY_CAP: (h) => `This would put the agent's spend today (${h.left}) over its daily cap (${h.right}).`,
  B3_MANDATE_AMOUNT: (h) => `The cart total (${h.left}) exceeds what your mandate still allows (${h.right}).`,
  B4_MANDATE_EXPIRY: () => "Your mandate has expired.",
  B5_MANDATE_SCOPE: (h) => `An item's category is outside what your mandate allows (${h.right}).`,
  B6_MAX_QTY: (h) => `One line's quantity (${h.left}) exceeds the per-line limit (${h.right}).`,
  B7_COUPON: () => "That coupon code is not valid for this order.",
  S1_STOCK: () => "One or more items are out of stock right now.",
  G2_MERCHANT_APPROVAL: () => "This order needs the merchant's approval before it can proceed.",
  R1_REFUND_MERCHANT_ONLY: () => "Only the merchant can request a refund.",
  R2_REFUND_BOUNDS: () => "The refund amount is invalid for this payment.",
  R3_REFUND_APPROVAL: () => "This refund is waiting on merchant approval.",
};

export function explain(hit: RuleHit): string {
  const fn = MESSAGES[hit.rule_id];
  return fn ? fn(hit) : `Rule ${hit.rule_id} failed.`;
}
