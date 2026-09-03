import type { FastifyInstance, FastifyReply } from "fastify";
import type { Db } from "@naka/db";
import { requireAgentSignature } from "./signing.js";
import { runTool, type ToolName, type ToolOutcome } from "./dispatch.js";
import { env } from "../config/env.js";

/** These eight routes ARE the buyer-facing "MCP tools", named and shaped identically, exposed as plain signed HTTP+JSON. */
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

  const send = (reply: FastifyReply, outcome: ToolOutcome) => reply.code(outcome.status).send(outcome.body);
  const open = (name: ToolName) => async (req: any, reply: FastifyReply) => send(reply, runTool(db, { merchantId: merchantOf(req) }, name, req.body ?? {}));
  const signed = (name: ToolName) => async (req: any, reply: FastifyReply) => send(reply, runTool(db, { merchantId: merchantOf(req), agentId: req.agentId }, name, req.body ?? {}));

  app.post("/tools/search_catalog", open("search_catalog"));
  app.post("/tools/get_product", open("get_product"));
  for (const name of ["create_checkout", "get_checkout", "update_checkout", "suggest_addons", "complete_checkout", "cancel_checkout"] as const) {
    app.post(`/tools/${name}`, signedFor(name), signed(name));
  }
}
