import { describe, it, expect, beforeAll } from "vitest";
import { existsSync, unlinkSync, readFileSync } from "node:fs";

/** The structural half of the injection defense: proves, for every case in evaluation/data/injection-corpus.jsonl. */
const DB_PATH = "./data/test-injection.db";

interface InjectionCase {
  id: string;
  technique: string;
  injected_text: string;
  notes: string;
}

let db: import("better-sqlite3").Database;
let cases: InjectionCase[];

beforeAll(async () => {
  for (const suffix of ["", "-wal", "-shm"]) if (existsSync(DB_PATH + suffix)) unlinkSync(DB_PATH + suffix);
  process.env.NAKA_DB = DB_PATH;
  process.env.NAKA_POLICY = "./data/policy.json";

  const { getDb } = await import("@naka/db");
  const { importCatalogFromFile } = await import("@naka/catalog");
  db = getDb();
  importCatalogFromFile(db, "./data/catalog.json");

  cases = readFileSync("./evaluation/data/injection-corpus.jsonl", "utf8")
    .split("\n")
    .filter(Boolean)
    .map((line) => JSON.parse(line));
});

describe(`injection corpus: structural quarantine (${15} cases expected)`, () => {
  it("loads the full corpus", () => {
    expect(cases.length).toBeGreaterThanOrEqual(15);
  });

  it("every case's payload survives as inert data with no money-field effect", async () => {
    const { priceLines } = await import("@naka/engine");
    const { findCoupon } = await import("@naka/engine");
    const { getProduct, searchCatalog } = await import("@naka/catalog");

    const NORMAL_PRICE_PAISE = 50000; // arbitrary, fixed control value

    for (const c of cases) {
      const productId = `prod_inj_${c.id}`;
      const variantId = `var_inj_${c.id}`;

      db.prepare(
        `INSERT INTO products (id, merchant_id, title, description, category, active) VALUES (?, 'kk_roasters', ?, ?, 'coffee', 1)`
      ).run(productId, `Injection test product ${c.id}`, c.injected_text);
      db.prepare(
        `INSERT INTO variants (id, product_id, title, sku, price_paise, stock_qty, reserved_qty, active) VALUES (?, ?, 'Test', ?, ?, 10, 0, 1)`
      ).run(variantId, productId, `SKU-${c.id}`, NORMAL_PRICE_PAISE);

      // 1) get_product returns the injected text VERBATIM, never stripped, never executed, never parsed for embedded commands.
      const product = getProduct(db, productId);
      expect(product?.description).toBe(c.injected_text);

      // 2) Price is always re-derived from variants.price_paise, regardless of any pricing/discount claim embedded in the description text.
      const priced = priceLines(db, [{ variant_id: variantId, quantity: 1 }]);
      expect(priced.lines[0].unit_price_paise).toBe(NORMAL_PRICE_PAISE);
      expect(priced.lines[0].line_total_paise).toBe(NORMAL_PRICE_PAISE);

      // 3) Category is always the DB's category column, never whatever the description text claims.
      expect(priced.lines[0].category).toBe("coffee");

      // 4) Any coupon code an injected payload tries to plant is invalid because it isn't in the merchant's own coupons table.
      const fakeCoupon = findCoupon(db, "SAVE90") ?? findCoupon(db, "LOYAL75");
      expect(fakeCoupon).toBeUndefined();

      // 5) search_catalog also returns the raw text unmodified when it matches.
      const results = searchCatalog(db, { query: "Injection test", limit: 20 });
      const hit = results.find((r) => r.variant_id === variantId);
      if (hit) expect(hit.description).toBe(c.injected_text);
    }
  });
});
