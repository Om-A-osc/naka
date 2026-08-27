import type { Db } from "@naka/db";
import { newId } from "@naka/shared";

export interface ReservationAttempt {
  ok: boolean;
  insufficient_variant_ids: string[];
}

/** Atomically holds stock for a checkout's line items. */
export function reserveStock(
  db: Db,
  checkoutId: string,
  lines: Array<{ variant_id: string; quantity: number }>,
  ttlSeconds: number
): ReservationAttempt {
  return db.transaction((): ReservationAttempt => {
    releaseExpiredInner(db); // reclaim anyone's abandoned holds before judging availability
    releaseReservationsInner(db, checkoutId); // idempotent: clear any prior hold for this checkout first

    const insufficient: string[] = [];
    for (const line of lines) {
      const v = db.prepare("SELECT stock_qty, reserved_qty FROM variants WHERE id = ?").get(line.variant_id) as
        | { stock_qty: number; reserved_qty: number }
        | undefined;
      if (!v || v.stock_qty - v.reserved_qty < line.quantity) insufficient.push(line.variant_id);
    }
    if (insufficient.length > 0) return { ok: false, insufficient_variant_ids: insufficient };

    const expiresAt = Math.floor(Date.now() / 1000) + ttlSeconds;
    for (const line of lines) {
      db.prepare("UPDATE variants SET reserved_qty = reserved_qty + ? WHERE id = ?").run(line.quantity, line.variant_id);
      db.prepare(
        `INSERT INTO reservations (id, checkout_id, variant_id, qty, expires_at, status) VALUES (?, ?, ?, ?, ?, 'held')`
      ).run(newId("resv"), checkoutId, line.variant_id, line.quantity, expiresAt);
    }
    return { ok: true, insufficient_variant_ids: [] };
  })();
}

function releaseReservationsInner(db: Db, checkoutId: string): void {
  const held = db.prepare("SELECT * FROM reservations WHERE checkout_id = ? AND status = 'held'").all(checkoutId) as Array<{
    id: string;
    variant_id: string;
    qty: number;
  }>;
  for (const r of held) {
    db.prepare("UPDATE variants SET reserved_qty = MAX(0, reserved_qty - ?) WHERE id = ?").run(r.qty, r.variant_id);
    db.prepare("UPDATE reservations SET status = 'released' WHERE id = ?").run(r.id);
  }
}

export function releaseReservations(db: Db, checkoutId: string): void {
  db.transaction(() => releaseReservationsInner(db, checkoutId))();
}

function releaseExpiredInner(db: Db): number {
  const expired = db
    .prepare("SELECT id, variant_id, qty FROM reservations WHERE status = 'held' AND expires_at < ?")
    .all(Math.floor(Date.now() / 1000)) as Array<{ id: string; variant_id: string; qty: number }>;
  for (const r of expired) {
    db.prepare("UPDATE variants SET reserved_qty = MAX(0, reserved_qty - ?) WHERE id = ?").run(r.qty, r.variant_id);
    // 'released', not a new 'expired' status: the schema's CHECK constraint allows only held/released/consumed, and lapsing is a release.
    db.prepare("UPDATE reservations SET status = 'released' WHERE id = ?").run(r.id);
  }
  return expired.length;
}

/** Reclaims stock from holds whose TTL has passed. */
export function releaseExpiredReservations(db: Db): number {
  return db.transaction(() => releaseExpiredInner(db))();
}

/** On a completed checkout: convert the held reservation into a real stock decrement. */
export function consumeReservations(db: Db, checkoutId: string): void {
  db.transaction(() => {
    const held = db.prepare("SELECT * FROM reservations WHERE checkout_id = ? AND status = 'held'").all(checkoutId) as Array<{
      id: string;
      variant_id: string;
      qty: number;
    }>;
    for (const r of held) {
      db.prepare("UPDATE variants SET stock_qty = MAX(0, stock_qty - ?), reserved_qty = MAX(0, reserved_qty - ?) WHERE id = ?").run(
        r.qty,
        r.qty,
        r.variant_id
      );
      db.prepare("UPDATE reservations SET status = 'consumed' WHERE id = ?").run(r.id);
    }
  })();
}

export function extendReservations(db: Db, checkoutId: string, extendSeconds: number): void {
  db.prepare("UPDATE reservations SET expires_at = expires_at + ? WHERE checkout_id = ? AND status = 'held'").run(
    extendSeconds,
    checkoutId
  );
}

export function reservationExpired(db: Db, checkoutId: string): boolean {
  const row = db
    .prepare("SELECT MIN(expires_at) AS min_exp FROM reservations WHERE checkout_id = ? AND status = 'held'")
    .get(checkoutId) as { min_exp: number | null };
  if (row.min_exp === null) return false; // nothing held (e.g. denied cart), not an expiry concern
  return row.min_exp < Math.floor(Date.now() / 1000);
}
