import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { existsSync, unlinkSync } from "node:fs";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";

/** The remote MCP door: a real MCP client connects to POST /mcp over Streamable HTTP with nothing but a bearer token, lists the eight tools, searches. */
const DB_PATH = "./data/test-mcp-remote.db";
const PORT = 34129;
const PASSWORD = "test-password";

let close: () => Promise<void>;
let db: import("better-sqlite3").Database;
let baseUrl: string;
let shoeToken = "";
let shoeAgentId = "";
let coffeeToken = "";
let coffeeCookie = "";

const SHOES = {
  merchant: { display_name: "Remote Shoes", currency: "INR" },
  products: [
    { id: "prod_runner", title: "City Runner", description: "Running shoe.", category: "footwear", variants: [{ id: "var_runner_8", title: "UK 8", sku: "RUN-8", price_paise: 349900, stock_qty: 5, aliases: ["running shoes"] }] },
    { id: "prod_socks", title: "Ankle Socks", description: "Cotton socks.", category: "accessories", variants: [{ id: "var_socks_std", title: "Standard", sku: "SOCK-1", price_paise: 49900, stock_qty: 50, aliases: ["socks"] }] },
  ],
  frequently_bought_with: [{ variant_id: "var_runner_8", addon_variant_id: "var_socks_std", weight: 1.0 }],
  coupons: [],
};

async function json(path: string, init: RequestInit = {}) {
  const body = init.method && init.method !== "GET" && init.body === undefined ? "{}" : init.body;
  const res = await fetch(`${baseUrl}${path}`, { ...init, body, headers: { "Content-Type": "application/json", ...(init.headers ?? {}) } });
  return { status: res.status, body: (await res.json()) as any, headers: res.headers };
}

async function connect(token: string): Promise<Client> {
  const transport = new StreamableHTTPClientTransport(new URL(`${baseUrl}/mcp`), { requestInit: { headers: { Authorization: `Bearer ${token}` } } });
  const client = new Client({ name: "naka-test-client", version: "0.0.1" });
  await client.connect(transport);
  return client;
}

/** Tool results are JSON text; parse the first text block. */
function payload(result: any): any {
  return JSON.parse(result.content[0].text);
}

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
  db = getDb();
  seedAll(db);
  const built = await buildServer();
  await built.app.listen({ port: PORT, host: "127.0.0.1" });
  close = built.close;
  baseUrl = `http://127.0.0.1:${PORT}`;

  const onboarded = await json("/api/onboard", {
    method: "POST",
    body: JSON.stringify({ merchant_id: "remote_shoes", display_name: "Remote Shoes", console_password: "remote-shoes-pass", max_per_checkout_paise: 800000, merchant_approval_over_paise: 300000, catalog: SHOES }),
  });
  expect(onboarded.status).toBe(200);
  shoeToken = onboarded.body.buyer_agent.mcp_token;
  shoeAgentId = onboarded.body.buyer_agent.agent_id;
  expect(shoeToken).toMatch(/^nk_/);

  const login = await json("/console/login", { method: "POST", body: JSON.stringify({ password: PASSWORD }) });
  coffeeCookie = login.headers.get("set-cookie")?.split(";")[0] ?? "";
  const minted = await json("/api/console/agents/new", { method: "POST", headers: { cookie: coffeeCookie }, body: JSON.stringify({ name: "remote-coffee" }) });
  coffeeToken = minted.body.mcp_token;
  expect(coffeeToken).toMatch(/^nk_/);
});

afterAll(async () => {
  await close();
});

describe("remote MCP endpoint", () => {
  it("the kit carries a ready-to-paste remote config and the token is stored only as a hash", async () => {
    const row = db.prepare("SELECT token_hash FROM agents WHERE id = ?").get(shoeAgentId) as { token_hash: string };
    expect(row.token_hash).toMatch(/^[0-9a-f]{64}$/);
    expect(row.token_hash).not.toContain(shoeToken);
    const dump = db.prepare("SELECT * FROM agents WHERE id = ?").get(shoeAgentId) as Record<string, unknown>;
    expect(JSON.stringify(dump)).not.toContain(shoeToken);
  });

  it("lists the eight tools and shops with nothing but a bearer token", async () => {
    const client = await connect(shoeToken);
    const tools = await client.listTools();
    expect(tools.tools.map((t) => t.name).sort()).toEqual(
      ["cancel_checkout", "complete_checkout", "create_checkout", "get_checkout", "get_product", "search_catalog", "suggest_addons", "update_checkout"]
    );

    const found = payload(await client.callTool({ name: "search_catalog", arguments: { query: "socks" } }));
    expect(found.results[0].title).toBe("Ankle Socks");
    expect(found.results[0].price_display).toBe("₹499");

    const created = await client.callTool({ name: "create_checkout", arguments: { line_items: [{ variant_id: "var_socks_std", quantity: 2 }] } });
    expect(created.isError).toBeFalsy();
    const cart = payload(created);
    expect(cart.decision.outcome).toBe("ALLOW");
    expect(cart.totals.total_paise).toBe(99800);
    const row = db.prepare("SELECT merchant_id, agent_id FROM checkouts WHERE id = ?").get(cart.checkout_id) as { merchant_id: string; agent_id: string };
    expect(row).toEqual({ merchant_id: "remote_shoes", agent_id: shoeAgentId });
    expect(db.prepare("SELECT COUNT(*) AS n FROM ledger WHERE checkout_id = ?").get(cart.checkout_id)).toMatchObject({ n: expect.any(Number) });

    const read = payload(await client.callTool({ name: "get_checkout", arguments: { checkout_id: cart.checkout_id } }));
    expect(read.status).toBe("ready_for_complete");

    const escalated = payload(await client.callTool({ name: "create_checkout", arguments: { line_items: [{ variant_id: "var_runner_8", quantity: 1 }] } }));
    expect(escalated.decision.outcome).toBe("NEEDS_HUMAN");

    const bad = await client.callTool({ name: "get_product", arguments: { product_id: "prod_nope" } });
    expect(bad.isError).toBe(true);
    await client.close();
  });

  it("one merchant's token cannot see another merchant's catalog", async () => {
    const coffee = await connect(coffeeToken);
    const seen = payload(await coffee.callTool({ name: "search_catalog", arguments: { query: "socks" } }));
    expect(seen.results.some((r: any) => r.title === "Ankle Socks")).toBe(false);
    const foreign = await coffee.callTool({ name: "create_checkout", arguments: { line_items: [{ variant_id: "var_socks_std", quantity: 1 }] } });
    expect(foreign.isError).toBe(true);
    expect(payload(foreign).error.code).toBe("UNKNOWN_VARIANT");

    // A checkout id is not a capability: the shoe shop's open cart cannot be cancelled, read, upsold on or completed by another agent that knows its id.
    const shoes = await connect(shoeToken);
    const cart = payload(await shoes.callTool({ name: "create_checkout", arguments: { line_items: [{ variant_id: "var_socks_std", quantity: 1 }] } }));
    for (const [name, args] of [
      ["cancel_checkout", { checkout_id: cart.checkout_id, reason: "not mine" }],
      ["suggest_addons", { checkout_id: cart.checkout_id }],
      ["get_checkout", { checkout_id: cart.checkout_id }],
      ["complete_checkout", { checkout_id: cart.checkout_id, line_items_hash: cart.line_items_hash }],
    ] as const) {
      const r = await coffee.callTool({ name, arguments: args as any });
      expect(r.isError, name).toBe(true);
      expect(payload(r).error.code, name).toBe("FORBIDDEN");
    }
    const still = payload(await shoes.callTool({ name: "get_checkout", arguments: { checkout_id: cart.checkout_id } }));
    expect(still.status).toBe("ready_for_complete");
    await shoes.close();
    await coffee.close();
  });

  it("refuses a missing or wrong token, and a suspended agent", async () => {
    await expect(connect("nk_definitely-not-a-token")).rejects.toThrow(/INVALID_TOKEN/);
    const anon = await fetch(`${baseUrl}/mcp`, { method: "POST", headers: { "Content-Type": "application/json", Accept: "application/json, text/event-stream" }, body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list" }) });
    expect(anon.status).toBe(401);

    const suspend = await json(`/api/console/agents/${(await json("/api/console/agents", { headers: { cookie: coffeeCookie } })).body.agents.find((a: any) => a.name === "remote-coffee").id}/suspend`, {
      method: "POST",
      headers: { cookie: coffeeCookie },
    });
    expect(suspend.status).toBe(200);
    await expect(connect(coffeeToken)).rejects.toThrow(/AGENT_SUSPENDED/);
  });

  it("GET is a 405 because the endpoint is stateless", async () => {
    const res = await fetch(`${baseUrl}/mcp`, { headers: { Authorization: `Bearer ${shoeToken}`, Accept: "text/event-stream" } });
    expect(res.status).toBe(405);
  });
});
