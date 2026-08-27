import type { Db } from "@naka/db";
import { paise, type Paise } from "@naka/shared";

/** "Spent so far" against a mandate = total_paise of every checkout on that mandate that has reached complete_in_progress or completed. */
export function mandateSpentPaise(db: Db, mandateId: string): Paise {
  const row = db
    .prepare(
      `SELECT COALESCE(SUM(total_paise), 0) AS spent
       FROM checkouts
       WHERE mandate_id = ? AND status_rank >= 3`
    )
    .get(mandateId) as { spent: number };
  return paise(row.spent);
}

export function mandateRemainingPaise(db: Db, mandateId: string, maxTotalPaise: number): Paise {
  const spent = mandateSpentPaise(db, mandateId);
  return paise(Math.max(0, maxTotalPaise - spent));
}
