import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { z, ZodError } from "zod";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import type { Db } from "@naka/db";
import { getMerchant, merchantDisplayName } from "@naka/engine";
import { TOOLS, renderSystemPrompt } from "@naka/channels";
import { runTool, type ToolContext, type ToolName, type ToolOutcome } from "./dispatch.js";
import { hashToken } from "./token.js";
import { wwwAuthenticate } from "./oauth.js";

/** The merchant's storefront as a remote MCP server: POST /mcp speaks Streamable HTTP. */
type Principal = { agentId: string; agentName: string; merchantId: string; mandateId: string };
type Rejection = { status: number; code: string; message: string };

export function registerRemoteMcpRoutes(app: FastifyInstance, db: Db) {
  const authenticate = (req: FastifyRequest): Principal | Rejection => {
    const m = /^Bearer\s+(\S+)$/i.exec(String(req.headers.authorization ?? ""));
    if (!m) return { status: 401, code: "MISSING_TOKEN", message: "send Authorization: Bearer <agent token>; mint one in the merchant console under Buyer agents" };
    const agent = db.prepare("SELECT id, name, merchant_id, status FROM agents WHERE token_hash = ?").get(hashToken(m[1])) as
      | { id: string; name: string; merchant_id: string; status: string }
      | undefined;
    if (!agent) return { status: 401, code: "INVALID_TOKEN", message: "unknown agent token" };
    if (agent.status !== "active") return { status: 403, code: "AGENT_SUSPENDED", message: "this agent has been suspended by the merchant" };
    const mandate = db.prepare("SELECT id FROM mandates WHERE agent_id = ? AND status = 'active' ORDER BY created_at DESC LIMIT 1").get(agent.id) as { id: string } | undefined;
    if (!mandate) return { status: 403, code: "NO_MANDATE", message: "this agent has no active mandate" };
    return { agentId: agent.id, agentName: agent.name, merchantId: agent.merchant_id, mandateId: mandate.id };
  };

  // /mcp binds to whatever shop the token belongs to; /mcp/<merchant id> is the URL a shop hands out.
  const handle = (merchantFromUrl?: string) => async (req: FastifyRequest, reply: FastifyReply) => {
    const who = authenticate(req);
    if ("status" in who) {
      if (who.status === 401) reply.header("WWW-Authenticate", wwwAuthenticate(merchantFromUrl));
      return reply.code(who.status).send({ jsonrpc: "2.0", error: { code: -32001, message: `${who.code}: ${who.message}` }, id: null });
    }
    if (merchantFromUrl && who.merchantId !== merchantFromUrl) {
      return reply.code(403).send({ jsonrpc: "2.0", error: { code: -32001, message: "WRONG_MERCHANT: this token belongs to a different shop" }, id: null });
    }

    const server = buildMcpServer(db, who);
    const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined, enableJsonResponse: true });
    reply.hijack();
    reply.raw.on("close", () => {
      void transport.close();
      void server.close();
    });
    await server.connect(transport);
    await transport.handleRequest(req.raw, reply.raw, req.body);
  };
  app.post("/mcp", handle());
  app.post("/mcp/:merchantId", async (req, reply) => {
    const { merchantId } = req.params as { merchantId: string };
    if (!getMerchant(db, merchantId)) return reply.code(404).send({ jsonrpc: "2.0", error: { code: -32001, message: "UNKNOWN_MERCHANT: no such shop on this server" }, id: null });
    return handle(merchantId)(req, reply);
  });

  const notAllowed = async (_req: FastifyRequest, reply: FastifyReply) =>
    reply.code(405).header("Allow", "POST").send({ jsonrpc: "2.0", error: { code: -32000, message: "Method not allowed: this MCP endpoint is stateless, use POST" }, id: null });
  app.get("/mcp", notAllowed);
  app.delete("/mcp", notAllowed);
  app.get("/mcp/:merchantId", notAllowed);
  app.delete("/mcp/:merchantId", notAllowed);
}

function describe(name: string): string {
  const t = TOOLS.find((x) => x.function.name === name);
  return t?.function.description ?? name;
}

function buildMcpServer(db: Db, who: Principal): McpServer {
  const merchantName = merchantDisplayName(db, who.merchantId);
  const server = new McpServer(
    { name: `naka-${who.merchantId}`, version: "0.1.0" },
    { instructions: renderSystemPrompt(merchantName) }
  );
  const ctx: ToolContext = { merchantId: who.merchantId, agentId: who.agentId };
  const asResult = (o: ToolOutcome) => ({ content: [{ type: "text" as const, text: JSON.stringify(o.body, null, 2) }], isError: o.status >= 400 });
  const call = (name: ToolName, args: unknown) => {
    try {
      return asResult(runTool(db, ctx, name, args));
    } catch (err) {
      if (err instanceof ZodError) return asResult({ status: 400, body: { error: { code: "INVALID_ARGS", message: err.issues.map((i) => `${i.path.join(".")}: ${i.message}`).join("; ") } } });
      throw err;
    }
  };
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
    async (args) => call("search_catalog", args)
  );
  server.registerTool(
    "get_product",
    { title: "Get product details", description: describe("get_product"), inputSchema: { product_id: z.string() } },
    async (args) => call("get_product", args)
  );
  server.registerTool(
    "create_checkout",
    { title: "Propose a cart (reserves stock)", description: describe("create_checkout"), inputSchema: { line_items: lineItems, coupon_code: z.string().optional() } },
    async (args) => call("create_checkout", { ...args, mandate_id: who.mandateId, buyer_ref: who.agentName })
  );
  server.registerTool(
    "get_checkout",
    { title: "Read checkout status", description: describe("get_checkout"), inputSchema: { checkout_id: z.string() } },
    async (args) => call("get_checkout", args)
  );
  server.registerTool(
    "update_checkout",
    { title: "Replace the cart's line items", description: describe("update_checkout"), inputSchema: { checkout_id: z.string(), line_items: lineItems, coupon_code: z.string().optional() } },
    async (args) => call("update_checkout", args)
  );
  server.registerTool(
    "suggest_addons",
    { title: "Bounded add-on suggestions", description: describe("suggest_addons"), inputSchema: { checkout_id: z.string() } },
    async (args) => call("suggest_addons", args)
  );
  server.registerTool(
    "complete_checkout",
    { title: "Finalize and get the payment link", description: describe("complete_checkout"), inputSchema: { checkout_id: z.string(), line_items_hash: z.string() } },
    async (args) => call("complete_checkout", args)
  );
  server.registerTool(
    "cancel_checkout",
    { title: "Cancel an unpaid checkout", description: describe("cancel_checkout"), inputSchema: { checkout_id: z.string(), reason: z.string() } },
    async (args) => call("cancel_checkout", args)
  );
  return server;
}
