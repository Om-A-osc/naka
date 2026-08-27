import { describe, it, expect } from "vitest";
import { decide } from "../src/decide.js";
import { decideRefund } from "../src/refund-decide.js";
import type { GateCtx } from "../src/types.js";

function baseCtx(overrides: Partial<GateCtx> = {}): GateCtx {
  return {
    now: 1000,
    checkout: { total_paise: 119800, lines: [{ variant_id: "v1", category: "coffee", qty: 1 }] },
    mandate: {
      max_per_checkout_paise: 300000,
      remaining_paise: 600000,
      allowed_categories: ["coffee", "brewing"],
      expires_at: 2_000_000_000,
      agent_pubkey: "PUB",
    },
    agent: { id: "agent_1", status: "active", pubkey: "PUB", spent_today_paise: 0 },
    policy: {
      max_per_checkout_paise: 300000,
      merchant_approval_over_paise: 250000,
      per_agent_daily_cap_paise: 1000000,
      max_qty_per_line: 5,
      kill_switch: false,
    },
    stock: { ok: true, insufficient_variant_ids: [] },
    ...overrides,
  };
}

describe("gate: happy path", () => {
  it("ALLOWs a normal in-bounds cart", () => {
    const d = decide(baseCtx());
    expect(d.outcome).toBe("ALLOW");
    expect(d.rule_hits.every((h) => h.passed)).toBe(true);
  });
});

describe("gate: one test per rule id", () => {
  it("A2_AGENT_ACTIVE denies a suspended agent", () => {
    const d = decide(baseCtx({ agent: { id: "a", status: "suspended", pubkey: "PUB", spent_today_paise: 0 } }));
    expect(d.outcome).toBe("DENY");
    expect(d.rule_hits.find((h) => h.rule_id === "A2_AGENT_ACTIVE")?.passed).toBe(false);
  });

  it("A2_AGENT_ACTIVE denies when the merchant kill switch is on", () => {
    const d = decide(baseCtx({ policy: { ...baseCtx().policy, kill_switch: true } }));
    expect(d.outcome).toBe("DENY");
    expect(d.rule_hits.find((h) => h.rule_id === "A2_AGENT_ACTIVE")?.passed).toBe(false);
  });

  it("B1_MAX_PER_CHECKOUT denies over the merchant per-checkout cap", () => {
    const d = decide(baseCtx({ checkout: { total_paise: 400000, lines: baseCtx().checkout.lines } }));
    expect(d.outcome).toBe("DENY");
    expect(d.rule_hits.find((h) => h.rule_id === "B1_MAX_PER_CHECKOUT")?.passed).toBe(false);
  });

  it("B2_AGENT_DAILY_CAP denies once the agent's daily spend would be exceeded", () => {
    const d = decide(baseCtx({ agent: { id: "a", status: "active", pubkey: "PUB", spent_today_paise: 950000 } }));
    expect(d.outcome).toBe("DENY");
    expect(d.rule_hits.find((h) => h.rule_id === "B2_AGENT_DAILY_CAP")?.passed).toBe(false);
  });

  it("B3_MANDATE_AMOUNT denies over the mandate's remaining/per-checkout cap", () => {
    const d = decide(baseCtx({ mandate: { ...baseCtx().mandate, max_per_checkout_paise: 50000 } }));
    expect(d.outcome).toBe("DENY");
    expect(d.rule_hits.find((h) => h.rule_id === "B3_MANDATE_AMOUNT")?.passed).toBe(false);
  });

  it("B4_MANDATE_EXPIRY denies an expired mandate", () => {
    const d = decide(baseCtx({ mandate: { ...baseCtx().mandate, expires_at: 500 } }));
    expect(d.outcome).toBe("DENY");
    expect(d.rule_hits.find((h) => h.rule_id === "B4_MANDATE_EXPIRY")?.passed).toBe(false);
  });

  it("B5_MANDATE_SCOPE denies an off-category line item", () => {
    const d = decide(
      baseCtx({ checkout: { total_paise: 19900, lines: [{ variant_id: "v9", category: "grocery", qty: 1 }] } })
    );
    expect(d.outcome).toBe("DENY");
    expect(d.rule_hits.find((h) => h.rule_id === "B5_MANDATE_SCOPE")?.passed).toBe(false);
  });

  it("B5_MANDATE_SCOPE denies when the mandate's agent_pubkey does not match the caller", () => {
    const d = decide(baseCtx({ mandate: { ...baseCtx().mandate, agent_pubkey: "OTHER_PUB" } }));
    expect(d.outcome).toBe("DENY");
    expect(d.rule_hits.find((h) => h.rule_id === "B5_MANDATE_SCOPE")?.passed).toBe(false);
  });

  it("B6_MAX_QTY denies a line exceeding the per-line quantity cap", () => {
    const d = decide(
      baseCtx({ checkout: { total_paise: 349000, lines: [{ variant_id: "v1", category: "coffee", qty: 10 }] } })
    );
    expect(d.outcome).toBe("DENY");
    expect(d.rule_hits.find((h) => h.rule_id === "B6_MAX_QTY")?.passed).toBe(false);
  });

  it("B7_COUPON denies an unknown/invalid coupon code", () => {
    const d = decide(baseCtx({ coupon: { code: "MADEUP", valid: false, reason: "unknown_code" } }));
    expect(d.outcome).toBe("DENY");
    expect(d.rule_hits.find((h) => h.rule_id === "B7_COUPON")?.passed).toBe(false);
  });

  it("S1_STOCK denies when the reservation attempt found insufficient stock", () => {
    const d = decide(baseCtx({ stock: { ok: false, insufficient_variant_ids: ["v1"] } }));
    expect(d.outcome).toBe("DENY");
    expect(d.rule_hits.find((h) => h.rule_id === "S1_STOCK")?.passed).toBe(false);
  });

  it("G2_MERCHANT_APPROVAL escalates above the merchant approval threshold", () => {
    const d = decide(baseCtx({ checkout: { total_paise: 284800, lines: baseCtx().checkout.lines } }));
    expect(d.outcome).toBe("NEEDS_HUMAN");
    expect(d.rule_hits.find((h) => h.rule_id === "G2_MERCHANT_APPROVAL")?.passed).toBe(false);
  });
});

describe("gate: refund rules", () => {
  it("R1_REFUND_MERCHANT_ONLY denies a non-merchant requester", () => {
    const d = decideRefund({ requestedBy: "agent", amountPaise: null, capturedPaise: 10000, alreadyRefunded: false, hasApproval: false });
    expect(d.outcome).toBe("DENY");
    expect(d.rule_hits.find((h) => h.rule_id === "R1_REFUND_MERCHANT_ONLY")?.passed).toBe(false);
  });

  it("R2_REFUND_BOUNDS denies an amount greater than captured", () => {
    const d = decideRefund({ requestedBy: "merchant", amountPaise: 99999, capturedPaise: 10000, alreadyRefunded: false, hasApproval: false });
    expect(d.outcome).toBe("DENY");
    expect(d.rule_hits.find((h) => h.rule_id === "R2_REFUND_BOUNDS")?.passed).toBe(false);
  });

  it("R2_REFUND_BOUNDS denies a second refund on the same payment", () => {
    const d = decideRefund({ requestedBy: "merchant", amountPaise: null, capturedPaise: 10000, alreadyRefunded: true, hasApproval: false });
    expect(d.outcome).toBe("DENY");
    expect(d.rule_hits.find((h) => h.rule_id === "R2_REFUND_BOUNDS")?.passed).toBe(false);
  });

  it("R3_REFUND_APPROVAL requires human approval before executing", () => {
    const d = decideRefund({ requestedBy: "merchant", amountPaise: null, capturedPaise: 10000, alreadyRefunded: false, hasApproval: false });
    expect(d.outcome).toBe("NEEDS_HUMAN");
  });

  it("refund ALLOWs once merchant-requested, in-bounds, and approved", () => {
    const d = decideRefund({ requestedBy: "merchant", amountPaise: null, capturedPaise: 10000, alreadyRefunded: false, hasApproval: true });
    expect(d.outcome).toBe("ALLOW");
  });
});
