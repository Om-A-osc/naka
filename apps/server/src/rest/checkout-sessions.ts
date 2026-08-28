import type { FastifyInstance } from "fastify";
import type { Db } from "@naka/db";
import { createCheckout, updateCheckout, getCheckout, completeCheckout, cancelCheckout, CheckoutError } from "@naka/engine";
import { requireAgentSignature } from "../mcp/signing.js";
import { withIdempotency } from "./idempotency.js";
import { CreateCheckoutSchema, UpdateCheckoutSchema, CompleteCheckoutSchema, CancelCheckoutSchema } from "../mcp/schemas.js";
import { env } from "../config/env.js";

/** The UCP-shaped REST wrapper: the same checkout state machine as /tools/*. */
export function registerCheckoutSessionRoutes(app: FastifyInstance, db: Db) {
  const signedFor = (tool: string) => ({ preHandler: requireAgentSignature(db, tool) });

  app.post("/checkout-sessions", signedFor("create_checkout"), async (req, reply) => {
    const idemKey = req.headers["idempotency-key"] as string | undefined;
    const result = withIdempotency(db, "checkout-sessions:create", idemKey, req.body, () => {
      try {
        const args = CreateCheckoutSchema.parse(req.body ?? {});
        const { view, decision } = createCheckout(db, {
          merchantId: env.merchantId,
          agentId: (req as any).agentId,
          mandateId: args.mandate_id,
          buyerRef: args.buyer_ref,
          lines: args.line_items,
          couponCode: args.coupon_code,
        });
        return { status: 200, body: { ...view, decision } };
      } catch (err) {
        return errorResult(err);
      }
    });
    return reply.code(result.status).send(result.body);
  });

  app.get("/checkout-sessions/:id", signedFor("get_checkout"), async (req, reply) => {
    const { id } = req.params as { id: string };
    const view = getCheckout(db, id);
    if (!view) return reply.code(404).send({ error: { code: "NOT_FOUND" } });
    if (view.agent_id !== (req as any).agentId) return reply.code(403).send({ error: { code: "FORBIDDEN" } });
    return view;
  });

  app.put("/checkout-sessions/:id", signedFor("update_checkout"), async (req, reply) => {
    const { id } = req.params as { id: string };
    const idemKey = req.headers["idempotency-key"] as string | undefined;
    const result = withIdempotency(db, "checkout-sessions:update", idemKey, { id, body: req.body }, () => {
      try {
        const args = UpdateCheckoutSchema.parse({ ...(req.body as any), checkout_id: id });
        const { view, decision } = updateCheckout(db, { checkoutId: id, agentId: (req as any).agentId, lines: args.line_items, couponCode: args.coupon_code });
        return { status: 200, body: { ...view, decision } };
      } catch (err) {
        return errorResult(err);
      }
    });
    return reply.code(result.status).send(result.body);
  });

  app.post("/checkout-sessions/:id/complete", signedFor("complete_checkout"), async (req, reply) => {
    const { id } = req.params as { id: string };
    const idemKey = req.headers["idempotency-key"] as string | undefined;
    const result = withIdempotency(db, "checkout-sessions:complete", idemKey, { id, body: req.body }, () => {
      try {
        const args = CompleteCheckoutSchema.parse({ ...(req.body as any), checkout_id: id });
        const { view, decision } = completeCheckout(db, { checkoutId: id, agentId: (req as any).agentId, lineItemsHash: args.line_items_hash });
        return { status: 200, body: { ...view, decision } };
      } catch (err) {
        return errorResult(err);
      }
    });
    return reply.code(result.status).send(result.body);
  });

  app.post("/checkout-sessions/:id/cancel", signedFor("cancel_checkout"), async (req, reply) => {
    const { id } = req.params as { id: string };
    const idemKey = req.headers["idempotency-key"] as string | undefined;
    const result = withIdempotency(db, "checkout-sessions:cancel", idemKey, { id, body: req.body }, () => {
      try {
        const args = CancelCheckoutSchema.parse({ ...(req.body as any), checkout_id: id });
        const view = cancelCheckout(db, { checkoutId: id, reason: args.reason });
        return { status: 200, body: view };
      } catch (err) {
        return errorResult(err);
      }
    });
    return reply.code(result.status).send(result.body);
  });
}

function errorResult(err: unknown): { status: number; body: unknown } {
  if (err instanceof CheckoutError) {
    const status = err.code === "NOT_FOUND" ? 404 : err.code === "FORBIDDEN" ? 403 : 409;
    return { status, body: { error: { code: err.code, message: err.message } } };
  }
  throw err;
}
