import type { Db } from "@naka/db";

/** A tiny, honest fault-injection surface: the console can flip `webhook_500` on for N seconds. */
export function setFault(db: Db, name: string, seconds: number): number {
  const expiresAt = Math.floor(Date.now() / 1000) + seconds;
  db.prepare(`INSERT INTO fault_flags (name, value, expires_at) VALUES (?, '1', ?) ON CONFLICT(name) DO UPDATE SET value='1', expires_at=excluded.expires_at`).run(name, expiresAt);
  return expiresAt;
}

export function clearFault(db: Db, name: string): void {
  db.prepare(`DELETE FROM fault_flags WHERE name = ?`).run(name);
}

export function isFaultActive(db: Db, name: string): boolean {
  const row = db.prepare(`SELECT expires_at FROM fault_flags WHERE name = ?`).get(name) as { expires_at: number } | undefined;
  if (!row) return false;
  if (row.expires_at < Math.floor(Date.now() / 1000)) {
    clearFault(db, name);
    return false;
  }
  return true;
}
