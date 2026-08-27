import type { Db } from "@naka/db";
import type { CatalogFile } from "./types.js";

/** The inverse of importCatalog: rebuilds a catalog file from what the database currently holds for one merchant. */
export function exportCatalog(db: Db, merchantId: string): CatalogFile | undefined {
  const merchant = db.prepare("SELECT id, name, display_name, currency FROM merchants WHERE id = ?").get(merchantId) as
    | CatalogFile["merchant"]
    | undefined;
  if (!merchant) return undefined;

  const products = db
    .prepare("SELECT id, title, description, category FROM products WHERE merchant_id = ? AND active = 1 ORDER BY id")
    .all(merchantId) as Array<{ id: string; title: string; description: string; category: string }>;
  const variantStmt = db.prepare(
    "SELECT id, title, sku, price_paise, stock_qty, attributes FROM variants WHERE product_id = ? AND active = 1 ORDER BY id"
  );
  const aliasStmt = db.prepare("SELECT alias FROM variant_aliases WHERE variant_id = ? ORDER BY alias");

  const variantIds = new Set<string>();
  const productsOut = products.map((p) => ({
    ...p,
    variants: (variantStmt.all(p.id) as Array<{ id: string; title: string; sku: string; price_paise: number; stock_qty: number; attributes: string }>).map(
      (v) => {
        variantIds.add(v.id);
        return {
          id: v.id,
          title: v.title,
          sku: v.sku,
          price_paise: v.price_paise,
          stock_qty: v.stock_qty,
          aliases: (aliasStmt.all(v.id) as Array<{ alias: string }>).map((a) => a.alias),
          attributes: JSON.parse(v.attributes ?? "{}"),
        };
      }
    ),
  }));

  const fbw = (
    db.prepare("SELECT variant_id, addon_variant_id, weight FROM frequently_bought_with").all() as Array<{
      variant_id: string;
      addon_variant_id: string;
      weight: number;
    }>
  ).filter((r) => variantIds.has(r.variant_id) && variantIds.has(r.addon_variant_id));

  const coupons = db
    .prepare("SELECT code, pct, max_paise, min_order_paise FROM coupons WHERE merchant_id = ? AND active = 1 ORDER BY code")
    .all(merchantId) as CatalogFile["coupons"];

  return { merchant, products: productsOut, frequently_bought_with: fbw, coupons };
}
