import type { Db } from "@naka/db";
import { formatInr } from "@naka/shared";

export interface ProductDetail {
  product_id: string;
  title: string;
  description: string;
  category: string;
  variants: Array<{
    variant_id: string;
    title: string;
    price_paise: number;
    /** Same price pre-rendered for display ("₹429"), see SearchResult.price_display. */
    price_display: string;
    stock_qty: number;
    reserved_qty: number;
    attributes: Record<string, unknown>;
  }>;
  frequently_bought_with: string[];
}

export function getProduct(db: Db, productId: string, merchantId?: string): ProductDetail | undefined {
  const product = db.prepare(`SELECT * FROM products WHERE id = ?`).get(productId) as any;
  if (!product) return undefined;
  if (merchantId && product.merchant_id !== merchantId) return undefined; // another tenant's product is simply not found here

  const variants = db.prepare(`SELECT * FROM variants WHERE product_id = ? AND active = 1`).all(productId) as any[];
  const variantIds = variants.map((v) => v.id);
  const fbw = variantIds.length
    ? (db
        .prepare(
          `SELECT DISTINCT addon_variant_id FROM frequently_bought_with WHERE variant_id IN (${variantIds.map(() => "?").join(",")})`
        )
        .all(...variantIds) as Array<{ addon_variant_id: string }>)
    : [];

  return {
    product_id: product.id,
    title: product.title,
    description: product.description,
    category: product.category,
    variants: variants.map((v) => ({
      variant_id: v.id,
      title: v.title,
      price_paise: v.price_paise,
      price_display: formatInr(v.price_paise),
      stock_qty: v.stock_qty,
      reserved_qty: v.reserved_qty,
      attributes: JSON.parse(v.attributes ?? "{}"),
    })),
    frequently_bought_with: fbw.map((f) => f.addon_variant_id),
  };
}

export function getVariant(db: Db, variantId: string) {
  return db
    .prepare(
      `SELECT v.*, p.category AS category, p.title AS product_title, p.merchant_id AS merchant_id
       FROM variants v JOIN products p ON p.id = v.product_id WHERE v.id = ?`
    )
    .get(variantId) as
    | {
        id: string;
        product_id: string;
        title: string;
        sku: string;
        price_paise: number;
        stock_qty: number;
        reserved_qty: number;
        category: string;
        product_title: string;
        merchant_id: string;
      }
    | undefined;
}
