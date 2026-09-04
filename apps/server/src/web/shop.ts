import type { FastifyInstance } from "fastify";
import type { Db } from "@naka/db";
import { getMerchant } from "@naka/engine";
import { formatInr } from "@naka/shared";
import { env } from "../config/env.js";
import { BASE_CSS, nav } from "./ui.js";
import { FAVICON_LINK } from "./logo.js";

/** A merchant's public storefront page, the link a shop shares. */
export function registerShopRoutes(app: FastifyInstance, db: Db) {
  const render = (merchantId: string, reply: any) => {
    const merchant = getMerchant(db, merchantId);
    if (!merchant) return reply.code(404).type("text/html").send(shell("Not found", `<div class="wrap"><h2>No such shop.</h2><p><a href="/">Back to Naka</a></p></div>`, ""));
    const tg = db.prepare("SELECT telegram_bot_username FROM merchants WHERE id = ?").get(merchantId) as { telegram_bot_username: string | null };
    const rows = db
      .prepare(
        `SELECT p.id AS product_id, p.title, p.description, p.category, v.id AS variant_id, v.title AS variant_title, v.price_paise, v.stock_qty, v.reserved_qty
         FROM products p JOIN variants v ON v.product_id = p.id
         WHERE p.merchant_id = ? AND p.active = 1 AND v.active = 1 ORDER BY p.category, p.title, v.price_paise`
      )
      .all(merchantId) as Array<{ product_id: string; title: string; description: string; category: string; variant_id: string; variant_title: string; price_paise: number; stock_qty: number; reserved_qty: number }>;
    const products = new Map<string, { title: string; description: string; category: string; variants: typeof rows }>();
    for (const r of rows) {
      if (!products.has(r.product_id)) products.set(r.product_id, { title: r.title, description: r.description, category: r.category, variants: [] });
      products.get(r.product_id)!.variants.push(r);
    }
    const categories = [...new Set(rows.map((r) => r.category))];
    return reply.type("text/html").send(shopPage({ id: merchantId, name: merchant.display_name, telegram: tg?.telegram_bot_username ?? null, products, categories }));
  };
  app.get("/shop", async (_req, reply) => render(env.merchantId, reply));
  app.get("/shop/:merchantId", async (req, reply) => render((req.params as { merchantId: string }).merchantId, reply));
}

function esc(s: string): string {
  return String(s ?? "").replace(/&/g, "&amp;").replace(/</g, "&lt;");
}

function shell(title: string, body: string, extraCss: string): string {
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">${FAVICON_LINK}<title>${esc(title)}</title>
<style>${BASE_CSS}
body{margin:0;font-family:system-ui,-apple-system,"Segoe UI",Roboto,sans-serif;color:var(--ink);background:var(--bg);overflow-x:hidden}
.wrap{max-width:1100px;margin:0 auto;padding:0 20px;position:relative}
${extraCss}</style></head><body>${nav("shop")}${body}</body></html>`;
}

function shopPage(s: { id: string; name: string; telegram: string | null; products: Map<string, { title: string; description: string; category: string; variants: any[] }>; categories: string[] }): string {
  const base = env.baseUrl.replace(/\/$/, "");
  const stockPill = (v: any) => {
    const n = v.stock_qty - v.reserved_qty;
    return n <= 0 ? `<span class="pill out">sold out</span>` : n <= 3 ? `<span class="pill low">only ${n} left</span>` : `<span class="pill in">in stock</span>`;
  };
  const cards = [...s.products.entries()]
    .map(
      ([pid, p], i) => `<div class="prod lift reveal" data-cat="${esc(p.category)}" data-delay="${(i % 3) + 1}">
      <span class="cat">${esc(p.category)}</span>
      <h3>${esc(p.title)}</h3>
      <p>${esc(p.description)}</p>
      <ul>${p.variants.map((v) => `<li><span>${esc(v.variant_title)}</span><b>${formatInr(v.price_paise as any)}</b>${stockPill(v)}</li>`).join("")}</ul>
      <code class="pid">${esc(pid)}</code>
    </div>`
    )
    .join("");
  const body = `
<section class="head">
  <div class="blob parallax" data-parallax="0.2"></div>
  <div class="wrap">
    <span class="eyebrow reveal">Storefront for AI buyers</span>
    <h1 class="reveal" data-delay="1">${esc(s.name)}</h1>
    <p class="lead reveal" data-delay="2">${s.products.size} products · ${[...s.products.values()].reduce((n, p) => n + p.variants.length, 0)} variants · live prices and stock. Your assistant can browse and propose; you confirm every payment on Razorpay.</p>
  </div>
</section>
<div class="wrap grid">
  <div>
    <div class="chips reveal"><button class="chip on" data-cat="">All</button>${s.categories.map((c) => `<button class="chip" data-cat="${esc(c)}">${esc(c)}</button>`).join("")}</div>
    <div class="prods" id="prods">${cards || `<p class="muted">This shop has not published a catalog yet.</p>`}</div>
  </div>
  <aside class="reveal" data-delay="2">
    <div class="box">
      <h3>Buy here with your assistant</h3>
      ${s.telegram ? `<a class="btn tg" href="https://t.me/${esc(s.telegram)}" target="_blank" rel="noopener"><span class="live-dot"></span>Chat with @${esc(s.telegram)} on Telegram</a><p class="muted">The shop's own bot. Ask for what you want, get a pay link.</p>` : `<p class="muted">This shop has not connected a Telegram bot yet.</p>`}
      <h4>Claude Code / any MCP client</h4>
      <p class="muted">Claude.ai, Claude Desktop or ChatGPT: add <code>${base}/mcp/${esc(s.id)}</code> as a custom connector and click Allow. Claude Code with a token:</p>
      <pre><button class="copy" onclick="copySnippet(this)">Copy</button><code id="snippet">{
  "mcpServers": {
    "naka-${esc(s.id)}": {
      "type": "http",
      "url": "${base}/mcp",
      "headers": { "Authorization": "Bearer &lt;agent token from the shop&gt;" }
    }
  }
}</code></pre>
      <h4>What the assistant cannot do</h4>
      <ul class="cant"><li>Change a price or invent a discount</li><li>Exceed the mandate you gave it</li><li>Pay, only you can, on the Razorpay page</li></ul>
      <p class="muted"><a href="/.well-known/naka.json?merchant=${esc(s.id)}">Machine-readable manifest</a></p>
    </div>
  </aside>
</div>
<footer class="wrap"><span>Powered by <a href="/">Naka</a> · Razorpay test mode</span></footer>
<script>
  document.querySelectorAll('.chip').forEach(function(ch){ ch.addEventListener('click', function(){
    document.querySelectorAll('.chip').forEach(function(c){ c.classList.toggle('on', c===ch); });
    var cat=ch.dataset.cat; document.querySelectorAll('.prod').forEach(function(p){ var show=!cat||p.dataset.cat===cat; p.style.display=show?'':'none'; if(show){ p.classList.remove('in'); requestAnimationFrame(function(){ p.classList.add('in'); }); } });
  }); });
  function copySnippet(btn){ navigator.clipboard.writeText(document.getElementById('snippet').textContent).then(function(){ btn.textContent='Copied'; nkToast('Snippet copied','ok'); setTimeout(function(){ btn.textContent='Copy'; },1500); }); }
</script>`;
  const css = `
.head{position:relative;overflow:hidden;padding:56px 0 36px;background:linear-gradient(120deg,#eef4ff,#f6f7f9 50%,#f3eefe)}
.head .blob{position:absolute;width:380px;height:380px;border-radius:50%;background:#c9dbff;filter:blur(60px);opacity:.6;right:-90px;top:-120px;pointer-events:none}
.eyebrow{display:inline-block;font-size:.78em;letter-spacing:.08em;text-transform:uppercase;color:var(--accent);background:#fff;border:1px solid #d6e2f5;border-radius:999px;padding:4px 12px;margin-bottom:14px}
.head h1{margin:0 0 10px;font-size:clamp(1.8em,4vw,2.6em);letter-spacing:-.02em}.lead{color:var(--muted);max-width:640px;margin:0;font-size:1.05em}
.grid{display:grid;grid-template-columns:1fr 340px;gap:24px;margin-top:24px}@media(max-width:900px){.grid{grid-template-columns:1fr}}
.chips{display:flex;gap:8px;flex-wrap:wrap;margin:0 0 14px}.chip{border:1px solid var(--line);background:#fff;border-radius:999px;padding:6px 12px;font:inherit;font-size:.88em;cursor:pointer;color:var(--muted);transition:all .15s}.chip.on,.chip:hover{border-color:var(--accent);color:var(--accent);background:#eef4ff}
.prods{display:grid;grid-template-columns:repeat(auto-fill,minmax(250px,1fr));gap:14px}
.prod{background:#fff;border:1px solid var(--line);border-radius:12px;padding:16px;display:flex;flex-direction:column}.prod .cat{font-size:.72em;text-transform:uppercase;letter-spacing:.06em;color:var(--accent)}.prod h3{margin:6px 0 6px;font-size:1.05em}.prod p{margin:0 0 10px;color:var(--muted);font-size:.9em;line-height:1.45;flex:1}
.prod ul{list-style:none;margin:0;padding:0}.prod li{display:flex;align-items:center;gap:8px;padding:7px 0;border-top:1px solid var(--line);font-size:.92em}.prod li span:first-child{flex:1}.prod li b{white-space:nowrap}
.pill{font-size:.72em;padding:2px 8px;border-radius:999px;white-space:nowrap}.pill.in{background:#e6f4ea;color:var(--ok)}.pill.low{background:#fff4e0;color:var(--warn)}.pill.out{background:#fde8e8;color:var(--bad)}
.pid{margin-top:10px;font-size:.72em;color:#99a;font-family:ui-monospace,monospace}
.box{background:#fff;border:1px solid var(--line);border-radius:12px;padding:16px 18px;position:sticky;top:76px}.box h3{margin:0 0 10px}.box h4{margin:16px 0 6px;font-size:.95em}.muted{color:var(--muted);font-size:.9em}
.btn{display:block;text-align:center;padding:11px 14px;border-radius:9px;text-decoration:none;font-weight:600}.btn.tg{background:#229ED9;color:#fff;box-shadow:0 10px 24px -12px rgba(34,158,217,.8)}
pre{background:#1f2430;color:#e6e8ec;padding:12px;border-radius:8px;overflow:auto;font-size:.74em;position:relative;margin:6px 0}
.copy{position:absolute;top:8px;right:8px;background:rgba(255,255,255,.12);color:#fff;border:1px solid rgba(255,255,255,.2);border-radius:6px;padding:3px 8px;font-size:.8em;cursor:pointer}
.cant{margin:0;padding-left:18px;font-size:.9em;color:#334}.cant li{margin:4px 0}
footer{margin:36px auto 30px;color:var(--muted);font-size:.85em;border-top:1px solid var(--line);padding-top:14px}`;
  return shell(`${s.name}, Naka`, body, css);
}
