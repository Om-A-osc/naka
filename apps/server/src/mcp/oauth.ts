import type { FastifyInstance, FastifyReply } from "fastify";
import { createHash, randomBytes } from "node:crypto";
import type { Db } from "@naka/db";
import { getMerchant, merchantDisplayName, policyFor } from "@naka/engine";
import { formatInr } from "@naka/shared";
import { env } from "../config/env.js";
import { BASE_CSS } from "../web/ui.js";
import { mintBuyerAgent } from "../web/onboard.js";
import { hashToken, issueAgentToken } from "./token.js";

/** Naka as an OAuth 2.1 authorization server for its own MCP endpoint. */
const base = () => env.baseUrl.replace(/\/$/, "");
const now = () => Math.floor(Date.now() / 1000);
const sha256b64url = (s: string) => createHash("sha256").update(s).digest("base64url");
const esc = (s: unknown) => String(s ?? "").replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/"/g, "&quot;");

export function serverMetadata() {
  const b = base();
  return {
    issuer: b,
    authorization_endpoint: `${b}/oauth/authorize`,
    token_endpoint: `${b}/oauth/token`,
    registration_endpoint: `${b}/oauth/register`,
    response_types_supported: ["code"],
    grant_types_supported: ["authorization_code", "refresh_token"],
    code_challenge_methods_supported: ["S256"],
    token_endpoint_auth_methods_supported: ["none"],
    scopes_supported: ["shop"],
    service_documentation: `${b}/`,
  };
}

export function resourceMetadata(merchantId?: string) {
  const b = base();
  return {
    resource: merchantId ? `${b}/mcp/${merchantId}` : `${b}/mcp`,
    authorization_servers: [b],
    bearer_methods_supported: ["header"],
    scopes_supported: ["shop"],
    resource_name: "Naka storefront for AI buyers",
  };
}

/** The WWW-Authenticate header a 401 from /mcp carries, which is how clients find the metadata above. */
export function wwwAuthenticate(merchantId?: string): string {
  return `Bearer realm="naka", resource_metadata="${base()}/.well-known/oauth-protected-resource${merchantId ? `/mcp/${merchantId}` : ""}"`;
}

type Client = { id: string; name: string; redirect_uris: string[] };
type Authz = { client: Client; redirect_uri: string; code_challenge: string; state: string; merchantId: string; resource: string };
type Bad = { error: string; description: string };

function validRedirect(u: string): boolean {
  try {
    const url = new URL(u);
    if (url.protocol === "https:") return true;
    return url.protocol === "http:" && (url.hostname === "localhost" || url.hostname === "127.0.0.1");
  } catch {
    return false;
  }
}

/** Which merchant an MCP resource URL names: /mcp/<id> is that shop, /mcp is the default shop. */
function merchantFromResource(resource: string | undefined): string | null {
  if (!resource) return env.merchantId;
  try {
    const path = new URL(resource).pathname.replace(/\/$/, "");
    if (path === "/mcp") return env.merchantId;
    const m = /^\/mcp\/([A-Za-z0-9_-]+)$/.exec(path);
    return m ? m[1] : null;
  } catch {
    return null;
  }
}

export function registerOAuthRoutes(app: FastifyInstance, db: Db) {
  // OAuth token and consent posts are form-encoded; Fastify parses only JSON out of the box.
  app.addContentTypeParser("application/x-www-form-urlencoded", { parseAs: "string" }, (_req, body, done) => {
    try {
      done(null, Object.fromEntries(new URLSearchParams(String(body))));
    } catch (err) {
      done(err as Error);
    }
  });

  // Browser-based MCP clients and inspectors fetch these cross-origin.
  const CORS_PREFIX = ["/mcp", "/oauth/", "/.well-known/oauth"];
  app.addHook("onSend", async (req, reply) => {
    if (CORS_PREFIX.some((p) => req.url.startsWith(p))) {
      reply.header("Access-Control-Allow-Origin", "*");
      reply.header("Access-Control-Allow-Methods", "GET, POST, DELETE, OPTIONS");
      reply.header("Access-Control-Allow-Headers", "Authorization, Content-Type, Accept, Mcp-Session-Id, Mcp-Protocol-Version");
      reply.header("Access-Control-Expose-Headers", "Mcp-Session-Id, WWW-Authenticate");
    }
  });
  for (const url of ["/mcp", "/mcp/:merchantId", "/oauth/token", "/oauth/register", "/.well-known/oauth-authorization-server", "/.well-known/oauth-protected-resource", "/.well-known/oauth-protected-resource/mcp", "/.well-known/oauth-protected-resource/mcp/:merchantId"]) {
    app.options(url, async (_req, reply) => reply.code(204).send());
  }

  app.get("/.well-known/oauth-authorization-server", async () => serverMetadata());
  app.get("/.well-known/oauth-protected-resource", async () => resourceMetadata());
  app.get("/.well-known/oauth-protected-resource/mcp", async () => resourceMetadata());
  app.get("/.well-known/oauth-protected-resource/mcp/:merchantId", async (req, reply) => {
    const { merchantId } = req.params as { merchantId: string };
    if (!getMerchant(db, merchantId)) return reply.code(404).send({ error: "unknown_merchant" });
    return resourceMetadata(merchantId);
  });

  // Dynamic client registration (RFC 7591): public clients, no secret.
  app.post("/oauth/register", async (req, reply) => {
    const body = (req.body ?? {}) as Record<string, unknown>;
    const uris = Array.isArray(body.redirect_uris) ? (body.redirect_uris as unknown[]).filter((u): u is string => typeof u === "string") : [];
    if (!uris.length || !uris.every(validRedirect)) {
      return reply.code(400).send({ error: "invalid_redirect_uri", error_description: "redirect_uris must be https URLs (http://localhost is allowed for development)" });
    }
    const id = `client_${randomBytes(12).toString("base64url")}`;
    const name = String(body.client_name ?? "MCP client").slice(0, 80) || "MCP client";
    db.prepare("INSERT INTO oauth_clients (id, name, redirect_uris) VALUES (?, ?, ?)").run(id, name, JSON.stringify(uris));
    return reply.code(201).send({
      client_id: id,
      client_id_issued_at: now(),
      client_name: name,
      redirect_uris: uris,
      token_endpoint_auth_method: "none",
      grant_types: ["authorization_code", "refresh_token"],
      response_types: ["code"],
      scope: "shop",
    });
  });

  const clientOf = (id: string | undefined): Client | undefined => {
    if (!id) return undefined;
    const row = db.prepare("SELECT id, name, redirect_uris FROM oauth_clients WHERE id = ?").get(id) as { id: string; name: string; redirect_uris: string } | undefined;
    return row ? { id: row.id, name: row.name, redirect_uris: JSON.parse(row.redirect_uris) } : undefined;
  };

  /** Validates an authorization request. Errors here must NOT redirect: the redirect_uri itself may be the bad part. */
  const validateAuthorize = (p: Record<string, string | undefined>): Authz | Bad => {
    if ((p.response_type ?? "code") !== "code") return { error: "unsupported_response_type", description: "only response_type=code is supported" };
    const client = clientOf(p.client_id);
    if (!client) return { error: "invalid_client", description: "unknown client_id; register first at /oauth/register" };
    const redirect_uri = p.redirect_uri ?? "";
    if (!client.redirect_uris.includes(redirect_uri)) return { error: "invalid_request", description: "redirect_uri is not registered for this client" };
    if (!p.code_challenge) return { error: "invalid_request", description: "PKCE code_challenge is required" };
    if ((p.code_challenge_method ?? "S256") !== "S256") return { error: "invalid_request", description: "only code_challenge_method=S256 is supported" };
    const merchantId = p.merchant_id || merchantFromResource(p.resource);
    if (!merchantId || !getMerchant(db, merchantId)) return { error: "invalid_target", description: "the resource does not name a shop on this server; use https://<host>/mcp/<merchant id>" };
    return { client, redirect_uri, code_challenge: p.code_challenge, state: p.state ?? "", merchantId, resource: p.resource ?? `${base()}/mcp/${merchantId}` };
  };

  app.get("/oauth/authorize", async (req, reply) => {
    const check = validateAuthorize(req.query as Record<string, string>);
    if ("error" in check) return reply.code(400).type("text/html").send(errorPage(check));
    return reply.type("text/html").send(consentPage(db, check));
  });

  app.post("/oauth/authorize", async (req, reply) => {
    const f = (req.body ?? {}) as Record<string, string>;
    const check = validateAuthorize(f);
    if ("error" in check) return reply.code(400).type("text/html").send(errorPage(check));
    const redirect = new URL(check.redirect_uri);
    if (check.state) redirect.searchParams.set("state", check.state);
    if (f.decision !== "allow") {
      redirect.searchParams.set("error", "access_denied");
      return reply.redirect(redirect.toString(), 302);
    }

    let agentId: string;
    const pasted = (f.agent_token ?? "").trim();
    if (pasted) {
      // A buyer who already holds a token from the merchant binds this client to that agent.
      const agent = db.prepare("SELECT id, merchant_id, status FROM agents WHERE token_hash = ?").get(hashToken(pasted)) as { id: string; merchant_id: string; status: string } | undefined;
      if (!agent || agent.status !== "active" || agent.merchant_id !== check.merchantId) {
        return reply.code(400).type("text/html").send(errorPage({ error: "invalid_token", description: "that token does not belong to an active buyer agent of this shop" }));
      }
      agentId = agent.id;
    } else {
      const label = check.client.name.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "").slice(0, 24) || "client";
      agentId = mintBuyerAgent(db, check.merchantId, `${label}-${randomBytes(3).toString("hex")}`).agent_id;
    }

    const code = randomBytes(32).toString("base64url");
    db.prepare("INSERT INTO oauth_codes (code_hash, client_id, redirect_uri, code_challenge, agent_id, merchant_id, expires_at) VALUES (?, ?, ?, ?, ?, ?, ?)").run(
      hashToken(code), check.client.id, check.redirect_uri, check.code_challenge, agentId, check.merchantId, now() + 600
    );
    redirect.searchParams.set("code", code);
    return reply.redirect(redirect.toString(), 302);
  });

  app.post("/oauth/token", async (req, reply) => {
    reply.header("Cache-Control", "no-store");
    const f = (req.body ?? {}) as Record<string, string>;
    const bad = (error: string, description: string) => reply.code(400).send({ error, error_description: description });

    if (f.grant_type === "authorization_code") {
      const row = db.prepare("SELECT * FROM oauth_codes WHERE code_hash = ?").get(hashToken(String(f.code ?? ""))) as
        | { code_hash: string; client_id: string; redirect_uri: string; code_challenge: string; agent_id: string; expires_at: number; used: number }
        | undefined;
      if (!row || row.used || row.expires_at < now()) return bad("invalid_grant", "authorization code is unknown, already used, or expired");
      if (!f.client_id || f.client_id !== row.client_id) return bad("invalid_grant", "client_id does not match the authorization");
      if (f.redirect_uri && f.redirect_uri !== row.redirect_uri) return bad("invalid_grant", "redirect_uri does not match the authorization");
      if (!f.code_verifier || sha256b64url(f.code_verifier) !== row.code_challenge) return bad("invalid_grant", "PKCE verification failed");
      db.prepare("UPDATE oauth_codes SET used = 1 WHERE code_hash = ?").run(row.code_hash);
      return issueTokens(db, row.client_id, row.agent_id);
    }

    if (f.grant_type === "refresh_token") {
      const row = db.prepare("SELECT token_hash, client_id, agent_id FROM oauth_refresh_tokens WHERE token_hash = ? AND revoked = 0").get(hashToken(String(f.refresh_token ?? ""))) as
        | { token_hash: string; client_id: string; agent_id: string }
        | undefined;
      if (!row) return bad("invalid_grant", "refresh token is unknown or revoked");
      if (f.client_id && f.client_id !== row.client_id) return bad("invalid_grant", "client_id does not match the refresh token");
      const agent = db.prepare("SELECT status FROM agents WHERE id = ?").get(row.agent_id) as { status: string } | undefined;
      if (!agent || agent.status !== "active") return bad("invalid_grant", "this agent has been suspended by the merchant");
      db.prepare("UPDATE oauth_refresh_tokens SET revoked = 1 WHERE token_hash = ?").run(row.token_hash);
      return issueTokens(db, row.client_id, row.agent_id);
    }

    return bad("unsupported_grant_type", "use authorization_code or refresh_token");
  });
}

/** Access token = the agent's bearer token (rotated), plus a fresh single-use refresh token. */
function issueTokens(db: Db, clientId: string, agentId: string) {
  const access = issueAgentToken(db, agentId);
  const refresh = randomBytes(32).toString("base64url");
  db.prepare("INSERT INTO oauth_refresh_tokens (token_hash, client_id, agent_id) VALUES (?, ?, ?)").run(hashToken(refresh), clientId, agentId);
  return { access_token: access, token_type: "Bearer", refresh_token: refresh, scope: "shop" };
}

function shell(title: string, body: string): string {
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${esc(title)}</title>
<style>${BASE_CSS}
body{margin:0;font-family:system-ui,-apple-system,"Segoe UI",Roboto,sans-serif;color:var(--ink);background:var(--bg)}
.wrap{max-width:520px;margin:48px auto;padding:0 18px;animation:nk-fade-up .45s}
.brand{font-weight:800;display:inline-flex;align-items:center;gap:8px;margin-bottom:18px}.brand .dot{width:10px;height:10px;border-radius:50%;background:linear-gradient(135deg,var(--accent),var(--accent2))}
.card{background:#fff;border:1px solid var(--line);border-radius:14px;padding:22px;box-shadow:var(--shadow)}
h1{font-size:1.3em;margin:0 0 8px;letter-spacing:-.01em}p{margin:8px 0;line-height:1.5}.muted{color:var(--muted);font-size:.92em}
ul{margin:8px 0 14px;padding-left:20px}li{margin:4px 0}
.row{display:flex;gap:10px;margin-top:18px}
button{font:inherit;font-weight:600;padding:11px 18px;border-radius:9px;cursor:pointer;border:1px solid var(--accent)}
button.allow{background:var(--accent);color:#fff;box-shadow:0 10px 24px -12px rgba(43,108,176,.8)}button.deny{background:#fff;color:var(--accent)}
details{margin-top:14px}summary{cursor:pointer;color:var(--muted);font-size:.9em}input{width:100%;box-sizing:border-box;margin-top:8px;padding:9px 10px;border:1px solid var(--line);border-radius:8px;font:inherit}
.pill{display:inline-block;background:#eef2f7;border-radius:999px;padding:2px 10px;font-size:.8em}
</style></head><body><div class="wrap"><div class="brand"><span class="dot"></span>Naka</div>${body}</div></body></html>`;
}

function consentPage(db: Db, a: Authz): string {
  const merchantName = merchantDisplayName(db, a.merchantId);
  const policy = policyFor(db, a.merchantId).policy;
  const categories = (db.prepare("SELECT DISTINCT category FROM products WHERE merchant_id = ? AND active = 1 ORDER BY category").all(a.merchantId) as Array<{ category: string }>).map((r) => r.category);
  const hidden = (k: string, v: string) => `<input type="hidden" name="${esc(k)}" value="${esc(v)}">`;
  return shell(`Connect ${a.client.name} to ${merchantName}`, `
<div class="card">
  <h1>Let <b>${esc(a.client.name)}</b> shop at <b>${esc(merchantName)}</b>?</h1>
  <p class="muted">Allowing creates a buyer agent for you at this shop. It can browse the catalog and propose carts on your behalf, within these limits:</p>
  <ul>
    <li>At most <b>${formatInr(policy.max_per_checkout_paise as any)}</b> per checkout${categories.length ? `, only in <span class="pill">${categories.map(esc).join("</span> <span class=\"pill\">")}</span>` : ""}</li>
    <li>Orders above <b>${formatInr(policy.merchant_approval_over_paise as any)}</b> wait for the shop's approval</li>
    <li><b>No payment happens without you.</b> Every order ends on a Razorpay page where you confirm and pay yourself</li>
    <li>The shop can see and suspend this agent at any time; every action it takes is written to an append-only ledger</li>
  </ul>
  <form method="post" action="/oauth/authorize">
    ${hidden("response_type", "code")}${hidden("client_id", a.client.id)}${hidden("redirect_uri", a.redirect_uri)}${hidden("code_challenge", a.code_challenge)}${hidden("code_challenge_method", "S256")}${hidden("state", a.state)}${hidden("merchant_id", a.merchantId)}${hidden("resource", a.resource)}
    <details><summary>I already have an agent token from this shop</summary><input type="text" name="agent_token" placeholder="nk_..." autocomplete="off"><p class="muted">Paste it to connect as that agent instead of creating a new one.</p></details>
    <div class="row"><button class="allow" name="decision" value="allow" type="submit">Allow</button><button class="deny" name="decision" value="deny" type="submit">Deny</button></div>
  </form>
  <p class="muted" style="margin-top:14px">You will be sent back to ${esc(new URL(a.redirect_uri).hostname)}.</p>
</div>`);
}

function errorPage(e: Bad): string {
  return shell("Cannot connect", `<div class="card"><h1>Cannot connect</h1><p><span class="pill">${esc(e.error)}</span></p><p>${esc(e.description)}</p><p class="muted">Nothing was created. Go back to the app and try again with a valid connector URL, for example <code>${esc(base())}/mcp/&lt;merchant id&gt;</code>.</p></div>`);
}

export type { FastifyReply };
