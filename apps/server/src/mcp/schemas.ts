import { z } from "zod";

export const SearchCatalogSchema = z.object({
  query: z.string().default(""),
  category: z.string().optional(),
  max_price_paise: z.number().int().positive().optional(),
  in_stock_only: z.boolean().optional(),
  limit: z.number().int().min(1).max(20).optional(),
});

export const GetProductSchema = z.object({ product_id: z.string() });

const LineItemSchema = z.object({ variant_id: z.string(), quantity: z.number().int().min(1).max(99) });

export const CreateCheckoutSchema = z.object({
  mandate_id: z.string(),
  line_items: z.array(LineItemSchema).min(1),
  coupon_code: z.string().optional(),
  buyer_ref: z.string().default("buyer"),
});

export const UpdateCheckoutSchema = z.object({
  checkout_id: z.string(),
  line_items: z.array(LineItemSchema).min(1),
  coupon_code: z.string().optional(),
});

export const GetCheckoutSchema = z.object({ checkout_id: z.string() });
export const SuggestAddonsSchema = z.object({ checkout_id: z.string() });
export const CompleteCheckoutSchema = z.object({ checkout_id: z.string(), line_items_hash: z.string() });
export const CancelCheckoutSchema = z.object({ checkout_id: z.string(), reason: z.string().default("buyer_canceled") });
