import type { FastifyInstance } from "fastify";
import type { Db } from "@naka/db";
import { verifyAndApplyWebhook } from "./apply.js";
import type { Tenants } from "../tenants.js";

export async function registerWebhookRoutes(app: FastifyInstance, db: Db, tenants: Tenants) {
  // Encapsulated plugin: this raw-buffer content-type parser applies ONLY to routes registered inside this function.
  await app.register(async (scoped) => {
    // BOTH parsers are required, and the application/json one is the load- bearing half.
    scoped.addContentTypeParser("application/json", { parseAs: "buffer" }, (_req, body, done) => done(null, body));
    scoped.addContentTypeParser("*", { parseAs: "buffer" }, (_req, body, done) => done(null, body));

    // One URL per merchant, each verified with that merchant's own webhook secret.
    const handle = (merchantId: string) => async (req: any, reply: any) => {
      const raw = req.body as Buffer;
      const outcome = verifyAndApplyWebhook(db, tenants.secretsFor(merchantId), raw, {
        signature: req.headers["x-razorpay-signature"] as string | undefined,
        eventId: req.headers["x-razorpay-event-id"] as string | undefined,
      });
      return reply.code(outcome.status).send(outcome.body ?? "");
    };
    scoped.post("/webhooks/razorpay", { bodyLimit: 1_048_576 }, handle(tenants.defaultMerchantId));
    scoped.post("/webhooks/razorpay/:merchantId", { bodyLimit: 1_048_576 }, async (req: any, reply: any) =>
      handle(req.params.merchantId)(req, reply)
    );
  });
}
