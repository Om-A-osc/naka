import type { Db } from "@naka/db";
import { readFileSync } from "node:fs";
import type { CatalogFile } from "./types.js";

/** Idempotent catalog import: safe to re-run whenever the merchant edits their file. */
export function importCatalogFromFile(db: Db, path: string): void {
  const file: CatalogFile = JSON.parse(readFileSync(path, "utf8"));
  importCatalog(db, file);
}

export interface ImportOptions {
  /** Treat the file as the merchant's whole catalog: products and variants of this merchant that the file no longer mentions are deactivated. */
  deactivateMissing?: boolean;
}

export function importCatalog(db: Db, file: CatalogFile, opts: ImportOptions = {}): void {
  db.transaction(() => {
    if (opts.deactivateMissing) {
      const keepProducts = file.products.map((p) => p.id);
      const keepVariants = file.products.flatMap((p) => p.variants.map((v) => v.id));
      const ph = (n: number) => (n ? Array(n).fill("?").join(",") : "''");
      db.prepare(`UPDATE products SET active = 0 WHERE merchant_id = ? AND id NOT IN (${ph(keepProducts.length)})`).run(file.merchant.id, ...keepProducts);
      db.prepare(
        `UPDATE variants SET active = 0 WHERE product_id IN (SELECT id FROM products WHERE merchant_id = ?) AND id NOT IN (${ph(keepVariants.length)})`
      ).run(file.merchant.id, ...keepVariants);
      db.prepare(`UPDATE coupons SET active = 0 WHERE merchant_id = ?`).run(file.merchant.id);
    }
    db.prepare(
      `INSERT INTO merchants (id, name, display_name, currency)
       VALUES (?, ?, ?, ?)
       ON CONFLICT(id) DO UPDATE SET name=excluded.name, display_name=excluded.display_name, currency=excluded.currency`
    ).run(file.merchant.id, file.merchant.name, file.merchant.display_name, file.merchant.currency);

    for (const product of file.products) {
      db.prepare(
        `INSERT INTO products (id, merchant_id, title, description, category, attributes, active)
         VALUES (?, ?, ?, ?, ?, '{}', 1)
         ON CONFLICT(id) DO UPDATE SET title=excluded.title, description=excluded.description, category=excluded.category,
           active=1, updated_at=strftime('%Y-%m-%dT%H:%M:%fZ','now')`
      ).run(product.id, file.merchant.id, product.title, product.description, product.category);

      for (const v of product.variants) {
        db.prepare(
          `INSERT INTO variants (id, product_id, title, sku, price_paise, stock_qty, reserved_qty, attributes, active)
           VALUES (?, ?, ?, ?, ?, ?, 0, ?, 1)
           ON CONFLICT(id) DO UPDATE SET title=excluded.title, sku=excluded.sku, price_paise=excluded.price_paise,
             stock_qty=excluded.stock_qty, attributes=excluded.attributes, active=1`
        ).run(v.id, product.id, v.title, v.sku, v.price_paise, v.stock_qty, JSON.stringify(v.attributes ?? {}));

        db.prepare(`DELETE FROM variant_aliases WHERE variant_id = ?`).run(v.id);
        for (const alias of v.aliases ?? []) {
          const lang = /[a-z]/i.test(alias) && /\b(ke|ka|ki|mein|chahiye|kam|bhi|se)\b/i.test(alias) ? "hi-Latn" : "en";
          db.prepare(`INSERT OR IGNORE INTO variant_aliases (variant_id, alias, lang) VALUES (?, ?, ?)`).run(
            v.id,
            alias.toLowerCase(),
            lang
          );
        }
      }
    }

    db.prepare(
      `DELETE FROM frequently_bought_with WHERE variant_id IN (SELECT v.id FROM variants v JOIN products p ON p.id = v.product_id WHERE p.merchant_id = ?)`
    ).run(file.merchant.id);
    for (const fbw of file.frequently_bought_with) {
      db.prepare(
        `INSERT INTO frequently_bought_with (variant_id, addon_variant_id, weight) VALUES (?, ?, ?)`
      ).run(fbw.variant_id, fbw.addon_variant_id, fbw.weight ?? 1.0);
    }

    for (const c of file.coupons) {
      db.prepare(
        `INSERT INTO coupons (code, merchant_id, pct, max_paise, min_order_paise, active)
         VALUES (?, ?, ?, ?, ?, 1)
         ON CONFLICT(code) DO UPDATE SET pct=excluded.pct, max_paise=excluded.max_paise, min_order_paise=excluded.min_order_paise, active=1`
      ).run(c.code, file.merchant.id, c.pct, c.max_paise, c.min_order_paise);
    }

    rebuildFts(db);
  })();
}

function rebuildFts(db: Db): void {
  db.prepare(`DELETE FROM catalog_fts`).run();
  const variants = db
    .prepare(
      `SELECT v.id AS variant_id, p.title || ' ' || v.title AS title, p.description AS description, p.category AS category
       FROM variants v JOIN products p ON p.id = v.product_id WHERE v.active = 1`
    )
    .all() as Array<{ variant_id: string; title: string; description: string; category: string }>;

  const aliasStmt = db.prepare(`SELECT alias FROM variant_aliases WHERE variant_id = ?`);
  const insertFts = db.prepare(`INSERT INTO catalog_fts (variant_id, title, description, aliases, category) VALUES (?, ?, ?, ?, ?)`);
  for (const v of variants) {
    const aliases = (aliasStmt.all(v.variant_id) as Array<{ alias: string }>).map((a) => a.alias).join(" ");
    insertFts.run(v.variant_id, v.title, v.description, aliases, v.category);
  }
}
