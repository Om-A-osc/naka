import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { existsSync, unlinkSync } from "node:fs";

/** Two merchants on one server: the coffee roaster seeded from disk, and a shoe shop onboarded through the website. */
const DB_PATH = "./data/test-tenancy.db";
const PORT = 34123;
const DEFAULT_PASSWORD = "test-password";
const SHOP_PASSWORD = "chappal-pass-123";

let close: () => Promise<void>;
let db: import("better-sqlite3").Database;
let baseUrl: string;
let seed: any;
let kit: any;
let NakaClient: any;
let signWebhookBody: (raw: string, secret: string) => string;

const SHOES = {
  merchant: { display_name: "Chappal & Sons", currency: "INR" },
  products: [
    {
      id: "prod_runner",
      title: "City Runner",
      description: "Lightweight everyday running shoe.",
      category: "footwear",
      variants: [
        { id: "var_runner_8", title: "UK 8", sku: "RUN-8", price_paise: 349900, stock_qty: 12, aliases: ["running shoes 8"] },
        { id: "var_runner_9", title: "UK 9", sku: "RUN-9", price_paise: 349900, stock_qty: 7, aliases: ["running shoes 9"] },
      ],
    },
    {
      id: "prod_socks",
      title: "Ankle Socks (3 pack)",
      description: "Cotton ankle socks.",
      category: "accessories",
      variants: [{ id: "var_socks_std", title: "Standard", sku: "SOCK-3", price_paise: 49900, stock_qty: 100, aliases: ["socks"] }],
    },
  ],
  frequently_bought_with: [{ variant_id: "var_runner_8", addon_variant_id: "var_socks_std" }],
  coupons: [],
};

async function json(path: string, init: RequestInit = {}) {
  const body = init.method && init.method !== "GET" && init.body === undefined ? "{}" : init.body;
  const res = await fetch(`${baseUrl}${path}`, { ...init, body, headers: { "Content-Type": "application/json", ...(init.headers ?? {}) } });
  return { status: res.status, body: (await res.json()) as any, headers: res.headers };
}

async function login(merchantId: string | undefined, password: string): Promise<string> {
  const r = await json("/console/login", { method: "POST", body: JSON.stringify({ merchant_id: merchantId, password }) });
  if (r.status !== 200) return "";
  return r.headers.get("set-cookie")?.split(";")[0] ?? "";
}

beforeAll(async () => {
  for (const suffix of ["", "-wal", "-shm"]) if (existsSync(DB_PATH + suffix)) unlinkSync(DB_PATH + suffix);
  process.env.NAKA_DB = DB_PATH;
  process.env.NAKA_PORT = String(PORT);
  process.env.RAZORPAY_MODE = "recorded";
  process.env.CONSOLE_PASSWORD = DEFAULT_PASSWORD;
  process.env.RZP_WEBHOOK_SECRET = "default-webhook-secret";
  process.env.NAKA_TELEGRAM_OFFLINE = "1"; // store tokens and mint agents, never call Telegram or poll
  process.env.NAKA_BASE_URL = `http://127.0.0.1:${PORT}`;

  const { getDb } = await import("@naka/db");
  const { seedAll } = await import("../cli/seed.js");
  const { buildServer } = await import("@naka/server");
  ({ NakaClient } = await import("../apps/buyer/src/mcp-client.js"));
  ({ signWebhookBody } = await import("@naka/razorpay"));

  db = getDb();
  seed = seedAll(db);
  const built = await buildServer();
  await built.app.listen({ port: PORT, host: "127.0.0.1" });
  close = built.close;
  baseUrl = `http://127.0.0.1:${PORT}`;

  const r = await json("/api/onboard", {
    method: "POST",
    body: JSON.stringify({
      merchant_id: "chappal",
      display_name: "Chappal & Sons",
      console_password: SHOP_PASSWORD,
      max_per_checkout_paise: 400000,
      merchant_approval_over_paise: 300000,
      catalog: SHOES,
    }),
  });
  expect(r.status).toBe(200);
  kit = r.body;
});

afterAll(async () => {
  await close();
});

describe("onboarding", () => {
  it("returns a complete connection kit and never stores the agent's private key", () => {
    expect(kit.merchant.id).toBe("chappal");
    expect(kit.razorpay_webhook.url).toBe(`${baseUrl}/webhooks/razorpay/chappal`);
    expect(kit.razorpay_webhook.secret).toHaveLength(48);
    expect(kit.buyer_agent.private_key_pem).toContain("BEGIN PRIVATE KEY");
    expect(kit.mcp.config.mcpServers["naka-chappal"].env.NAKA_MERCHANT).toBe("chappal");
    expect(kit.mcp.config.mcpServers["naka-chappal"].env.NAKA_AGENT_ID).toBe(kit.buyer_agent.agent_id);

    const agent = db.prepare("SELECT merchant_id, pubkey FROM agents WHERE id = ?").get(kit.buyer_agent.agent_id) as { merchant_id: string; pubkey: string };
    expect(agent.merchant_id).toBe("chappal");
    expect(agent.pubkey).toContain("BEGIN PUBLIC KEY");
    const merchant = db.prepare("SELECT console_password_hash, webhook_secret, policy_json FROM merchants WHERE id = 'chappal'").get() as any;
    expect(merchant.console_password_hash).not.toContain(SHOP_PASSWORD);
    expect(merchant.webhook_secret).toBe(kit.razorpay_webhook.secret);
    expect(JSON.parse(merchant.policy_json).max_per_checkout_paise).toBe(400000);
    expect(JSON.stringify(db.prepare("SELECT * FROM merchants").all())).not.toContain("BEGIN PRIVATE KEY");
  });

  it("refuses a duplicate merchant id and a live Razorpay key", async () => {
    const dup = await json("/api/onboard", { method: "POST", body: JSON.stringify({ merchant_id: "chappal", display_name: "x", console_password: "12345678", catalog: SHOES }) });
    expect(dup.status).toBe(409);
    const live = await json("/api/onboard", {
      method: "POST",
      body: JSON.stringify({ merchant_id: "livekeys", display_name: "x", console_password: "12345678", razorpay_key_id: "rzp_live_abc", razorpay_key_secret: "secretsecret", catalog: SHOES }),
    });
    expect(live.status).toBe(400);
    expect(live.body.error.message).toMatch(/rzp_test_/);
  });
});

describe("catalog isolation", () => {
  it("browsing without a merchant header sees only the default shop", async () => {
    const r = await json("/tools/search_catalog", { method: "POST", body: JSON.stringify({ query: "", limit: 20 }) });
    const cats = new Set(r.body.results.map((v: any) => v.category));
    expect(cats.has("coffee")).toBe(true);
    expect(cats.has("footwear")).toBe(false);
  });

  it("browsing as the shoe shop sees only shoes", async () => {
    const r = await json("/tools/search_catalog", { method: "POST", headers: { "x-naka-merchant": "chappal" }, body: JSON.stringify({ query: "", limit: 20 }) });
    const cats = new Set(r.body.results.map((v: any) => v.category));
    expect(cats.has("footwear")).toBe(true);
    expect(cats.has("coffee")).toBe(false);
  });

  it("a product is not found from the wrong shop", async () => {
    const wrong = await json("/tools/get_product", { method: "POST", body: JSON.stringify({ product_id: "prod_runner" }) });
    expect(wrong.status).toBe(404);
    const right = await json("/tools/get_product", { method: "POST", headers: { "x-naka-merchant": "chappal" }, body: JSON.stringify({ product_id: "prod_runner" }) });
    expect(right.status).toBe(200);
    expect(right.body.variants[0].price_display).toBe("₹3,499");
  });
});

describe("money-path isolation", () => {
  const shopBuyer = () => new NakaClient(baseUrl, kit.buyer_agent.agent_id, kit.buyer_agent.private_key_pem, "chappal");
  const coffeeBuyer = () => new NakaClient(baseUrl, seed.agents["buyer-claude"].id, seed.agents["buyer-claude"].privateKeyPath);

  it("the onboarded agent can buy from its own shop under its own policy", async () => {
    const ok = await shopBuyer().createCheckout({ mandate_id: kit.buyer_agent.mandate_id, line_items: [{ variant_id: "var_socks_std", quantity: 1 }] });
    expect(ok.decision.outcome).toBe("ALLOW");
    const row = db.prepare("SELECT merchant_id FROM checkouts WHERE id = ?").get(ok.checkout_id) as { merchant_id: string };
    expect(row.merchant_id).toBe("chappal");

    // ₹3,499 sits between this shop's ₹3,000 approval threshold and its ₹4,000 cap.
    const escalates = await shopBuyer().createCheckout({ mandate_id: kit.buyer_agent.mandate_id, line_items: [{ variant_id: "var_runner_8", quantity: 1 }] });
    expect(escalates.decision.outcome).toBe("NEEDS_HUMAN");

    const over = await shopBuyer().createCheckout({ mandate_id: kit.buyer_agent.mandate_id, line_items: [{ variant_id: "var_runner_9", quantity: 2 }] });
    expect(over.decision.outcome).toBe("DENY");
  });

  it("the onboarded agent cannot put another shop's product in its cart", async () => {
    const r = await shopBuyer().createCheckout({ mandate_id: kit.buyer_agent.mandate_id, line_items: [{ variant_id: "var_fc8020_250", quantity: 1 }] });
    expect(r.decision?.outcome ?? "ERROR").not.toBe("ALLOW");
    expect(db.prepare("SELECT COUNT(*) AS n FROM checkouts WHERE merchant_id = 'chappal' AND status NOT IN ('canceled')").get()).toBeTruthy();
  });

  it("the default shop's agent is unaffected by the shoe shop's existence", async () => {
    const r = await coffeeBuyer().createCheckout({ mandate_id: seed.mandates.buyer_claude, line_items: [{ variant_id: "var_fc8020_250", quantity: 1 }] });
    expect(r.decision.outcome).toBe("ALLOW");
    expect((db.prepare("SELECT merchant_id FROM checkouts WHERE id = ?").get(r.checkout_id) as any).merchant_id).toBe(seed.merchant_id);
  });
});

describe("console isolation", () => {
  it("each merchant logs into its own console and sees only its own data", async () => {
    const shop = await login("chappal", SHOP_PASSWORD);
    const dflt = await login(undefined, DEFAULT_PASSWORD);
    expect(shop).toMatch(/^naka_console=chappal\./);
    expect(dflt).toMatch(new RegExp(`^naka_console=${seed.merchant_id}\\.`));

    const shopCatalog = await json("/api/console/catalog", { headers: { cookie: shop } });
    expect(shopCatalog.body.merchant.display_name).toBe("Chappal & Sons");
    const dfltCatalog = await json("/api/console/catalog", { headers: { cookie: dflt } });
    expect(dfltCatalog.body.merchant.display_name).toBe("Kaapi Kottai Roasters");

    const shopEsc = await json("/api/console/escalations", { headers: { cookie: shop } });
    expect(shopEsc.body.escalations.length).toBe(1);
    const escalatedId = shopEsc.body.escalations[0].checkout_id;
    const dfltEsc = await json("/api/console/escalations", { headers: { cookie: dflt } });
    expect(dfltEsc.body.escalations.map((e: any) => e.checkout_id)).not.toContain(escalatedId);

    // The default merchant cannot approve the shoe shop's escalation.
    const forbidden = await json(`/api/console/escalations/${escalatedId}/approve`, { method: "POST", headers: { cookie: dflt } });
    expect(forbidden.status).toBe(404);
    const allowed = await json(`/api/console/escalations/${escalatedId}/approve`, { method: "POST", headers: { cookie: shop } });
    expect(allowed.status).toBe(200);
  });

  it("dashboard data is scoped, and minting an agent returns a usable key once", async () => {
    const shop = await login("chappal", SHOP_PASSWORD);
    const stats = await json("/api/console/stats", { headers: { cookie: shop } });
    expect(stats.status).toBe(200);
    expect(stats.body.merchant.id).toBe("chappal");
    expect(stats.body.merchant.webhook_url).toMatch(/\/webhooks\/razorpay\/chappal$/);
    expect(stats.body.catalog.products).toBe(2);
    expect(stats.body.policy.max_per_checkout_paise).toBe(400000);

    const orders = await json("/api/console/orders", { headers: { cookie: shop } });
    expect(orders.body.orders.length).toBeGreaterThan(0);
    expect(orders.body.orders.every((o: any) => o.agent_id === kit.buyer_agent.agent_id)).toBe(true);
    expect(orders.body.orders.some((o: any) => /Ankle Socks/.test(o.items))).toBe(true);

    const minted = await json("/api/console/agents/new", { method: "POST", headers: { cookie: shop }, body: JSON.stringify({ name: "claude-laptop" }) });
    expect(minted.status).toBe(200);
    expect(minted.body.private_key_pem).toContain("BEGIN PRIVATE KEY");
    expect(minted.body.mandate.allowed_categories.sort()).toEqual(["accessories", "footwear"]);
    expect(minted.body.mcp.config.mcpServers["naka-chappal"].env.NAKA_AGENT_ID).toBe(minted.body.agent_id);

    // The minted key really signs for this shop, and only this shop.
    const client = new NakaClient(baseUrl, minted.body.agent_id, minted.body.private_key_pem, "chappal");
    const r = await client.createCheckout({ mandate_id: minted.body.mandate_id, line_items: [{ variant_id: "var_socks_std", quantity: 1 }] });
    expect(r.decision.outcome).toBe("ALLOW");

    const agents = await json("/api/console/agents", { headers: { cookie: shop } });
    const row = agents.body.agents.find((a: any) => a.id === minted.body.agent_id);
    expect(row.name).toBe("claude-laptop");
    expect(row.checkouts).toBe(1);
    const dflt = await login(undefined, DEFAULT_PASSWORD);
    const dfltAgents = await json("/api/console/agents", { headers: { cookie: dflt } });
    expect(dfltAgents.body.agents.map((a: any) => a.id)).not.toContain(minted.body.agent_id);
  });

  it("a merchant connects its own Telegram bot from the console and tunes its policy", async () => {
    const shop = await login("chappal", SHOP_PASSWORD);

    const bad = await json("/api/console/telegram", { method: "POST", headers: { cookie: shop }, body: JSON.stringify({ token: "not-a-token" }) });
    expect(bad.status).toBe(400);
    expect(bad.body.error.code).toBe("BAD_TOKEN");

    // NAKA_TELEGRAM_OFFLINE=1: the token is accepted without calling Telegram and no poller starts.
    const token = "123456789:AAFakeTokenForTestsOnly_abcdefghijklmnopq";
    const ok = await json("/api/console/telegram", { method: "POST", headers: { cookie: shop }, body: JSON.stringify({ token }) });
    expect(ok.status).toBe(200);
    expect(ok.body.username).toBe("offline_chappal_bot");
    expect(ok.body.link).toBe("https://t.me/offline_chappal_bot");

    const row = db.prepare("SELECT telegram_bot_token, telegram_agent_id, telegram_agent_key, telegram_mandate_id FROM merchants WHERE id = 'chappal'").get() as any;
    expect(row.telegram_bot_token).toBe(token);
    expect(row.telegram_agent_key).toContain("BEGIN PRIVATE KEY");
    const botAgent = db.prepare("SELECT merchant_id, name FROM agents WHERE id = ?").get(row.telegram_agent_id) as any;
    expect(botAgent).toMatchObject({ merchant_id: "chappal", name: "telegram-bot" });

    // The hosted bot's agent really can buy from this shop and nowhere else.
    const bot = new NakaClient(baseUrl, row.telegram_agent_id, row.telegram_agent_key, "chappal");
    const buy = await bot.createCheckout({ mandate_id: row.telegram_mandate_id, line_items: [{ variant_id: "var_socks_std", quantity: 1 }] });
    expect(buy.decision.outcome).toBe("ALLOW");

    const status = await json("/api/console/telegram", { headers: { cookie: shop } });
    expect(status.body.connected).toBe(true);
    const stats = await json("/api/console/stats", { headers: { cookie: shop } });
    expect(stats.body.telegram.username).toBe("offline_chappal_bot");

    // The default merchant's console does not see the shoe shop's bot.
    const dflt = await login(undefined, DEFAULT_PASSWORD);
    const other = await json("/api/console/telegram", { headers: { cookie: dflt } });
    expect(other.body.connected).toBe(false);

    // Policy edits persist and take effect on the next checkout.
    const pol = await json("/api/console/policy", { method: "POST", headers: { cookie: shop }, body: JSON.stringify({ max_per_checkout_paise: 40000 }) });
    expect(pol.status).toBe(200);
    expect(pol.body.policy.max_per_checkout_paise).toBe(40000);
    const denied = await bot.createCheckout({ mandate_id: row.telegram_mandate_id, line_items: [{ variant_id: "var_socks_std", quantity: 1 }] });
    expect(denied.decision.outcome).toBe("DENY");
    await json("/api/console/policy", { method: "POST", headers: { cookie: shop }, body: JSON.stringify({ max_per_checkout_paise: 400000 }) });
    const badPol = await json("/api/console/policy", { method: "POST", headers: { cookie: shop }, body: JSON.stringify({ max_per_checkout_paise: -5 }) });
    expect(badPol.status).toBe(400);

    const off = await json("/api/console/telegram", { method: "DELETE", headers: { cookie: shop } });
    expect(off.body.ok).toBe(true);
    expect((await json("/api/console/telegram", { headers: { cookie: shop } })).body.connected).toBe(false);
  });

  it("rejects a wrong password and a cross-merchant password", async () => {
    expect(await login("chappal", DEFAULT_PASSWORD)).toBe("");
    expect(await login(undefined, SHOP_PASSWORD)).toBe("");
    expect(await login("nobody", "whatever12")).toBe("");
  });

  it("the kill switch is per merchant and takes effect without a restart", async () => {
    const shop = await login("chappal", SHOP_PASSWORD);
    await json("/api/console/kill-switch", { method: "POST", headers: { cookie: shop }, body: JSON.stringify({ on: true }) });

    const shopBuyer = new NakaClient(baseUrl, kit.buyer_agent.agent_id, kit.buyer_agent.private_key_pem, "chappal");
    const denied = await shopBuyer.createCheckout({ mandate_id: kit.buyer_agent.mandate_id, line_items: [{ variant_id: "var_socks_std", quantity: 1 }] });
    expect(denied.decision.outcome).toBe("DENY");
    expect(denied.decision.rule_hits.find((h: any) => h.rule_id === "A2_AGENT_ACTIVE").passed).toBe(false);

    const coffeeBuyer = new NakaClient(baseUrl, seed.agents["buyer-claude"].id, seed.agents["buyer-claude"].privateKeyPath);
    const fine = await coffeeBuyer.createCheckout({ mandate_id: seed.mandates.buyer_claude, line_items: [{ variant_id: "var_fc8020_250", quantity: 1 }] });
    expect(fine.decision.outcome).toBe("ALLOW");

    await json("/api/console/kill-switch", { method: "POST", headers: { cookie: shop }, body: JSON.stringify({ on: false }) });
  });

  it("the order drawer explains a merchant's own checkout and hides another merchant's", async () => {
    const shopBuyer = new NakaClient(baseUrl, kit.buyer_agent.agent_id, kit.buyer_agent.private_key_pem, "chappal");
    const created = await shopBuyer.createCheckout({ mandate_id: kit.buyer_agent.mandate_id, line_items: [{ variant_id: "var_socks_std", quantity: 1 }] });
    const shop = await login("chappal", SHOP_PASSWORD);
    const coffee = await login(undefined, DEFAULT_PASSWORD);

    const own = await json(`/api/console/orders/${created.checkout_id}`, { headers: { cookie: shop } });
    expect(own.status).toBe(200);
    expect(own.body.checkout.id).toBe(created.checkout_id);
    expect(own.body.lines).toHaveLength(1);
    expect(own.body.decisions[0].outcome).toBe("ALLOW");
    expect(own.body.decisions[0].rule_hits.map((h: any) => h.rule_id)).toContain("B1_MAX_PER_CHECKOUT");
    expect(own.body.ledger.length).toBeGreaterThan(0);

    const foreign = await json(`/api/console/orders/${created.checkout_id}`, { headers: { cookie: coffee } });
    expect(foreign.status).toBe(404);
    expect((await json(`/api/console/orders/${created.checkout_id}`)).status).toBe(401);
  });
});

describe("webhook isolation", () => {
  const payload = JSON.stringify({ event: "payment.captured", payload: { payment: { entity: { id: "pay_x", order_id: "order_nope", status: "captured", amount: 1, currency: "INR" } } } });

  it("the shoe shop's webhook URL accepts only the shoe shop's secret", async () => {
    const post = (secret: string) =>
      fetch(`${baseUrl}/webhooks/razorpay/chappal`, {
        method: "POST",
        headers: { "Content-Type": "application/json", "X-Razorpay-Signature": signWebhookBody(payload, secret), "X-Razorpay-Event-Id": `evt_${Date.now()}_${secret.length}` },
        body: payload,
      });
    expect((await post(kit.razorpay_webhook.secret)).status).toBe(200);
    expect((await post("default-webhook-secret")).status).toBe(401);
  });

  it("the default webhook URL still uses the default secret", async () => {
    const res = await fetch(`${baseUrl}/webhooks/razorpay`, {
      method: "POST",
      headers: { "Content-Type": "application/json", "X-Razorpay-Signature": signWebhookBody(payload, kit.razorpay_webhook.secret), "X-Razorpay-Event-Id": "evt_cross" },
      body: payload,
    });
    expect(res.status).toBe(401);
  });
});
