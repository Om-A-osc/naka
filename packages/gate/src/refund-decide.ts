import type { Decision, RuleHit } from "./types.js";
import { explain } from "./templates.js";

export interface RefundGateCtx {
  requestedBy: "merchant" | "agent" | "buyer";
  amountPaise: number | null; // null = full
  capturedPaise: number;
  alreadyRefunded: boolean;
  hasApproval: boolean; // an un-expired, approved approval token exists
}

/** Refunds are the second money action through the gate. */
export function decideRefund(ctx: RefundGateCtx): Decision {
  const hits: RuleHit[] = [];
  const push = (rule_id: string, passed: boolean, left: string | number, right: string | number) => {
    hits.push({ rule_id, passed, left, right });
    return passed;
  };

  const okR1 = push("R1_REFUND_MERCHANT_ONLY", ctx.requestedBy === "merchant", ctx.requestedBy, "merchant");

  const amount = ctx.amountPaise ?? ctx.capturedPaise;
  const boundsOk = amount > 0 && amount <= ctx.capturedPaise && !ctx.alreadyRefunded;
  const okR2 = push(
    "R2_REFUND_BOUNDS",
    boundsOk,
    `${amount}/${ctx.alreadyRefunded ? "already_refunded" : "not_refunded"}`,
    `<=${ctx.capturedPaise}`
  );

  if (!okR1 || !okR2) {
    const first = hits.find((h) => !h.passed)!;
    return { outcome: "DENY", rule_hits: hits, explanation: explain(first) };
  }

  const okR3 = push("R3_REFUND_APPROVAL", ctx.hasApproval, ctx.hasApproval ? "approved" : "pending", "approved");
  if (!okR3) {
    return { outcome: "NEEDS_HUMAN", rule_hits: hits, explanation: explain(hits.at(-1)!) };
  }

  return { outcome: "ALLOW", rule_hits: hits, explanation: "Refund approved." };
}
