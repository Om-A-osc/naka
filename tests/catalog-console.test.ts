import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { existsSync, unlinkSync } from "node:fs";

/** Onboarding a different merchant through the console, end to end: the demo database starts as a coffee roaster. */
const DB_PATH = "./data/test-catalog-console.db";
const PORT = 34121;
const PASSWORD = "test-password";

let close: () => Promise<void>;
let db: import("better-sqlite3").Database;
let baseUrl: string;
let cookie = "";

const SHOES = {
  merchant: { display_name: "Chappal & Sons", currency: "INR" },
  products: [
    {
      id: "prod_runner",
      title: "City Runner",
      description: "Lightweight everyday running shoe with a breathable knit upper.",
      category: "footwear",
      variants: [
        { id: "var_runner_8", title: "UK 8", sku: "RUN-8", price_paise: 349900, stock_qty: 12, aliases: ["running shoes 8", "daudne wale joote"] },
        { id: "var_runner_9", title: "UK 9", sku: "RUN-9", price_paise: 349900, stock_qty: 7, aliases: ["running shoes 9"] },
      ],
    },
    {
      id: "prod_socks",
      title: "Ankle Socks (3 pack)",
      description: "Cotton ankle socks.",
      category: "accessories",
      variants: [{ id: "var_socks_std", title: "Standard", sku: "SOCK-3", price_paise: 49900, stock_qty: 100, aliases: ["socks", "moze"] }],
    },
  ],
  frequently_bought_with: [{ variant_id: "var_runner_8", addon_variant_id: "var_socks_std", weight: 1.0 }],
  coupons: [{ code: "FIRSTRUN", pct: 10, max_paise: 50000, min_order_paise: 100000 }],
};

beforeAll(async () => {
  for (const suffix of ["", "-wal", "-shm"]) if (existsSync(DB_PATH + suffix)) unlinkSync(DB_PATH + suffix);
  process.env.NAKA_DB = DB_PATH;
  process.env.NAKA_PORT = String(PORT);
  process.env.RAZORPAY_MODE = "recorded";
  process.env.CONSOLE_PASSWORD = PASSWORD;
  process.env.NAKA_BASE_URL = `http://127.0.0.1:${PORT}`;

  const { getDb } = await import("@naka/db");
  const { seedAll } = await import("../cli/seed.js");
  const { buildServer } = await import("@naka/server");

  db = getDb();
  seedAll(db); // the coffee roaster, as shipped
  const built = await buildServer();
  await built.app.listen({ port: PORT, host: "127.0.0.1" });
  close = built.close;
  baseUrl = `http://127.0.0.1:${PORT}`;

  const login = await fetch(`${baseUrl}/console/login`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ password: PASSWORD }),
  });
  cookie = login.headers.get("set-cookie")?.split(";")[0] ?? "";
  expect(cookie).toMatch(/^naka_console=/);
});

afterAll(async () => {
  await close();
});

async function api(path: string, init: RequestInit = {}) {
  const res = await fetch(`${baseUrl}${path}`, { ...init, headers: { "Content-Type": "application/json", cookie, ...(init.headers ?? {}) } });
  return { status: res.status, body: (await res.json()) as any };
}

describe("console catalog onboarding", () => {
  it("starts as the seeded coffee roaster", async () => {
    const r = await api("/api/console/catalog");
    expect(r.status).toBe(200);
    expect(r.body.merchant.display_name).toBe("Kaapi Kottai Roasters");
    expect(r.body.variants.some((v: any) => v.category === "coffee")).toBe(true);
  });

  it("rejects an invalid catalog with a field-level message and changes nothing", async () => {
    const bad = { ...SHOES, products: [{ ...SHOES.products[0], id: "has space", variants: [] }] };
    const r = await api("/api/console/catalog/import", { method: "POST", body: JSON.stringify(bad) });
    expect(r.status).toBe(400);
    expect(r.body.error.code).toBe("INVALID_CATALOG");
    expect(r.body.error.message).toMatch(/products\.0/);
    const still = await api("/api/console/catalog");
    expect(still.body.merchant.display_name).toBe("Kaapi Kottai Roasters");
  });

  it("replaces the catalog with a shoe shop and everything follows", async () => {
    const r = await api("/api/console/catalog/import", { method: "POST", body: JSON.stringify(SHOES) });
    expect(r.status).toBe(200);
    expect(r.body).toMatchObject({ ok: true, products: 2, variants: 3, coupons: 1 });

    // The console now describes shoes, and no coffee is on sale.
    const cat = await api("/api/console/catalog");
    expect(cat.body.merchant.display_name).toBe("Chappal & Sons");
    expect(cat.body.variants.map((v: any) => v.variant_id).sort()).toEqual(["var_runner_8", "var_runner_9", "var_socks_std"]);

    // Buyer-facing search sees shoes by English and Hinglish alias, and no coffee.
    const search = await fetch(`${baseUrl}/tools/search_catalog`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ query: "daudne wale joote" }),
    }).then((x) => x.json() as any);
    expect(search.results[0].variant_id).toBe("var_runner_8");
    expect(search.results[0].price_display).toBe("₹3,499");
    const coffee = await fetch(`${baseUrl}/tools/search_catalog`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ query: "filter coffee" }),
    }).then((x) => x.json() as any);
    expect(coffee.results.filter((v: any) => v.category === "coffee")).toHaveLength(0);

    // The manifest a buyer agent reads at startup carries the new name.
    const manifest = await fetch(`${baseUrl}/.well-known/naka.json`).then((x) => x.json() as any);
    expect(manifest.merchant.display_name).toBe("Chappal & Sons");

    // Export round-trips to the importer's shape.
    const exp = await api("/api/console/catalog/export.json");
    expect(exp.status).toBe(200);
    expect(exp.body.merchant.display_name).toBe("Chappal & Sons");
    expect(exp.body.products.map((p: any) => p.id).sort()).toEqual(["prod_runner", "prod_socks"]);
    expect(exp.body.products.find((p: any) => p.id === "prod_runner").variants[0].aliases).toContain("daudne wale joote");
    expect(exp.body.coupons[0].code).toBe("FIRSTRUN");

    // Deactivated, not deleted: old rows survive for the ledger's sake.
    const oldCoffee = db.prepare("SELECT active FROM products WHERE id = 'prod_fc8020'").get() as { active: number };
    expect(oldCoffee.active).toBe(0);

    const ledger = db.prepare("SELECT COUNT(*) AS n FROM ledger WHERE action = 'CATALOG_IMPORTED'").get() as { n: number };
    expect(ledger.n).toBe(1);
  });

  it("re-uploading a product that was removed reactivates it", async () => {
    const withCoffeeBack = { ...SHOES, products: [...SHOES.products, { id: "prod_fc8020", title: "Filter Coffee 80:20", description: "", category: "coffee", variants: [{ id: "var_fc8020_250", title: "250 g", sku: "FC-250", price_paise: 34900, stock_qty: 5 }] }] };
    const r = await api("/api/console/catalog/import", { method: "POST", body: JSON.stringify(withCoffeeBack) });
    expect(r.status).toBe(200);
    const row = db.prepare("SELECT active FROM products WHERE id = 'prod_fc8020'").get() as { active: number };
    expect(row.active).toBe(1);
  });

  it("requires the console session", async () => {
    const res = await fetch(`${baseUrl}/api/console/catalog/import`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(SHOES) });
    expect(res.status).toBe(401);
  });
});
