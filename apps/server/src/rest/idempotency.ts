import type { Db } from "@naka/db";
import { canonicalJson, sha256hex } from "@naka/shared";

export interface IdempotentResult {
  replayed: boolean;
  status: number;
  body: unknown;
}

/** UCP REST binding: "state-modifying operations SHOULD support idempotency ... */
export function withIdempotency(db: Db, scope: string, key: string | undefined, body: unknown, run: () => { status: number; body: unknown }): IdempotentResult {
  if (!key) {
    const r = run();
    return { replayed: false, status: r.status, body: r.body };
  }
  const requestHash = sha256hex(canonicalJson(body ?? {}));
  const existing = db.prepare("SELECT * FROM idempotency_keys WHERE key = ?").get(key) as
    | { request_hash: string; status: number; response: string }
    | undefined;
  if (existing) {
    if (existing.request_hash !== requestHash) {
      return { replayed: true, status: 409, body: { error: { code: "IDEMPOTENCY_KEY_CONFLICT", message: "Idempotency-Key reused with a different request body" } } };
    }
    return { replayed: true, status: existing.status, body: JSON.parse(existing.response) };
  }
  const result = run();
  if (result.status >= 200 && result.status < 300) {
    db.prepare(`INSERT OR IGNORE INTO idempotency_keys (key, scope, request_hash, status, response) VALUES (?, ?, ?, ?, ?)`).run(
      key,
      scope,
      requestHash,
      result.status,
      JSON.stringify(result.body)
    );
  }
  return { replayed: false, status: result.status, body: result.body };
}
