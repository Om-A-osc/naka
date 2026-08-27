import type { Db } from "@naka/db";
import { findCoupon } from "./policy.js";
import { pctDiscount, paise, type Paise } from "@naka/shared";

export interface CouponResult {
  code: string;
  valid: boolean;
  reason?: string;
  discount_paise: Paise;
}

/** The ONLY source of discounts is this merchant-configured coupon table. */
export function applyCoupon(db: Db, subtotalPaise: number, code: string | undefined): CouponResult | undefined {
  if (!code) return undefined;
  const coupon = findCoupon(db, code);
  if (!coupon) return { code, valid: false, reason: "unknown_code", discount_paise: paise(0) };
  if (subtotalPaise < coupon.min_order_paise) {
    return { code, valid: false, reason: `min_order_not_met(${coupon.min_order_paise})`, discount_paise: paise(0) };
  }
  const discount = pctDiscount(paise(subtotalPaise), coupon.pct, paise(coupon.max_paise));
  return { code, valid: true, discount_paise: discount };
}
