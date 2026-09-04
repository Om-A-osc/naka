import type { Db } from "@naka/db";
import { searchCatalog, getProduct } from "@naka/catalog";
import { createCheckout, updateCheckout, getCheckout, completeCheckout, cancelCheckout, suggestAddons, CheckoutError, UnknownVariantError, policyForCheckout } from "@naka/engine";
import { notifyMerchantEscalation } from "../channels/telegram.js";
import {
  SearchCatalogSchema,
  GetProductSchema,
  CreateCheckoutSchema,
  UpdateCheckoutSchema,
  GetCheckoutSchema,
  SuggestAddonsSchema,
  CompleteCheckoutSchema,
  CancelCheckoutSchema,
} from "./schemas.js";

/** The eight tools, independent of how they were reached. */
export const TOOL_NAMES = ["search_catalog", "get_product", "create_checkout", "get_checkout", "update_checkout", "suggest_addons", "complete_checkout", "cancel_checkout"] as const;
export type ToolName = (typeof TOOL_NAMES)[number];

export interface ToolContext {
  merchantId: string;
  /** Present only when the caller proved who it is (signature or token). Reads work without it. */
  agentId?: string;
}

export interface ToolOutcome {
  status: number;
  body: unknown;
}

const ok = (body: unknown): ToolOutcome => ({ status: 200, body });
const fail = (status: number, code: string, message?: string): ToolOutcome => ({ status, body: { error: message ? { code, message } : { code } } });

export function runTool(db: Db, ctx: ToolContext, name: ToolName, rawArgs: unknown): ToolOutcome {
  const args = rawArgs ?? {};

  if (name === "search_catalog") {
    const a = SearchCatalogSchema.parse(args);
    return ok({ results: searchCatalog(db, { ...a, merchant_id: ctx.merchantId }) });
  }
  if (name === "get_product") {
    const a = GetProductSchema.parse(args);
    const product = getProduct(db, a.product_id, ctx.merchantId);
    return product ? ok(product) : fail(404, "NOT_FOUND");
  }

  const agentId = ctx.agentId;
  if (!agentId) return fail(401, "UNAUTHENTICATED", "this tool needs an identified agent");

  // A checkout id is not a capability.
  const owned = (checkoutId: string): ToolOutcome | null => {
    const view = getCheckout(db, checkoutId);
    if (!view) return fail(404, "NOT_FOUND");
    if (view.agent_id !== agentId) return fail(403, "FORBIDDEN", "this checkout belongs to another agent");
    return null;
  };

  const escalate = (checkoutId: string, totalPaise: number, explanation: string) =>
    void notifyMerchantEscalation(db, ctx.merchantId, `Checkout ${checkoutId} needs a human decision (₹${(totalPaise / 100).toFixed(2)}): ${explanation}`);

  try {
    switch (name) {
      case "create_checkout": {
        const a = CreateCheckoutSchema.parse(args);
        const { view, decision } = createCheckout(db, {
          merchantId: ctx.merchantId,
          agentId,
          mandateId: a.mandate_id,
          buyerRef: a.buyer_ref,
          lines: a.line_items,
          couponCode: a.coupon_code,
        });
        if (decision.outcome === "NEEDS_HUMAN") escalate(view.checkout_id, view.totals.total_paise, decision.explanation);
        return ok({ ...view, decision });
      }
      case "get_checkout": {
        const a = GetCheckoutSchema.parse(args);
        const view = getCheckout(db, a.checkout_id);
        if (!view) return fail(404, "NOT_FOUND");
        if (view.agent_id !== agentId) return fail(403, "FORBIDDEN");
        return ok(withLastPayment(db, view));
      }
      case "update_checkout": {
        const a = UpdateCheckoutSchema.parse(args);
        const { view, decision } = updateCheckout(db, { checkoutId: a.checkout_id, agentId, lines: a.line_items, couponCode: a.coupon_code });
        if (decision.outcome === "NEEDS_HUMAN") escalate(view.checkout_id, view.totals.total_paise, decision.explanation);
        return ok({ ...view, decision });
      }
      case "suggest_addons": {
        const a = SuggestAddonsSchema.parse(args);
        return owned(a.checkout_id) ?? ok({ candidates: suggestAddons(db, a.checkout_id) });
      }
      case "complete_checkout": {
        const a = CompleteCheckoutSchema.parse(args);
        const { view, decision } = completeCheckout(db, { checkoutId: a.checkout_id, agentId, lineItemsHash: a.line_items_hash });
        return ok({ ...view, decision });
      }
      case "cancel_checkout": {
        const a = CancelCheckoutSchema.parse(args);
        return owned(a.checkout_id) ?? ok(cancelCheckout(db, { checkoutId: a.checkout_id, reason: a.reason }));
      }
      default:
        return fail(404, "UNKNOWN_TOOL", String(name));
    }
  } catch (err) {
    return engineError(err);
  }
}

function withLastPayment(db: Db, view: NonNullable<ReturnType<typeof getCheckout>>) {
  const attempt = db
    .prepare("SELECT * FROM payment_attempts WHERE checkout_id = ? ORDER BY attempt_no DESC LIMIT 1")
    .get(view.checkout_id) as any;
  if (!attempt) return view;
  const { policy } = policyForCheckout(db, view.checkout_id);
  const retriesRemaining = Math.max(0, policy.max_payment_attempts - attempt.attempt_no);
  return {
    ...view,
    last_payment: {
      status: attempt.status,
      category: attempt.failure_category ?? null,
      retries_remaining: retriesRemaining,
      attempt_no: attempt.attempt_no,
    },
  };
}

function engineError(err: unknown): ToolOutcome {
  // A line naming a variant this shop does not sell is the caller's mistake, a model guessing an id, or another merchant's product.
  if (err instanceof UnknownVariantError) return fail(404, "UNKNOWN_VARIANT", err.message);
  if (err instanceof CheckoutError) {
    const status = err.code === "NOT_FOUND" ? 404 : err.code === "FORBIDDEN" ? 403 : 409;
    return fail(status, err.code, err.message);
  }
  throw err;
}
