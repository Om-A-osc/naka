import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { existsSync, unlinkSync } from "node:fs";
import { Script } from "node:vm";

/** Every HTML page the server renders carries its own inline script. */
const DB_PATH = "./data/test-pages.db";
const PORT = 34127;
const PASSWORD = "test-password";

let close: () => Promise<void>;
let baseUrl: string;
let cookie = "";
let checkoutId = "";
let merchantId = "";

beforeAll(async () => {
  for (const suffix of ["", "-wal", "-shm"]) if (existsSync(DB_PATH + suffix)) unlinkSync(DB_PATH + suffix);
  process.env.NAKA_DB = DB_PATH;
  process.env.NAKA_PORT = String(PORT);
  process.env.RAZORPAY_MODE = "recorded";
  process.env.CONSOLE_PASSWORD = PASSWORD;
  process.env.NAKA_BASE_URL = `http://127.0.0.1:${PORT}`;
  process.env.NAKA_TELEGRAM_OFFLINE = "1";

  const { getDb } = await import("@naka/db");
  const { seedAll } = await import("../cli/seed.js");
  const { buildServer } = await import("@naka/server");
  const { NakaClient } = await import("../apps/buyer/src/mcp-client.js");

  const db = getDb();
  const seed = seedAll(db);
  merchantId = seed.merchant_id;
  const built = await buildServer();
  await built.app.listen({ port: PORT, host: "127.0.0.1" });
  close = built.close;
  baseUrl = `http://127.0.0.1:${PORT}`;

  const login = await fetch(`${baseUrl}/console/login`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ password: PASSWORD }) });
  cookie = login.headers.get("set-cookie")?.split(";")[0] ?? "";
  expect(cookie).toMatch(/^naka_console=/);

  const buyer = new NakaClient(baseUrl, seed.agents["buyer-claude"].id, seed.agents["buyer-claude"].privateKeyPath);
  const created = await buyer.createCheckout({ mandate_id: seed.mandates.buyer_claude, line_items: [{ variant_id: "var_fc8020_250", quantity: 1 }] });
  checkoutId = created.checkout_id;
  expect(checkoutId).toMatch(/^chk_/);
});

afterAll(async () => {
  await close();
});

async function page(path: string, withCookie = false) {
  const res = await fetch(`${baseUrl}${path}`, { headers: { accept: "text/html", ...(withCookie ? { cookie } : {}) } });
  return { status: res.status, html: await res.text() };
}

/** Inline <script> bodies only; external ones (Razorpay Checkout) have no source to compile here. */
function inlineScripts(html: string): string[] {
  return [...html.matchAll(/<script(?![^>]*\bsrc=)[^>]*>([\s\S]*?)<\/script>/gi)].map((m) => m[1]);
}

function compileAll(html: string, label: string) {
  const scripts = inlineScripts(html);
  expect(scripts.length, `${label} has inline scripts`).toBeGreaterThan(0);
  for (const [i, js] of scripts.entries()) {
    expect(() => new Script(js, { filename: `${label}#${i}` }), `${label} script ${i} compiles`).not.toThrow();
  }
}

describe("every rendered page compiles its inline scripts", () => {
  const cases: Array<[string, string, boolean, RegExp]> = [
    ["landing", "/", false, /One purchase, step by step/],
    ["storefront (default)", "/shop", false, /Buy here with your assistant/],
    ["onboarding", "/onboard", false, /id="kit"/],
    ["console sign-in", "/console", false, /console\/login|password/i],
    ["console dashboard", "/console", true, /id="drawer"/],
    ["pay page", "/pay/__CHK__", false, /Confirm your payment/],
    ["pay result", "/pay/__CHK__/result", false, /class="mark/],
  ];
  for (const [label, path, withCookie, marker] of cases) {
    it(label, async () => {
      const p = path.replace("__CHK__", checkoutId);
      const r = await page(p, withCookie);
      expect(r.status, `${label} status`).toBe(200);
      expect(r.html, `${label} is the right page`).toMatch(marker);
      compileAll(r.html, label);
    });
  }

  it("storefront by merchant id, and the branded 404", async () => {
    const shop = await page(`/shop/${merchantId}`);
    expect(shop.status).toBe(200);
    compileAll(shop.html, "storefront by id");
    const missing = await page("/definitely-not-a-route");
    expect(missing.status).toBe(404);
    expect(missing.html).toMatch(/<h1>404<\/h1>/);
    compileAll(missing.html, "404");
    const asJson = await fetch(`${baseUrl}/definitely-not-a-route`);
    expect(asJson.status).toBe(404);
    expect(((await asJson.json()) as any).error.code).toBe("NOT_FOUND");
  });
});
