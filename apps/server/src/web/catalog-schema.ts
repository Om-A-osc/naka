import { z } from "zod";

/** Validation for a catalog uploaded through the console. */
const id = z.string().regex(/^[a-z0-9_-]{1,64}$/i, "ids may contain only letters, digits, _ and -");

export const CatalogFileSchema = z.object({
  merchant: z.object({
    id: id.optional(),
    name: z.string().min(1).optional(),
    display_name: z.string().min(1).max(80),
    currency: z.literal("INR").default("INR"),
  }),
  products: z
    .array(
      z.object({
        id,
        title: z.string().min(1).max(120),
        description: z.string().max(2000).default(""),
        category: z.string().min(1).max(40),
        variants: z
          .array(
            z.object({
              id,
              title: z.string().min(1).max(80),
              sku: z.string().min(1).max(64),
              price_paise: z.number().int().positive(),
              stock_qty: z.number().int().min(0),
              aliases: z.array(z.string().min(1).max(80)).max(20).optional(),
              attributes: z.record(z.unknown()).optional(),
            })
          )
          .min(1),
      })
    )
    .min(1)
    .max(500),
  frequently_bought_with: z.array(z.object({ variant_id: id, addon_variant_id: id, weight: z.number().positive().optional() })).default([]),
  coupons: z
    .array(z.object({ code: z.string().regex(/^[A-Z0-9_-]{2,20}$/), pct: z.number().min(0).max(100), max_paise: z.number().int().min(0), min_order_paise: z.number().int().min(0) }))
    .default([]),
});

export type UploadedCatalog = z.infer<typeof CatalogFileSchema>;
