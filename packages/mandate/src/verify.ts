import { canonicalJson } from "@naka/shared";
import { hashBody, signingMessage, verifyMessage } from "@naka/identity";
import type { Mandate } from "./schema.js";

export interface MandateIntegrity {
  ok: boolean;
  reason?: string;
}

/** Confirms the mandate row has not been tampered with since the buyer signed it. */
export function verifyMandateIntegrity(m: Mandate): MandateIntegrity {
  const body = {
    merchant_id: m.merchant_id,
    agent_id: m.agent_id,
    agent_pubkey: m.agent_pubkey,
    buyer_ref: m.buyer_ref,
    max_per_checkout_paise: m.max_per_checkout_paise,
    max_total_paise: m.max_total_paise,
    allowed_categories: m.allowed_categories,
    expires_at: m.expires_at,
  };
  const bodyHash = hashBody(canonicalJson(body));
  const message = signingMessage({ subject: m.id, ts: 0, bodyHash });
  const ok = verifyMessage(message, m.signature, m.buyer_pubkey);
  return ok ? { ok: true } : { ok: false, reason: "mandate_signature_invalid" };
}
