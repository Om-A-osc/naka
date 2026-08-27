import type { Db } from "@naka/db";
import { getMandate, mandateRemainingPaise, verifyMandateIntegrity } from "@naka/mandate";
import { getAgent } from "@naka/identity";
import type { GateCtx } from "@naka/gate";

export interface MandateAgentCtx {
  mandate: GateCtx["mandate"];
  agent: GateCtx["agent"];
  error?: string; // set if the mandate/agent could not be resolved at all
}

/** Assembles the mandate+agent portion of GateCtx from the database, or returns an error string for a hard failure. */
export function buildMandateAgentCtx(db: Db, mandateId: string): MandateAgentCtx {
  const mandate = getMandate(db, mandateId);
  if (!mandate) return { error: "MANDATE_NOT_FOUND", mandate: emptyMandate(), agent: emptyAgent() };
  if (mandate.status !== "active") return { error: `MANDATE_${mandate.status.toUpperCase()}`, mandate: emptyMandate(), agent: emptyAgent() };

  const integrity = verifyMandateIntegrity(mandate);
  if (!integrity.ok) return { error: "MANDATE_TAMPERED", mandate: emptyMandate(), agent: emptyAgent() };

  const agent = getAgent(db, mandate.agent_id);
  if (!agent) return { error: "AGENT_NOT_FOUND", mandate: emptyMandate(), agent: emptyAgent() };

  const remaining = mandateRemainingPaise(db, mandateId, mandate.max_total_paise);
  const spentToday = agentSpentToday(db, agent.id);

  return {
    mandate: {
      max_per_checkout_paise: mandate.max_per_checkout_paise,
      remaining_paise: remaining,
      allowed_categories: mandate.allowed_categories,
      expires_at: mandate.expires_at,
      agent_pubkey: mandate.agent_pubkey,
    },
    agent: {
      id: agent.id,
      status: agent.status,
      pubkey: agent.pubkey,
      spent_today_paise: spentToday,
    },
  };
}

function agentSpentToday(db: Db, agentId: string): number {
  const row = db
    .prepare(
      `SELECT COALESCE(SUM(total_paise), 0) AS spent
       FROM checkouts
       WHERE agent_id = ? AND status_rank >= 3 AND date(created_at) = date('now')`
    )
    .get(agentId) as { spent: number };
  return row.spent;
}

function emptyMandate(): GateCtx["mandate"] {
  return { max_per_checkout_paise: 0, remaining_paise: 0, allowed_categories: [], expires_at: 0, agent_pubkey: "" };
}
function emptyAgent(): GateCtx["agent"] {
  return { id: "", status: "suspended", pubkey: "", spent_today_paise: 0 };
}
