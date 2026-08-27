import { readFileSync } from "node:fs";
import { z } from "zod";
import type { Db } from "@naka/db";
import { sha256hex } from "@naka/shared";

export const PolicySchema = z.object({
  max_per_checkout_paise: z.number().int().positive(),
  merchant_approval_over_paise: z.number().int().positive(),
  per_agent_daily_cap_paise: z.number().int().positive(),
  max_qty_per_line: z.number().int().positive(),
  max_payment_attempts: z.number().int().positive(),
  reservation_ttl_seconds: z.number().int().positive(),
  reservation_extend_seconds: z.number().int().positive(),
  addon_max_price_share: z.number().min(0).max(1),
  kill_switch: z.boolean(),
  escalation_approval_ttl_seconds: z.number().int().positive(),
  refund_approval_ttl_seconds: z.number().int().positive(),
});
export type Policy = z.infer<typeof PolicySchema>;

let cached: { policy: Policy; version: number; hash: string } | undefined;

export function loadPolicy(path = process.env.NAKA_POLICY ?? "./data/policy.json"): { policy: Policy; version: number; hash: string } {
  const raw = readFileSync(path, "utf8");
  const policy = PolicySchema.parse(JSON.parse(raw));
  const hash = sha256hex(raw);
  if (cached && cached.hash === hash) return cached;
  const version = (cached?.version ?? 0) + 1;
  cached = { policy, version, hash };
  return cached;
}

export function currentPolicy(): { policy: Policy; version: number; hash: string } {
  return cached ?? loadPolicy();
}

/** Sums a merchant's coupon/discount config lookup, kept here since it's config, not catalog data. */
export function findCoupon(db: Db, code: string) {
  return db.prepare("SELECT * FROM coupons WHERE code = ? AND active = 1").get(code.toUpperCase()) as
    | { code: string; pct: number; max_paise: number; min_order_paise: number }
    | undefined;
}
