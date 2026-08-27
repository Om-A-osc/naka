import type { Db } from "@naka/db";
import { canonicalJson, redact, sha256hex } from "@naka/shared";
import type { LedgerRowInput, LedgerRow } from "./types.js";

export const GENESIS_HASH = "0".repeat(64);

function lastHash(db: Db): string {
  const row = db.prepare("SELECT hash FROM ledger ORDER BY seq DESC LIMIT 1").get() as { hash: string } | undefined;
  return row?.hash ?? GENESIS_HASH;
}

/** The exact set of columns that end up in the `ledger` table row, in the exact shape SQLite will hand back on a later SELECT. */
function storedShape(input: LedgerRowInput, ts: string, prevHash: string): Record<string, unknown> {
  const redacted = redact(input) as LedgerRowInput;
  return {
    ts,
    actor: redacted.actor,
    agent_id: redacted.agent_id ?? null,
    action: redacted.action,
    decision: redacted.decision ?? null,
    rule_hits: redacted.rule_hits ? JSON.stringify(redacted.rule_hits) : null,
    inputs: redacted.inputs ? JSON.stringify(redacted.inputs) : null,
    checkout_id: redacted.checkout_id ?? null,
    attempt_id: redacted.attempt_id ?? null,
    razorpay_order_id: redacted.razorpay_order_id ?? null,
    razorpay_payment_id: redacted.razorpay_payment_id ?? null,
    razorpay_refund_id: redacted.razorpay_refund_id ?? null,
    event_id: redacted.event_id ?? null,
    amount_paise: redacted.amount_paise ?? null,
    prev_hash: prevHash,
  };
}

/** Insert one ledger row inside the CALLER's transaction. */
export function insertLedgerRow(db: Db, input: LedgerRowInput): LedgerRow {
  const prevHash = lastHash(db);
  const ts = new Date().toISOString();
  const shape = storedShape(input, ts, prevHash);
  const hash = sha256hex(prevHash + canonicalJson(shape));

  const result = db
    .prepare(
      `INSERT INTO ledger (ts, actor, agent_id, action, decision, rule_hits, inputs, checkout_id, attempt_id,
                            razorpay_order_id, razorpay_payment_id, razorpay_refund_id, event_id, amount_paise,
                            prev_hash, hash)
       VALUES (@ts,@actor,@agent_id,@action,@decision,@rule_hits,@inputs,@checkout_id,@attempt_id,
               @razorpay_order_id,@razorpay_payment_id,@razorpay_refund_id,@event_id,@amount_paise,
               @prev_hash,@hash)`
    )
    .run({ ...shape, hash });

  return { seq: Number(result.lastInsertRowid), ts, prev_hash: prevHash, hash, ...input };
}

/** Standalone atomic append, for callers with no larger transaction of their own. */
export function appendLedger(db: Db, input: LedgerRowInput): LedgerRow {
  return db.transaction(() => insertLedgerRow(db, input))();
}
