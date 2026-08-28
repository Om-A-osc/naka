import type { FastifyInstance } from "fastify";
import type { Db } from "@naka/db";
import { searchCatalog, getProduct } from "@naka/catalog";
import { createCheckout, updateCheckout, getCheckout, completeCheckout, cancelCheckout, suggestAddons, CheckoutError, UnknownVariantError, policyForCheckout } from "@naka/engine";
import { requireAgentSignature } from "./signing.js";
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
import { env } from "../config/env.js";

/** These eight routes ARE the "MCP tools", named and shaped identically. */
export function registerToolRoutes(app: FastifyInstance, db: Db) {
 // Each tool gets its OWN preHandler bound to its own name.
  const signedFor = (tool: string) => ({ preHandler: requireAgentSignature(db, tool) });

 // Which merchant a call is for.
  const merchantOf = (req: any): string => {
    const agentId = req.agentId as string | undefined;
    if (agentId) {
      const agent = db.prepare("SELECT merchant_id FROM agents WHERE id = ?").get(agentId) as { merchant_id: string } | undefined;
      if (agent) return agent.merchant_id;
    }
    const header = (req.headers?.["x-naka-merchant"] as string | undefined)?.trim();
    return header || env.merchantId;
  };

  app.post("/tools/search_catalog", async (req, reply) => {
    const args = SearchCatalogSchema.parse(req.body ?? {});
    return { results: searchCatalog(db, { ...args, merchant_id: merchantOf(req) }) };
  });

  app.post("/tools/get_product", async (req, reply) => {
    const args = GetProductSchema.parse(req.body ?? {});
    const product = getProduct(db, args.product_id, merchantOf(req));
    if (!product) return reply.code(404).send({ error: { code: "NOT_FOUND" } });
    return product;
  });

  app.post("/tools/create_checkout", signedFor("create_checkout"), async (req, reply) => {
    const args = CreateCheckoutSchema.parse(req.body ?? {});
    try {
      const { view, decision } = createCheckout(db, {
        merchantId: merchantOf(req),
        agentId: (req as any).agentId,
        mandateId: args.mandate_id,
        buyerRef: args.buyer_ref,
        lines: args.line_items,
        couponCode: args.coupon_code,
      });
      if (decision.outcome === "NEEDS_HUMAN") {
        void notifyMerchantEscalation(
          db,
          merchantOf(req),
          `Checkout ${view.checkout_id} needs a human decision (₹${(view.totals.total_paise / 100).toFixed(2)}): ${decision.explanation}`
        );
      }
      return { ...view, decision };
    } catch (err) {
      return handleEngineError(err, reply);
    }
  });

  app.post("/tools/get_checkout", signedFor("get_checkout"), async (req, reply) => {
    const args = GetCheckoutSchema.parse(req.body ?? {});
    const view = getCheckout(db, args.checkout_id);
    if (!view) return reply.code(404).send({ error: { code: "NOT_FOUND" } });
    if (view.agent_id !== (req as any).agentId) return reply.code(403).send({ error: { code: "FORBIDDEN" } });
    return withLastPayment(db, view);
  });

  app.post("/tools/update_checkout", signedFor("update_checkout"), async (req, reply) => {
    const args = UpdateCheckoutSchema.parse(req.body ?? {});
    try {
      const { view, decision } = updateCheckout(db, { checkoutId: args.checkout_id, agentId: (req as any).agentId, lines: args.line_items, couponCode: args.coupon_code });
      if (decision.outcome === "NEEDS_HUMAN") {
        void notifyMerchantEscalation(
          db,
          merchantOf(req),
          `Checkout ${view.checkout_id} needs a human decision (₹${(view.totals.total_paise / 100).toFixed(2)}): ${decision.explanation}`
        );
      }
      return { ...view, decision };
    } catch (err) {
      return handleEngineError(err, reply);
    }
  });

  app.post("/tools/suggest_addons", signedFor("suggest_addons"), async (req, reply) => {
    const args = SuggestAddonsSchema.parse(req.body ?? {});
    return { candidates: suggestAddons(db, args.checkout_id) };
  });

  app.post("/tools/complete_checkout", signedFor("complete_checkout"), async (req, reply) => {
    const args = CompleteCheckoutSchema.parse(req.body ?? {});
    try {
      const { view, decision } = completeCheckout(db, { checkoutId: args.checkout_id, agentId: (req as any).agentId, lineItemsHash: args.line_items_hash });
      return { ...view, decision };
    } catch (err) {
      return handleEngineError(err, reply);
    }
  });

  app.post("/tools/cancel_checkout", signedFor("cancel_checkout"), async (req, reply) => {
    const args = CancelCheckoutSchema.parse(req.body ?? {});
    try {
      const view = cancelCheckout(db, { checkoutId: args.checkout_id, reason: args.reason });
      return view;
    } catch (err) {
      return handleEngineError(err, reply);
    }
  });
}

function withLastPayment(db: Db, view: ReturnType<typeof getCheckout>) {
  if (!view) return view;
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

function handleEngineError(err: unknown, reply: any) {
 // A line naming a variant this shop does not sell is the caller's mistake, a model guessing an id, or another merchant's product.
  if (err instanceof UnknownVariantError) {
    return reply.code(404).send({ error: { code: "UNKNOWN_VARIANT", message: err.message } });
  }
  if (err instanceof CheckoutError) {
    const status = err.code === "NOT_FOUND" ? 404 : err.code === "FORBIDDEN" ? 403 : 409;
    return reply.code(status).send({ error: { code: err.code, message: err.message } });
  }
  throw err;
}
