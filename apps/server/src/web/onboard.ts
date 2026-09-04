import type { FastifyInstance } from "fastify";
import type { Db } from "@naka/db";
import { randomBytes } from "node:crypto";
import { z } from "zod";
import { importCatalog } from "@naka/catalog";
import { generateEd25519KeyPair, registerAgent } from "@naka/identity";
import { issueMandate } from "@naka/mandate";
import { ensureLinkBudget } from "@naka/executor";
import { policyFor, setMerchantPolicy } from "@naka/engine";
import { insertLedgerRow } from "@naka/ledger";
import { sha256hex } from "@naka/shared";
import { env } from "../config/env.js";
import { CatalogFileSchema } from "./catalog-schema.js";
import { BASE_CSS, nav } from "./ui.js";
import { issueAgentToken } from "../mcp/token.js";

/** Self-serve merchant onboarding: the page a merchant lands on with a catalog and comes away from with a working shop that AI buyers can use. */
const OnboardSchema = z
  .object({
    merchant_id: z.string().regex(/^[a-z0-9][a-z0-9_-]{2,31}$/, "3–32 chars: lowercase letters, digits, _ or -"),
    display_name: z.string().min(1).max(80),
    console_password: z.string().min(8, "at least 8 characters").max(200),
    razorpay_key_id: z.string().regex(/^rzp_test_[A-Za-z0-9]+$/, "must be a test-mode key (rzp_test_…)").optional().or(z.literal("")),
    razorpay_key_secret: z.string().min(8).optional().or(z.literal("")),
    max_per_checkout_paise: z.number().int().positive().optional(),
    merchant_approval_over_paise: z.number().int().positive().optional(),
    catalog: CatalogFileSchema,
  })
  .refine((v) => !!v.razorpay_key_id === !!v.razorpay_key_secret, { message: "provide both Razorpay key id and secret, or neither", path: ["razorpay_key_secret"] });

export function registerOnboardRoutes(app: FastifyInstance, db: Db) {
  app.get("/onboard", async (_req, reply) => reply.type("text/html").send(onboardPage()));

  app.post("/api/onboard", { bodyLimit: 2_097_152 }, async (req, reply) => {
    const parsed = OnboardSchema.safeParse(req.body);
    if (!parsed.success) {
      const detail = parsed.error.issues.slice(0, 8).map((i) => `${i.path.join(".") || "(root)"}: ${i.message}`).join("; ");
      return reply.code(400).send({ error: { code: "INVALID_ONBOARDING", message: detail } });
    }
    const input = parsed.data;
    const id = input.merchant_id;

    const exists = db.prepare("SELECT 1 FROM merchants WHERE id = ?").get(id);
    if (exists) return reply.code(409).send({ error: { code: "MERCHANT_EXISTS", message: `merchant id "${id}" is already taken` } });

    const webhookSecret = randomBytes(24).toString("hex");
    const keyId = input.razorpay_key_id || null;
    const keySecret = input.razorpay_key_secret || null;

    const agentKeys = generateEd25519KeyPair();
    const buyerKeys = generateEd25519KeyPair();
    const categories = [...new Set(input.catalog.products.map((p) => p.category))];

    const kit = db.transaction(() => {
      db.prepare(
        `INSERT INTO merchants (id, name, display_name, currency, razorpay_key_id, razorpay_key_secret, webhook_secret, console_password_hash)
         VALUES (?, ?, ?, 'INR', ?, ?, ?, ?)`
      ).run(id, id, input.display_name, keyId, keySecret, webhookSecret, sha256hex(`${id}:${input.console_password}`));

      // importCatalog upserts the merchants row too, but only the four catalog columns, so the credentials written above survive it.
      importCatalog(db, { ...input.catalog, merchant: { id, name: id, display_name: input.display_name, currency: "INR" } });
      ensureLinkBudget(db, id);

      const overrides: Record<string, number> = {};
      if (input.max_per_checkout_paise) overrides.max_per_checkout_paise = input.max_per_checkout_paise;
      if (input.merchant_approval_over_paise) overrides.merchant_approval_over_paise = input.merchant_approval_over_paise;
      const policy = Object.keys(overrides).length ? setMerchantPolicy(db, id, overrides) : policyFor(db, id).policy;

      const agent = registerAgent(db, { merchantId: id, name: "buyer-default", pubkeyPem: agentKeys.publicKeyPem });
      const token = issueAgentToken(db, agent.id);
      const mandate = issueMandate(db, {
        merchant_id: id,
        agent_id: agent.id,
        agent_pubkey: agentKeys.publicKeyPem,
        buyer_ref: "owner",
        max_per_checkout_paise: policy.max_per_checkout_paise,
        max_total_paise: policy.max_per_checkout_paise * 10,
        allowed_categories: categories,
        expires_at: Math.floor(Date.now() / 1000) + 30 * 24 * 3600,
        buyerPublicKeyPem: buyerKeys.publicKeyPem,
        buyerPrivateKeyPem: buyerKeys.privateKeyPem,
      });

      insertLedgerRow(db, {
        actor: "merchant",
        agent_id: agent.id,
        action: "MERCHANT_ONBOARDED",
        inputs: { merchant_id: id, products: input.catalog.products.length, categories, has_razorpay_keys: !!keyId },
      });

      return { agentId: agent.id, mandateId: mandate.id, policy, token };
    })();

    const base = env.baseUrl.replace(/\/$/, "");
    return {
      ok: true,
      merchant: { id, display_name: input.display_name, mode: keyId ? "real (your test keys)" : "recorded (no Razorpay keys given; payments are simulated)" },
      console: { url: `${base}/console`, merchant_id: id },
      razorpay_webhook: {
        url: `${base}/webhooks/razorpay/${id}`,
        secret: webhookSecret,
        events: ["payment.authorized", "payment.captured", "payment.failed", "order.paid", "payment_link.paid", "payment_link.expired", "payment_link.cancelled", "refund.processed", "refund.failed"],
      },
      buyer_agent: {
        agent_id: kit.agentId,
        mandate_id: kit.mandateId,
        private_key_pem: agentKeys.privateKeyPem,
        mcp_token: kit.token,
        mandate: {
          max_per_checkout_paise: kit.policy.max_per_checkout_paise,
          max_total_paise: kit.policy.max_per_checkout_paise * 10,
          allowed_categories: categories,
          expires_in_days: 30,
        },
      },
      mcp: mcpConfigFor(id, kit.agentId, kit.mandateId, kit.token),
    };
  });
}

/** Registers a fresh buyer agent + mandate for a merchant. The private key is returned once and never stored. */
export function mintBuyerAgent(db: Db, merchantId: string, name = "buyer-default") {
  const agentKeys = generateEd25519KeyPair();
  const buyerKeys = generateEd25519KeyPair();
  const policy = policyFor(db, merchantId).policy;
  const categories = (db.prepare("SELECT DISTINCT category FROM products WHERE merchant_id = ? AND active = 1").all(merchantId) as Array<{ category: string }>).map((r) => r.category);
  const agent = registerAgent(db, { merchantId, name, pubkeyPem: agentKeys.publicKeyPem });
  const token = issueAgentToken(db, agent.id);
  const mandate = issueMandate(db, {
    merchant_id: merchantId,
    agent_id: agent.id,
    agent_pubkey: agentKeys.publicKeyPem,
    buyer_ref: "owner",
    max_per_checkout_paise: policy.max_per_checkout_paise,
    max_total_paise: policy.max_per_checkout_paise * 10,
    allowed_categories: categories,
    expires_at: Math.floor(Date.now() / 1000) + 30 * 24 * 3600,
    buyerPublicKeyPem: buyerKeys.publicKeyPem,
    buyerPrivateKeyPem: buyerKeys.privateKeyPem,
  });
  insertLedgerRow(db, { actor: "merchant", agent_id: agent.id, action: "AGENT_MINTED", inputs: { merchant_id: merchantId, name, categories } });
  return {
    agent_id: agent.id,
    mandate_id: mandate.id,
    private_key_pem: agentKeys.privateKeyPem,
    mcp_token: token,
    mandate: { max_per_checkout_paise: policy.max_per_checkout_paise, max_total_paise: policy.max_per_checkout_paise * 10, allowed_categories: categories, expires_in_days: 30 },
  };
}

/** What a buyer pastes to shop at this merchant from Claude Code. */
export function mcpConfigFor(merchantId: string, agentId: string, mandateId: string, token: string) {
  const base = env.baseUrl.replace(/\/$/, "");
  const name = `naka-${merchantId}`;
  return {
    note: "Easiest: add `connector_url` as a custom connector in Claude.ai, Claude Desktop or ChatGPT and click Allow (OAuth; no token to paste). Claude Code: `command_oauth`, then /mcp to sign in, or `config` with the token for a headless setup. Local: save private_key_pem to a file and use `stdio` with NAKA_AGENT_KEY pointing at it.",
    connector_url: `${base}/mcp/${merchantId}`,
    command_oauth: `claude mcp add --transport http ${name} ${base}/mcp/${merchantId}`,
    token,
    config: { mcpServers: { [name]: { type: "http", url: `${base}/mcp`, headers: { Authorization: `Bearer ${token}` } } } },
    command: `claude mcp add --transport http ${name} ${base}/mcp --header "Authorization: Bearer ${token}"`,
    stdio: {
      mcpServers: {
        [name]: {
          command: "node",
          args: ["node_modules/tsx/dist/cli.mjs", "apps/buyer/src/mcp-server.ts"],
          env: { NAKA_URL: base, NAKA_MERCHANT: merchantId, NAKA_AGENT_ID: agentId, NAKA_MANDATE_ID: mandateId, NAKA_AGENT_KEY: `/path/to/${merchantId}-agent.private.pem` },
        },
      },
    },
  };
}

function onboardPage(): string {
  const template = {
    merchant: { display_name: "Chappal & Sons" },
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
    coupons: [{ code: "FIRSTRUN", pct: 10, max_paise: 50000, min_order_paise: 100000 }],
  };
  return `<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><style>${BASE_CSS}</style><title>Naka, onboard your shop</title>
<style>body{font-family:system-ui,sans-serif;margin:0;color:#1a1a1a;background:var(--bg)}.wrap{max-width:860px;margin:24px auto;padding:0 16px}
label{display:block;margin:12px 0 4px;font-weight:600}input,textarea{width:100%;box-sizing:border-box;padding:8px;border:1px solid #ccc;border-radius:6px;font:inherit}
textarea{font-family:ui-monospace,monospace;font-size:0.85em;min-height:220px}.row{display:grid;grid-template-columns:1fr 1fr;gap:16px}
button{background:#2b6cb0;color:#fff;border:none;padding:10px 18px;border-radius:6px;cursor:pointer;font-size:1em;margin-top:16px}
.muted{color:#666;font-size:0.9em}.card{border:1px solid #ddd;border-radius:10px;padding:16px;margin:16px 0}pre{background:#f7f7f7;padding:10px;border-radius:6px;overflow:auto;font-size:0.85em}
.err{color:#c53030}code{background:#f0f0f0;padding:1px 4px;border-radius:3px}
form{animation:nk-fade-up .5s}.kitwrap{animation:nk-fade-up .5s}@keyframes draw{to{stroke-dashoffset:0}}@keyframes pop{0%{transform:scale(.6);opacity:0}60%{transform:scale(1.08);opacity:1}100%{transform:scale(1)}}.mark{width:72px;height:72px;border-radius:50%;display:flex;align-items:center;justify-content:center;margin:6px 0 12px;animation:pop .5s cubic-bezier(.2,.7,.2,1)}.mark.ok{background:#e6f4ea}.mark.bad{background:#fde8e8}.mark.wait{background:#eef4ff}.mark svg{width:40px;height:40px;fill:none;stroke-width:3;stroke-linecap:round;stroke-linejoin:round;stroke-dasharray:60;stroke-dashoffset:60;animation:draw .6s .25s ease-out forwards}.mark.ok svg{stroke:#2f855a}.mark.bad svg{stroke:#c53030}.spinner.big{width:30px;height:30px;border-width:3px;margin:0}@media(prefers-reduced-motion:reduce){.mark,.mark svg{animation:none;stroke-dashoffset:0}}
.steps{display:flex;gap:8px;margin:8px 0 16px;font-size:0.85em}.steps span{padding:4px 10px;border-radius:999px;background:#eef2f7;color:#555}.steps span.on{background:#2b6cb0;color:#fff}
h2{margin:8px 0}</style></head><body>${nav("onboard")}<div class="wrap">
<div class="steps"><span class="on">1 Your shop</span><span>2 Connection kit</span><span>3 Buyers shop from Claude</span></div>
<h2>Onboard your shop on Naka</h2>
<p class="muted">A name, a console password and a catalog, and your shop is transactable by any AI buyer, with every money action explainable, bounded and gated by your policy. Razorpay test keys are optional: without them payments are simulated, which is enough to try the whole flow.</p>
<form id="f" onsubmit="return submitForm(event)">
  <div class="row">
    <div><label>Shop name</label><input id="display_name" value="Chappal &amp; Sons" required></div>
    <div><label>Merchant id <span class="muted">(lowercase, becomes part of your URLs)</span></label><input id="merchant_id" value="chappal" pattern="[a-z0-9][a-z0-9_-]{2,31}" required></div>
  </div>
  <div class="row">
    <div><label>Console password</label><input id="console_password" type="password" minlength="8" required></div>
    <div><label>Max per checkout (₹) <span class="muted">(policy cap B1)</span></label><input id="max_rupees" type="number" min="1" value="5000"></div>
  </div>
  <div class="row">
    <div><label>Razorpay test key id <span class="muted">(optional)</span></label><input id="razorpay_key_id" placeholder="rzp_test_…"></div>
    <div><label>Razorpay test key secret <span class="muted">(optional)</span></label><input id="razorpay_key_secret" type="password"></div>
  </div>
  <div class="row">
    <div><label>Ask me before any order over (₹) <span class="muted">(escalation G2)</span></label><input id="approval_rupees" type="number" min="1" value="3000"></div>
    <div><label>Catalog file <span class="muted">(or edit the JSON below)</span></label><input id="catalogFile" type="file" accept="application/json" onchange="loadFile(this)"></div>
  </div>
  <label>Catalog JSON</label>
  <textarea id="catalog">${JSON.stringify(template, null, 2).replace(/</g, "&lt;")}</textarea>
  <button type="submit">Create my shop</button>
  <p id="err" class="err"></p>
</form>
<div id="kit"></div>
<script>
  async function loadFile(input) { const f = input.files[0]; if (f) document.getElementById('catalog').value = await f.text(); }
  function v(id) { return document.getElementById(id).value.trim(); }
  async function submitForm(e) {
    e.preventDefault();
    const err = document.getElementById('err'); err.textContent = '';
    let catalog;
    try { catalog = JSON.parse(v('catalog')); } catch (x) { err.textContent = 'Catalog is not valid JSON: ' + x.message; return false; }
    const body = {
      merchant_id: v('merchant_id'), display_name: v('display_name'), console_password: v('console_password'),
      razorpay_key_id: v('razorpay_key_id'), razorpay_key_secret: v('razorpay_key_secret'),
      max_per_checkout_paise: Math.round(Number(v('max_rupees')) * 100) || undefined,
      merchant_approval_over_paise: Math.round(Number(v('approval_rupees')) * 100) || undefined,
      catalog,
    };
    const r = await fetch('/api/onboard', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
    const d = await r.json();
    if (!r.ok) { err.textContent = d.error?.message || d.error?.code || 'Failed'; nkToast(err.textContent, 'bad'); return false; }
    renderKit(d);
    return false;
  }
  function esc(s) { return String(s).replace(/&/g,'&amp;').replace(/</g,'&lt;'); }
  function block(title, text, filename) {
    const id = 'b' + Math.random().toString(36).slice(2);
    return '<div class="card"><b>' + esc(title) + '</b> <button type="button" onclick="copyText(\\'' + id + '\\')">Copy</button>' +
      (filename ? ' <button type="button" onclick="download(\\'' + id + '\\', \\'' + filename + '\\')">Download</button>' : '') +
      '<pre id="' + id + '">' + esc(text) + '</pre></div>';
  }
  function copyText(id) { navigator.clipboard.writeText(document.getElementById(id).textContent); }
  function download(id, name) { const a = document.createElement('a'); a.href = URL.createObjectURL(new Blob([document.getElementById(id).textContent])); a.download = name; a.click(); }
  function renderKit(d) {
    document.getElementById('f').style.display = 'none';
    document.getElementById('kit').innerHTML = '<div class="kitwrap"><div class="mark ok"><svg viewBox="0 0 24 24"><path d="M5 13l4 4L19 7"/></svg></div>' +
      '<h2>' + esc(d.merchant.display_name) + ' is live</h2>' +
      '<p>Mode: <b>' + esc(d.merchant.mode) + '</b>. Save this page: the token, key and secret below are shown once and not stored.</p>' +
      '<div class="card"><b>1. Your console</b><p><a href="' + d.console.url + '" target="_blank">' + d.console.url + '</a>, merchant id <code>' + esc(d.console.merchant_id) + '</code>, the password you just chose.</p></div>' +
      '<div class="card"><b>2. Razorpay dashboard → Webhooks → Add</b><p>URL: <code>' + esc(d.razorpay_webhook.url) + '</code></p><p>Secret: <code>' + esc(d.razorpay_webhook.secret) + '</code></p><p class="muted">Events: ' + d.razorpay_webhook.events.join(', ') + '</p></div>' +
      '<h3>3. Give this to an AI buyer</h3>' +
      '<div class="card"><b>Connect from the Claude app, no token needed</b><p>Claude.ai or Claude Desktop → Settings → Connectors → Add custom connector → URL <code>' + esc(d.mcp.connector_url) + '</code> → Connect → <b>Allow</b>. ChatGPT (developer mode) takes the same URL. Claude Code: <code>' + esc(d.mcp.command_oauth) + '</code> then <code>/mcp</code> to sign in.</p><p class="muted">Each person who allows gets their own buyer agent under your policy; you can see and suspend them under Buyer agents.</p></div>' +
      block('.mcp.json for Claude Code with a fixed token (headless setups)', JSON.stringify(d.mcp.config, null, 2), '.mcp.json') +
      block('Or one command in a terminal', d.mcp.command, 'add-naka-mcp.txt') +
      '<details><summary class="muted">Run the MCP server on your own machine instead (needs this repo and the private key)</summary>' +
      block('Agent private key, save as ' + d.merchant.id + '-agent.private.pem', d.buyer_agent.private_key_pem, d.merchant.id + '-agent.private.pem') +
      block('.mcp.json (local stdio; set NAKA_AGENT_KEY to where you saved the key)', JSON.stringify(d.mcp.stdio, null, 2), '.mcp.json') + '</details>' +
      '<p class="muted">Agent <code>' + esc(d.buyer_agent.agent_id) + '</code> may spend up to ₹' + (d.buyer_agent.mandate.max_per_checkout_paise/100) + ' per checkout in ' + d.buyer_agent.mandate.allowed_categories.join(', ') + ', for ' + d.buyer_agent.mandate.expires_in_days + ' days. Every checkout still needs a human to confirm on the pay page.</p>' +
      '<p><a href="/shop/' + esc(d.merchant.id) + '" target="_blank">Open your public storefront →</a> &nbsp; <a href="' + d.console.url + '" target="_blank">Open your console →</a></p></div>';
    document.querySelectorAll('.steps span').forEach(function (s, i) { s.classList.toggle('on', i === 1); });
    nkToast(d.merchant.display_name + ' is live', 'ok');
    window.scrollTo({ top: 0, behavior: 'smooth' });
  }
</script></div></body></html>`;
}
