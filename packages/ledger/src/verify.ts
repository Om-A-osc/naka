import type { Db } from "@naka/db";
import { canonicalJson, sha256hex } from "@naka/shared";
import { GENESIS_HASH } from "./append.js";

export interface VerifyResult {
  ok: boolean;
  checked: number;
  first_bad_seq: number | null;
}

/** Recomputes the hash chain from genesis and confirms every row's stored hash matches. */
export function verifyLedger(db: Db): VerifyResult {
  const rows = db
    .prepare(
      `SELECT seq, ts, actor, agent_id, action, decision, rule_hits, inputs, checkout_id, attempt_id,
              razorpay_order_id, razorpay_payment_id, razorpay_refund_id, event_id, amount_paise, prev_hash, hash
       FROM ledger ORDER BY seq ASC`
    )
    .all() as Array<Record<string, unknown>>;

  let expectedPrev = GENESIS_HASH;
  let checked = 0;
  for (const row of rows) {
    if (row.prev_hash !== expectedPrev) return { ok: false, checked, first_bad_seq: row.seq as number };
    const { seq, hash, prev_hash, ...rest } = row;
    const canon = canonicalJson({ ...rest, ts: row.ts, prev_hash: expectedPrev });
    const recomputed = sha256hex((expectedPrev as string) + canon);
    if (recomputed !== hash) return { ok: false, checked, first_bad_seq: seq as number };
    expectedPrev = hash as string;
    checked++;
  }
  return { ok: true, checked, first_bad_seq: null };
}
