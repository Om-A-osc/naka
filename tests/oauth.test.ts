import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { existsSync, unlinkSync } from "node:fs";
import { createHash, randomBytes } from "node:crypto";
import { Script } from "node:vm";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";

/** The connector flow a hosted MCP client runs against a shop's URL, step by step: 401 with discovery pointers. */
const DB_PATH = "./data/test-oauth.db";
const PORT = 34131;
const PASSWORD = "test-password";
const CALLBACK = "https://claude.ai/api/mcp/auth_callback";

let close: () => Promise<void>;
let db: import("better-sqlite3").Database;
let baseUrl: string;
let merchantId = "";

const SHOES = {
  merchant: { display_name: "OAuth Shoes", currency: "INR" },
  products: [{ id: "prod_socks", title: "Ankle Socks", description: "Cotton socks.", category: "accessories", variants: [{ id: "var_socks_std", title: "Standard", sku: "SOCK-1", price_paise: 49900, stock_qty: 50, aliases: ["socks"] }] }],
  frequently_bought_with: [],
  coupons: [],
};

const form = (o: Record<string, string>) => ({ method: "POST", headers: { "Content-Type": "application/x-www-form-urlencoded" }, body: new URLSearchParams(o).toString() });
const pkce = () => {
  const verifier = randomBytes(32).toString("base64url");
  return { verifier, challenge: createHash("sha256").update(verifier).digest("base64url") };
};

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
  merchantId = seedAll(db).merchant_id;
  const built = await buildServer();
  await built.app.listen({ port: PORT, host: "127.0.0.1" });
  close = built.close;
  baseUrl = `http://127.0.0.1:${PORT}`;

  const onboarded = await fetch(`${baseUrl}/api/onboard`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ merchant_id: "oauth_shoes", display_name: "OAuth Shoes", console_password: "oauth-shoes-pass", catalog: SHOES }),
  });
  expect(onboarded.status).toBe(200);
});

afterAll(async () => {
  await close();
});

/** Registers a client and walks consent + exchange for one merchant; returns the tokens. */
async function connectFlow(shop: string, opts: { decision?: string; clientName?: string } = {}) {
  const reg = await fetch(`${baseUrl}/oauth/register`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ client_name: opts.clientName ?? "Claude", redirect_uris: [CALLBACK] }) });
  expect(reg.status).toBe(201);
  const client = (await reg.json()) as any;
  const { verifier, challenge } = pkce();
  const state = randomBytes(8).toString("hex");
  const resource = `${baseUrl}/mcp/${shop}`;
  const params = { response_type: "code", client_id: client.client_id, redirect_uri: CALLBACK, code_challenge: challenge, code_challenge_method: "S256", state, scope: "shop", resource };

  const page = await fetch(`${baseUrl}/oauth/authorize?${new URLSearchParams(params)}`);
  expect(page.status).toBe(200);
  const html = await page.text();
  for (const js of [...html.matchAll(/<script(?![^>]*\bsrc=)[^>]*>([\s\S]*?)<\/script>/gi)].map((m) => m[1])) expect(() => new Script(js)).not.toThrow();

  const consent = await fetch(`${baseUrl}/oauth/authorize`, { ...form({ ...params, decision: opts.decision ?? "allow" }), redirect: "manual" });
  expect(consent.status).toBe(302);
  const location = new URL(consent.headers.get("location")!);
  expect(location.origin + location.pathname).toBe(CALLBACK);
  expect(location.searchParams.get("state")).toBe(state);
  return { client, verifier, location, html };
}

async function mcp(token: string, shop: string): Promise<Client> {
  const transport = new StreamableHTTPClientTransport(new URL(`${baseUrl}/mcp/${shop}`), { requestInit: { headers: { Authorization: `Bearer ${token}` } } });
  const client = new Client({ name: "naka-oauth-test", version: "0.0.1" });
  await client.connect(transport);
  return client;
}

describe("OAuth 2.1 for the MCP endpoint", () => {
  it("a bare request is a 401 that points at the discovery documents", async () => {
    const res = await fetch(`${baseUrl}/mcp/${merchantId}`, { method: "POST", headers: { "Content-Type": "application/json", Accept: "application/json, text/event-stream" }, body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list" }) });
    expect(res.status).toBe(401);
    const www = res.headers.get("www-authenticate") ?? "";
    const metaUrl = /resource_metadata="([^"]+)"/.exec(www)?.[1];
    expect(metaUrl).toBe(`${baseUrl}/.well-known/oauth-protected-resource/mcp/${merchantId}`);

    const prm = (await (await fetch(metaUrl!)).json()) as any;
    expect(prm.resource).toBe(`${baseUrl}/mcp/${merchantId}`);
    expect(prm.authorization_servers).toEqual([baseUrl]);

    const as = (await (await fetch(`${baseUrl}/.well-known/oauth-authorization-server`)).json()) as any;
    expect(as.issuer).toBe(baseUrl);
    expect(as.registration_endpoint).toBe(`${baseUrl}/oauth/register`);
    expect(as.code_challenge_methods_supported).toEqual(["S256"]);
    expect((await fetch(`${baseUrl}/.well-known/oauth-protected-resource/mcp/nope`)).status).toBe(404);
  });

  it("registers, consents, exchanges with PKCE, and shops; the consent page says what the agent may do", async () => {
    const { client, verifier, location, html } = await connectFlow("oauth_shoes");
    expect(html).toContain("OAuth Shoes");
    expect(html).toContain("No payment happens without you");
    const code = location.searchParams.get("code")!;
    expect(code.length).toBeGreaterThan(20);

    const wrong = await fetch(`${baseUrl}/oauth/token`, form({ grant_type: "authorization_code", code, client_id: client.client_id, redirect_uri: CALLBACK, code_verifier: "not-the-verifier" }));
    expect(wrong.status).toBe(400);
    expect(((await wrong.json()) as any).error).toBe("invalid_grant");

    const tok = await fetch(`${baseUrl}/oauth/token`, form({ grant_type: "authorization_code", code, client_id: client.client_id, redirect_uri: CALLBACK, code_verifier: verifier }));
    expect(tok.status).toBe(200);
    const tokens = (await tok.json()) as any;
    expect(tokens.token_type).toBe("Bearer");
    expect(tokens.access_token).toMatch(/^nk_/);
    expect(tokens.refresh_token).toBeTruthy();

    const reused = await fetch(`${baseUrl}/oauth/token`, form({ grant_type: "authorization_code", code, client_id: client.client_id, redirect_uri: CALLBACK, code_verifier: verifier }));
    expect(reused.status).toBe(400);

    const shop = await mcp(tokens.access_token, "oauth_shoes");
    expect((await shop.listTools()).tools).toHaveLength(8);
    const found = JSON.parse(((await shop.callTool({ name: "search_catalog", arguments: { query: "socks" } })) as any).content[0].text);
    expect(found.results[0].title).toBe("Ankle Socks");
    const cart = JSON.parse(((await shop.callTool({ name: "create_checkout", arguments: { line_items: [{ variant_id: "var_socks_std", quantity: 1 }] } })) as any).content[0].text);
    expect(cart.decision.outcome).toBe("ALLOW");
    await shop.close();

    // The agent minted on Allow is a normal agent of that shop, visible in its console.
    const agent = db.prepare("SELECT merchant_id, name, status FROM agents WHERE id = ?").get(cart.agent_id) as any;
    expect(agent).toMatchObject({ merchant_id: "oauth_shoes", status: "active" });
    expect(agent.name).toMatch(/^claude-/);

    // A token minted for the shoe shop is refused at the coffee shop's URL.
    await expect(mcp(tokens.access_token, merchantId)).rejects.toThrow(/WRONG_MERCHANT/);

    // Refresh rotates: the new token works, the old one and the old refresh token are dead.
    const refreshed = await fetch(`${baseUrl}/oauth/token`, form({ grant_type: "refresh_token", refresh_token: tokens.refresh_token, client_id: client.client_id }));
    expect(refreshed.status).toBe(200);
    const next = (await refreshed.json()) as any;
    expect(next.access_token).not.toBe(tokens.access_token);
    const again = await mcp(next.access_token, "oauth_shoes");
    expect((await again.listTools()).tools).toHaveLength(8);
    await again.close();
    await expect(mcp(tokens.access_token, "oauth_shoes")).rejects.toThrow(/INVALID_TOKEN/);
    expect((await fetch(`${baseUrl}/oauth/token`, form({ grant_type: "refresh_token", refresh_token: tokens.refresh_token, client_id: client.client_id }))).status).toBe(400);
  });

  it("deny sends the client back with access_denied and mints nothing", async () => {
    const before = (db.prepare("SELECT COUNT(*) AS n FROM agents").get() as any).n;
    const { location } = await connectFlow("oauth_shoes", { decision: "deny" });
    expect(location.searchParams.get("error")).toBe("access_denied");
    expect(location.searchParams.get("code")).toBeNull();
    expect((db.prepare("SELECT COUNT(*) AS n FROM agents").get() as any).n).toBe(before);
  });

  it("refuses an unregistered redirect_uri, a non-https redirect, and an unknown shop, without redirecting", async () => {
    const reg = await fetch(`${baseUrl}/oauth/register`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ client_name: "Evil", redirect_uris: ["http://evil.example/cb"] }) });
    expect(reg.status).toBe(400);

    const ok = (await (await fetch(`${baseUrl}/oauth/register`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ client_name: "Claude", redirect_uris: [CALLBACK] }) })).json()) as any;
    const { challenge } = pkce();
    const bad = await fetch(`${baseUrl}/oauth/authorize?${new URLSearchParams({ response_type: "code", client_id: ok.client_id, redirect_uri: "https://attacker.example/cb", code_challenge: challenge, code_challenge_method: "S256" })}`, { redirect: "manual" });
    expect(bad.status).toBe(400);
    const unknownShop = await fetch(`${baseUrl}/oauth/authorize?${new URLSearchParams({ response_type: "code", client_id: ok.client_id, redirect_uri: CALLBACK, code_challenge: challenge, code_challenge_method: "S256", resource: `${baseUrl}/mcp/no_such_shop` })}`, { redirect: "manual" });
    expect(unknownShop.status).toBe(400);
    expect(await unknownShop.text()).toContain("invalid_target");
  });

  it("the manifest advertises the MCP URL and the authorization server", async () => {
    const m = (await (await fetch(`${baseUrl}/.well-known/naka.json?merchant=oauth_shoes`)).json()) as any;
    expect(m.mcp.url).toBe(`${baseUrl}/mcp/oauth_shoes`);
    expect(m.mcp.authorization_server).toBe(`${baseUrl}/.well-known/oauth-authorization-server`);
  });
});
