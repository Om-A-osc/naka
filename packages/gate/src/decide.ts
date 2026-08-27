import type { Decision, GateCtx, RuleHit } from "./types.js";
import { explain } from "./templates.js";

/** The policy gate. Pure function: no database, no network, no clock reads beyond the `now` passed in. Every check is one comparison. */
export function decide(ctx: GateCtx): Decision {
  const hits: RuleHit[] = [];
  const push = (rule_id: string, passed: boolean, left: string | number, right: string | number) => {
    hits.push({ rule_id, passed, left, right });
    return passed;
  };

  const okA2 = push(
    "A2_AGENT_ACTIVE",
    ctx.agent.status === "active" && !ctx.policy.kill_switch,
    ctx.agent.status,
    ctx.policy.kill_switch ? "kill_switch_on" : "kill_switch_off"
  );

  const okB1 = push(
    "B1_MAX_PER_CHECKOUT",
    ctx.checkout.total_paise <= ctx.policy.max_per_checkout_paise,
    ctx.checkout.total_paise,
    ctx.policy.max_per_checkout_paise
  );

  const okB2 = push(
    "B2_AGENT_DAILY_CAP",
    ctx.agent.spent_today_paise + ctx.checkout.total_paise <= ctx.policy.per_agent_daily_cap_paise,
    ctx.agent.spent_today_paise + ctx.checkout.total_paise,
    ctx.policy.per_agent_daily_cap_paise
  );

  const mandateCap = Math.min(ctx.mandate.max_per_checkout_paise, ctx.mandate.remaining_paise);
  const okB3 = push("B3_MANDATE_AMOUNT", ctx.checkout.total_paise <= mandateCap, ctx.checkout.total_paise, mandateCap);

  const okB4 = push("B4_MANDATE_EXPIRY", ctx.now < ctx.mandate.expires_at, ctx.now, ctx.mandate.expires_at);

  const scopeOk =
    ctx.mandate.agent_pubkey === ctx.agent.pubkey &&
    ctx.checkout.lines.every((l) => ctx.mandate.allowed_categories.includes(l.category));
  const okB5 = push(
    "B5_MANDATE_SCOPE",
    scopeOk,
    ctx.checkout.lines.map((l) => l.category).join(","),
    ctx.mandate.allowed_categories.join(",")
  );

  const maxQty = Math.max(0, ...ctx.checkout.lines.map((l) => l.qty));
  const okB6 = push("B6_MAX_QTY", maxQty <= ctx.policy.max_qty_per_line, maxQty, ctx.policy.max_qty_per_line);

  let okB7 = true;
  if (ctx.coupon) {
    okB7 = push("B7_COUPON", ctx.coupon.valid, ctx.coupon.reason ?? ctx.coupon.code, "valid_coupon");
  }

  const okS1 = push(
    "S1_STOCK",
    ctx.stock.ok,
    ctx.stock.insufficient_variant_ids.join(",") || "none",
    "in_stock"
  );

  const allHardChecksPass = okA2 && okB1 && okB2 && okB3 && okB4 && okB5 && okB6 && okB7 && okS1;

  if (!allHardChecksPass) {
    const firstFailure = hits.find((h) => !h.passed)!;
    return { outcome: "DENY", rule_hits: hits, explanation: explain(firstFailure) };
  }

  const withinAutoApprove = push(
    "G2_MERCHANT_APPROVAL",
    ctx.checkout.total_paise <= ctx.policy.merchant_approval_over_paise,
    ctx.checkout.total_paise,
    ctx.policy.merchant_approval_over_paise
  );

  if (!withinAutoApprove) {
    return { outcome: "NEEDS_HUMAN", rule_hits: hits, explanation: explain(hits.at(-1)!) };
  }

  return { outcome: "ALLOW", rule_hits: hits, explanation: "All checks passed." };
}
