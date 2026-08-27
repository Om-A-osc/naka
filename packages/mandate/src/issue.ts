import type { Db } from "@naka/db";
import { canonicalJson, newId } from "@naka/shared";
import { hashBody, signMessage, signingMessage } from "@naka/identity";
import { MandateBodySchema, type MandateBody, type Mandate } from "./schema.js";

export interface IssueMandateArgs extends MandateBody {
  buyerPublicKeyPem: string;
  buyerPrivateKeyPem: string;
}

/** The buyer signs the mandate body with their own Ed25519 key. */
export function issueMandate(db: Db, args: IssueMandateArgs): Mandate {
  const body = MandateBodySchema.parse({
    merchant_id: args.merchant_id,
    agent_id: args.agent_id,
    agent_pubkey: args.agent_pubkey,
    buyer_ref: args.buyer_ref,
    max_per_checkout_paise: args.max_per_checkout_paise,
    max_total_paise: args.max_total_paise,
    allowed_categories: args.allowed_categories,
    expires_at: args.expires_at,
  });

  const id = newId("mandate");
  const bodyHash = hashBody(canonicalJson(body));
  const message = signingMessage({ subject: id, ts: 0, bodyHash }); // ts=0: mandates don't expire on a replay window, only on expires_at
  const signature = signMessage(message, args.buyerPrivateKeyPem);

  db.prepare(
    `INSERT INTO mandates (id, merchant_id, agent_id, agent_pubkey, buyer_pubkey, buyer_ref,
                            max_per_checkout_paise, max_total_paise, allowed_categories, expires_at, signature, status)
     VALUES (@id,@merchant_id,@agent_id,@agent_pubkey,@buyer_pubkey,@buyer_ref,
             @max_per_checkout_paise,@max_total_paise,@allowed_categories,@expires_at,@signature,'active')`
  ).run({
    id,
    merchant_id: body.merchant_id,
    agent_id: body.agent_id,
    agent_pubkey: body.agent_pubkey,
    buyer_pubkey: args.buyerPublicKeyPem,
    buyer_ref: body.buyer_ref,
    max_per_checkout_paise: body.max_per_checkout_paise,
    max_total_paise: body.max_total_paise,
    allowed_categories: JSON.stringify(body.allowed_categories),
    expires_at: body.expires_at,
    signature,
  });

  return getMandate(db, id)!;
}

export function getMandate(db: Db, id: string): Mandate | undefined {
  const row = db.prepare("SELECT * FROM mandates WHERE id = ?").get(id) as
    | (Omit<Mandate, "allowed_categories"> & { allowed_categories: string })
    | undefined;
  if (!row) return undefined;
  return { ...row, allowed_categories: JSON.parse(row.allowed_categories) };
}

export function revokeMandate(db: Db, id: string): void {
  db.prepare("UPDATE mandates SET status = 'revoked' WHERE id = ?").run(id);
}
