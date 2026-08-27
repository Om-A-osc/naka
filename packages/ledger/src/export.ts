import type { Db } from "@naka/db";

/** Streams the whole ledger as JSONL, one row per line, in sequence order. */
export function* exportLedgerJsonl(db: Db): Generator<string> {
  const stmt = db.prepare("SELECT * FROM ledger ORDER BY seq ASC");
  for (const row of stmt.iterate()) {
    yield JSON.stringify(row);
  }
}

export function exportLedgerArray(db: Db): unknown[] {
  return db.prepare("SELECT * FROM ledger ORDER BY seq ASC").all();
}

const CSV_COLUMNS = [
  "seq", "ts", "actor", "agent_id", "action", "decision", "rule_hits", "inputs",
  "checkout_id", "attempt_id", "razorpay_order_id", "razorpay_payment_id",
  "razorpay_refund_id", "event_id", "amount_paise", "prev_hash", "hash",
] as const;

function csvEscape(value: unknown): string {
  if (value === null || value === undefined) return "";
  const s = String(value);
  return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

/** The ledger as CSV, same rows and order as exportLedgerArray, for opening in a spreadsheet during a demo. */
export function exportLedgerCsv(db: Db): string {
  const rows = exportLedgerArray(db) as Array<Record<string, unknown>>;
  const lines = [CSV_COLUMNS.join(",")];
  for (const row of rows) {
    lines.push(CSV_COLUMNS.map((c) => csvEscape(row[c])).join(","));
  }
  return lines.join("\n");
}
