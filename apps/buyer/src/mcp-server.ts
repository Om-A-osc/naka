/** A real MCP server for Naka, over stdio, so a standard MCP client, Claude Code, Claude Desktop, anything that speaks the protocol. */
import { existsSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { z } from "zod";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { NakaClient } from "./mcp-client.js";
import { loadSystemPrompt } from "./prompt.js";
import { TOOLS } from "./tools-openai.js";

const NAKA_ROOT = fileURLToPath(new URL("../../../", import.meta.url));
const log = (...a: unknown[]) => console.error("[naka-mcp]", ...a);

function describe(name: string): string {
  const t = TOOLS.find((x) => x.function.name === name);
  return t?.function.description ?? name;
}

function resolveConfig() {
  const baseUrl = (process.env.NAKA_URL ?? "http://127.0.0.1:3000").replace(/\/$/, "");
  let agentId = process.env.NAKA_AGENT_ID;
  let keyPath = process.env.NAKA_AGENT_KEY;
  let mandateId = process.env.NAKA_MANDATE_ID;

  if (!agentId || !keyPath || !mandateId) {
    const seedPath = `${NAKA_ROOT}data/seed-output.json`;
    if (!existsSync(seedPath)) {
      throw new Error(`No agent configured. Set NAKA_AGENT_ID/NAKA_AGENT_KEY/NAKA_MANDATE_ID, or run \`pnpm seed\` to create ${seedPath}`);
    }
    const seed = JSON.parse(readFileSync(seedPath, "utf8"));
    agentId ??= seed.agents["buyer-claude"].id;
    keyPath ??= `${NAKA_ROOT}${seed.agents["buyer-claude"].privateKeyPath}`;
    mandateId ??= seed.mandates.buyer_claude;
  }
  return { baseUrl, agentId: agentId!, keyPath: keyPath!, mandateId: mandateId!, buyerRef: process.env.NAKA_BUYER_REF ?? "mcp_client", merchantId: process.env.NAKA_MERCHANT };
}

function asResult(result: unknown) {
  const isError = typeof result === "object" && result !== null && "error" in (result as any);
  return { content: [{ type: "text" as const, text: JSON.stringify(result, null, 2) }], isError };
}

async function main() {
  const cfg = resolveConfig();
  const buyer = new NakaClient(cfg.baseUrl, cfg.agentId, cfg.keyPath, cfg.merchantId);

  let merchantName = "the merchant";
  try {
    const manifest = (await (await fetch(`${cfg.baseUrl}/.well-known/naka.json${cfg.merchantId ? `?merchant=${encodeURIComponent(cfg.merchantId)}` : ""}`)).json()) as { merchant?: { display_name?: string } };
    merchantName = manifest.merchant?.display_name ?? merchantName;
  } catch (err) {
    log(`could not reach ${cfg.baseUrl} for the manifest (${(err as Error).message}); tools will fail until the server is up`);
  }
  const instructions = await loadSystemPrompt(cfg.baseUrl, cfg.merchantId);

  const server = new McpServer(
    { name: `naka-${merchantName.toLowerCase().replace(/[^a-z0-9]+/g, "-")}`, version: "0.1.0" },
    { instructions }
  );

  const lineItems = z.array(z.object({ variant_id: z.string(), quantity: z.number().int().min(1).max(99) })).min(1);

  server.registerTool(
    "search_catalog",
    {
      title: `Search ${merchantName}'s catalog`,
      description: describe("search_catalog"),
      inputSchema: {
        query: z.string().describe("Free-text search: a product name, size, or attribute. Empty string browses everything."),
        category: z.string().optional().describe("Optional exact category filter; category names appear on search results."),
        max_price_paise: z.number().int().positive().optional().describe("Optional ceiling in PAISE (100 paise = ₹1). Omit unless the human gave a budget."),
        limit: z.number().int().min(1).max(20).optional(),
      },
    },
    async (args) => asResult(await buyer.searchCatalog(args))
  );

  server.registerTool(
    "get_product",
    { title: "Get product details", description: describe("get_product"), inputSchema: { product_id: z.string() } },
    async (args) => asResult(await buyer.getProduct(args))
  );

  server.registerTool(
    "create_checkout",
    {
      title: "Propose a cart (reserves stock)",
      description: describe("create_checkout"),
      inputSchema: { line_items: lineItems, coupon_code: z.string().optional() },
    },
    async (args) => asResult(await buyer.createCheckout({ ...args, mandate_id: cfg.mandateId, buyer_ref: cfg.buyerRef }))
  );

  server.registerTool(
    "get_checkout",
    { title: "Read checkout status", description: describe("get_checkout"), inputSchema: { checkout_id: z.string() } },
    async (args) => asResult(await buyer.getCheckout(args))
  );

  server.registerTool(
    "update_checkout",
    {
      title: "Replace the cart's line items",
      description: describe("update_checkout"),
      inputSchema: { checkout_id: z.string(), line_items: lineItems, coupon_code: z.string().optional() },
    },
    async (args) => asResult(await buyer.updateCheckout(args))
  );

  server.registerTool(
    "suggest_addons",
    { title: "Bounded add-on suggestions", description: describe("suggest_addons"), inputSchema: { checkout_id: z.string() } },
    async (args) => asResult(await buyer.suggestAddons(args))
  );

  server.registerTool(
    "complete_checkout",
    {
      title: "Finalize and get the payment link",
      description: describe("complete_checkout"),
      inputSchema: { checkout_id: z.string(), line_items_hash: z.string() },
    },
    async (args) => asResult(await buyer.completeCheckout(args))
  );

  server.registerTool(
    "cancel_checkout",
    { title: "Cancel an unpaid checkout", description: describe("cancel_checkout"), inputSchema: { checkout_id: z.string(), reason: z.string() } },
    async (args) => asResult(await buyer.cancelCheckout(args))
  );

  const transport = new StdioServerTransport();
  await server.connect(transport);
  log(`serving ${merchantName} at ${cfg.baseUrl} as agent ${cfg.agentId}`);
}

main().catch((err) => {
  log("fatal:", err?.message ?? err);
  process.exit(1);
});
