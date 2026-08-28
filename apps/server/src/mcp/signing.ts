import type { FastifyRequest, FastifyReply } from "fastify";
import type { Db } from "@naka/db";
import { verifyAgentRequest } from "@naka/identity";
import { insertLedgerRow } from "@naka/ledger";

/** Fastify preHandler for every "write" MCP tool and every "scoped read": verifies rule A1_SIGNATURE against the request body exactly as received. */
export function requireAgentSignature(db: Db, tool: string) {
  return async (request: FastifyRequest, reply: FastifyReply) => {
    const headers = {
      "x-naka-agent": request.headers["x-naka-agent"] as string | undefined,
      "x-naka-ts": request.headers["x-naka-ts"] as string | undefined,
      "x-naka-nonce": request.headers["x-naka-nonce"] as string | undefined,
      "x-naka-sig": request.headers["x-naka-sig"] as string | undefined,
    };
    const outcome = verifyAgentRequest(db, headers, request.body ?? {}, tool);
    if (!outcome.ok) {
      insertLedgerRow(db, {
        actor: "system",
        agent_id: headers["x-naka-agent"] ?? null,
        action: "SIGNATURE_REJECTED",
        rule_hits: [outcome.hit],
        inputs: { path: request.url },
      });
      return reply.code(401).send({ error: { code: "SIGNATURE_INVALID", rule_hit: outcome.hit } });
    }
    if (outcome.agent.status !== "active") {
      return reply.code(403).send({ error: { code: "AGENT_SUSPENDED" } });
    }
    (request as any).agentId = outcome.agent.id;
  };
}
