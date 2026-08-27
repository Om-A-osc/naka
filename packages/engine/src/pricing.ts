import type { Db } from "@naka/db";
import { getVariant } from "@naka/catalog";
import { addPaise, mulQty, paise, type Paise } from "@naka/shared";

export interface PricedLine {
  variant_id: string;
  title: string;
  category: string;
  quantity: number;
  unit_price_paise: number;
  line_total_paise: number;
  is_addon: boolean;
}

export interface PricingResult {
  lines: PricedLine[];
  subtotal_paise: Paise;
}

export class UnknownVariantError extends Error {
  constructor(public variantId: string) {
    super(`unknown or inactive variant: ${variantId}`);
  }
}

/** Every price comes from the database at proposal time, never from the agent. */
export function priceLines(
  db: Db,
  lines: Array<{ variant_id: string; quantity: number; is_addon?: boolean }>,
  merchantId?: string
): PricingResult {
  const priced: PricedLine[] = lines.map((l) => {
    const v = getVariant(db, l.variant_id);
    // Another merchant's variant is simply unknown to this checkout.
    if (!v || (merchantId && v.merchant_id !== merchantId)) throw new UnknownVariantError(l.variant_id);
    const unit = paise(v.price_paise);
    return {
      variant_id: v.id,
      title: `${v.product_title} ${v.title}`,
      category: v.category,
      quantity: l.quantity,
      unit_price_paise: unit,
      line_total_paise: mulQty(unit, l.quantity),
      is_addon: l.is_addon ?? false,
    };
  });
  const subtotal = addPaise(...priced.map((p) => paise(p.line_total_paise)));
  return { lines: priced, subtotal_paise: subtotal };
}
