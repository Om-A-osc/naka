import type { Db } from "@naka/db";
import { sha256hex } from "@naka/shared";
import { currentPolicy, PolicySchema, type Policy } from "./policy.js";

export interface MerchantCredentials {
  razorpay_key_id: string | null;
  razorpay_key_secret: string | null;
  webhook_secret: string | null;
  console_password_hash: string | null;
}

type PolicyBundle = { policy: Policy; version: number; hash: string };

/** Policy is per merchant. `data/policy.json` remains the baseline every merchant starts. */
export function policyFor(db: Db, merchantId: string): PolicyBundle {
  const base = currentPolicy();
  const row = db.prepare("SELECT policy_json FROM merchants WHERE id = ?").get(merchantId) as { policy_json: string | null } | undefined;
  if (!row?.policy_json) return base;
  try {
    const policy = PolicySchema.parse({ ...base.policy, ...JSON.parse(row.policy_json) });
    return { policy, version: base.version, hash: sha256hex(row.policy_json) };
  } catch {
    // A corrupt override must not take a merchant's checkouts down; the baseline is always a valid policy.
    return base;
  }
}

export function policyForCheckout(db: Db, checkoutId: string): PolicyBundle {
  const row = db.prepare("SELECT merchant_id FROM checkouts WHERE id = ?").get(checkoutId) as { merchant_id: string } | undefined;
  return row ? policyFor(db, row.merchant_id) : currentPolicy();
}

export function policyForRefund(db: Db, refundId: string): PolicyBundle {
  const row = db.prepare("SELECT checkout_id FROM refunds WHERE id = ?").get(refundId) as { checkout_id: string } | undefined;
  return row ? policyForCheckout(db, row.checkout_id) : currentPolicy();
}

/** Persists a partial override for one merchant; returns the effective policy. */
export function setMerchantPolicy(db: Db, merchantId: string, patch: Partial<Policy>): Policy {
  const next = PolicySchema.parse({ ...policyFor(db, merchantId).policy, ...patch });
  db.prepare("UPDATE merchants SET policy_json = ? WHERE id = ?").run(JSON.stringify(next), merchantId);
  return next;
}

export function merchantCredentials(db: Db, merchantId: string): MerchantCredentials | undefined {
  return db
    .prepare("SELECT razorpay_key_id, razorpay_key_secret, webhook_secret, console_password_hash FROM merchants WHERE id = ?")
    .get(merchantId) as MerchantCredentials | undefined;
}
