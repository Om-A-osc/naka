import type { FastifyInstance } from "fastify";
import type { Db } from "@naka/db";
import { merchantDisplayName } from "@naka/engine";
import { env } from "../config/env.js";
import { BASE_CSS, nav } from "./ui.js";

/** The front door. Says what Naka is in one screen, routes a returning merchant to sign in and a new one to onboard. */
export function registerLandingRoutes(app: FastifyInstance, db: Db) {
  app.get("/", async (_req, reply) => {
    const merchants = (db.prepare("SELECT COUNT(*) AS n FROM merchants").get() as { n: number }).n;
    const paid = (db.prepare("SELECT COUNT(*) AS n FROM checkouts WHERE status = 'completed'").get() as { n: number }).n;
    const ledger = (db.prepare("SELECT COUNT(*) AS n FROM ledger").get() as { n: number }).n;
    const agents = (db.prepare("SELECT COUNT(*) AS n FROM agents WHERE status = 'active'").get() as { n: number }).n;
    return reply.type("text/html").send(landingPage({ merchants, paid, ledger, agents, mode: env.mode, defaultShop: merchantDisplayName(db, env.merchantId), defaultId: env.merchantId }));
  });
}

function landingPage(s: { merchants: number; paid: number; ledger: number; agents: number; mode: string; defaultShop: string; defaultId: string }): string {
  const base = env.baseUrl.replace(/\/$/, "");
  const tools: Array<[string, string]> = [
    ["search_catalog", "find products by text, category or budget"],
    ["get_product", "every variant with price and stock"],
    ["create_checkout", "propose a cart, priced and policy-checked by the merchant, stock reserved"],
    ["update_checkout", "change the cart; the same checks run again"],
    ["suggest_addons", "at most a few add-ons, already within the merchant's rules"],
    ["complete_checkout", "get the pay link for the human to confirm"],
    ["get_checkout", "status, including payment"],
    ["cancel_checkout", "release an unpaid cart"],
  ];
  const flow: Array<[string, string]> = [
    ["Buyer's AI", "asks for 500 g filter coffee"],
    ["search_catalog", "real prices, real stock"],
    ["create_checkout", "cart priced server-side"],
    ["Policy gate", "A2 · B1 · B3 · B5 · S1 · G2"],
    ["Human confirms", "one click on the pay page"],
    ["Razorpay order", "created exactly once"],
    ["Webhook / reconcile", "payment truth, twice over"],
    ["Ledger", "hash-chained, append-only"],
  ];
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Naka</title>
<meta name="description" content="Naka makes any Razorpay merchant transactable by AI buyer agents, every money action explainable, bounded and gated.">
<style>${BASE_CSS}
body{margin:0;font-family:system-ui,-apple-system,"Segoe UI",Roboto,sans-serif;color:var(--ink);background:var(--bg);overflow-x:hidden}
.wrap{max-width:1040px;margin:0 auto;padding:0 20px;position:relative}
.hero{position:relative;overflow:hidden;padding:84px 0 56px;background:linear-gradient(120deg,#eef4ff 0%,#f6f7f9 45%,#f3eefe 100%);background-size:200% 200%;animation:grad 14s ease infinite}
@keyframes grad{0%{background-position:0% 50%}50%{background-position:100% 50%}100%{background-position:0% 50%}}
.blob{position:absolute;border-radius:50%;filter:blur(60px);opacity:.55;pointer-events:none;will-change:transform}
.b1{width:420px;height:420px;background:#bcd3ff;top:-140px;right:-80px}.b2{width:320px;height:320px;background:#e1d1ff;bottom:-160px;left:-60px}.b3{width:220px;height:220px;background:#c8f0dc;top:40%;left:55%}
.eyebrow{display:inline-block;font-size:.8em;letter-spacing:.08em;text-transform:uppercase;color:var(--accent);background:#fff;border:1px solid #d6e2f5;border-radius:999px;padding:5px 12px;margin:0 0 18px}
.hero h1{font-size:clamp(2em,5vw,3.1em);line-height:1.08;margin:0 0 16px;letter-spacing:-.025em;max-width:820px}
.rot{display:inline-block;position:relative;color:var(--accent);min-width:6.2em}
.rot span{display:inline-block;transition:opacity .35s,transform .35s}.rot span.out{opacity:0;transform:translateY(-.5em)}.rot span.pre{opacity:0;transform:translateY(.5em)}
.rot:after{content:"";position:absolute;left:0;right:0;bottom:-4px;height:3px;border-radius:3px;background:linear-gradient(90deg,var(--accent),var(--accent2))}
.lead{font-size:1.15em;color:var(--muted);max-width:640px;margin:0 0 26px;line-height:1.5}
.btn{display:inline-block;padding:13px 20px;border-radius:9px;text-decoration:none;font-weight:600;margin:0 10px 10px 0;transition:transform .15s,box-shadow .2s}
.btn.primary{background:var(--accent);color:#fff;box-shadow:0 10px 24px -12px rgba(43,108,176,.8)}.btn.primary:hover{transform:translateY(-2px);box-shadow:0 16px 30px -12px rgba(43,108,176,.9)}
.btn.ghost{border:1px solid var(--accent);color:var(--accent);background:rgba(255,255,255,.7)}.btn.ghost:hover{transform:translateY(-2px);background:#fff}
.strip{display:grid;grid-template-columns:repeat(auto-fit,minmax(170px,1fr));gap:12px;margin:-28px auto 40px;position:relative;z-index:2}
.strip>div{background:#fff;border:1px solid var(--line);border-radius:12px;padding:16px 18px;box-shadow:var(--shadow)}
.strip b{font-size:1.7em;display:block;letter-spacing:-.02em}.strip span{color:var(--muted);font-size:.85em}
h2{font-size:1.5em;margin:52px 0 16px;letter-spacing:-.01em}h2 small{display:block;font-weight:400;color:var(--muted);font-size:.62em;margin-top:4px}
.cards{display:grid;grid-template-columns:repeat(auto-fit,minmax(260px,1fr));gap:14px}
.card{background:#fff;border:1px solid var(--line);border-radius:12px;padding:20px}.card h3{margin:0 0 8px;font-size:1.05em}.card p{margin:0;color:var(--muted);font-size:.95em;line-height:1.5}
.num{display:inline-flex;width:28px;height:28px;border-radius:50%;background:linear-gradient(135deg,var(--accent),var(--accent2));color:#fff;align-items:center;justify-content:center;font-size:.85em;margin-right:10px}
.flow{background:#fff;border:1px solid var(--line);border-radius:14px;padding:22px 18px 18px;overflow-x:auto}
.track{position:relative;display:grid;grid-template-columns:repeat(8,minmax(118px,1fr));gap:10px;min-width:960px}
.track:before{content:"";position:absolute;left:8%;right:8%;top:22px;height:2px;background:var(--line)}
.track .pulse{position:absolute;top:18px;left:8%;width:10px;height:10px;border-radius:50%;background:var(--accent);box-shadow:0 0 0 6px rgba(43,108,176,.15);animation:ride 8s linear infinite}
@keyframes ride{0%{left:8%}100%{left:calc(92% - 10px)}}
.node{position:relative;text-align:center;padding-top:8px}
.node i{display:block;width:30px;height:30px;margin:0 auto 10px;border-radius:50%;background:#fff;border:2px solid var(--line);transition:border-color .3s,box-shadow .3s,transform .3s;position:relative;z-index:1}
.node.lit i{border-color:var(--accent);box-shadow:0 0 0 6px rgba(43,108,176,.14);transform:scale(1.12)}
.node b{display:block;font-size:.88em;transition:color .3s}.node.lit b{color:var(--accent)}.node span{display:block;color:var(--muted);font-size:.78em;margin-top:3px}
.tools{background:#fff;border:1px solid var(--line);border-radius:12px;padding:6px 18px}.tools div{display:grid;grid-template-columns:190px 1fr;gap:12px;padding:10px 0;border-bottom:1px solid var(--line);font-size:.93em;transition:background .2s}.tools div:hover{background:#fafbfd}.tools div:last-child{border-bottom:none}.tools code{font-family:ui-monospace,SFMono-Regular,Menlo,monospace;color:var(--accent)}
pre{background:#1f2430;color:#e6e8ec;padding:16px;border-radius:10px;overflow:auto;font-size:.82em;position:relative;margin:8px 0}
.copy{position:absolute;top:10px;right:10px;background:rgba(255,255,255,.12);color:#fff;border:1px solid rgba(255,255,255,.2);border-radius:6px;padding:4px 9px;font-size:.8em;cursor:pointer}.copy:hover{background:rgba(255,255,255,.22)}
.rules{display:grid;grid-template-columns:repeat(auto-fit,minmax(230px,1fr));gap:12px;margin-top:10px}.rule{padding:14px 16px;border-left:3px solid var(--accent);background:#fff;border-radius:8px;font-size:.93em;border-top:1px solid var(--line);border-right:1px solid var(--line);border-bottom:1px solid var(--line)}.rule b{display:block;margin-bottom:4px}
.cta-band{margin:56px 0 0;padding:34px 28px;border-radius:16px;background:linear-gradient(135deg,#1f2a44,#2b6cb0 60%,#7c3aed);color:#fff;display:flex;justify-content:space-between;align-items:center;gap:16px;flex-wrap:wrap;box-shadow:0 24px 50px -30px rgba(43,108,176,.9)}
.cta-band h3{margin:0 0 4px;font-size:1.3em}.cta-band p{margin:0;opacity:.85}.cta-band .btn.primary{background:#fff;color:var(--accent);box-shadow:none}
footer{margin:40px 0 30px;color:var(--muted);font-size:.85em;border-top:1px solid var(--line);padding-top:16px;display:flex;justify-content:space-between;flex-wrap:wrap;gap:8px}
@media(prefers-reduced-motion:reduce){.hero{animation:none}.track .pulse{animation:none}.btn:hover{transform:none}}
</style></head><body>${nav("home")}
<section class="hero">
  <div class="blob b1 parallax" data-parallax="0.25"></div>
  <div class="blob b2 parallax" data-parallax="-0.12"></div>
  <div class="blob b3 parallax" data-parallax="0.08"></div>
  <div class="wrap">
    <span class="eyebrow reveal">Built on Razorpay test-mode APIs</span>
    <h1 class="reveal" data-delay="1">Make your <span class="rot"><span id="rot">coffee roaster</span></span><br>transactable by any AI buyer.</h1>
    <p class="lead reveal" data-delay="2">Naka is the merchant's counter for the agentic web. Buyers' AI assistants browse your catalog and propose carts; your policy decides, a human confirms every payment on Razorpay, and every money action lands in a tamper-evident ledger. No model on your side, nothing to talk into a discount.</p>
    <div class="reveal" data-delay="3">
      <a class="btn primary" href="/onboard">Onboard your shop</a>
      <a class="btn ghost" href="/console">Sign in to your console</a>
      <a class="btn ghost" href="/shop">Browse the demo shop</a>
    </div>
  </div>
</section>

<div class="wrap">
  <div class="strip reveal">
    <div><b data-count="${s.merchants}">0</b><span>shop${s.merchants === 1 ? "" : "s"} on this Naka</span></div>
    <div><b data-count="${s.paid}">0</b><span>paid orders</span></div>
    <div><b data-count="${s.ledger}">0</b><span>ledger entries, hash-chained</span></div>
    <div><b data-count="${s.agents}">0</b><span>active buyer agents</span></div>
    <div><b>${s.mode === "real" ? "Test mode" : "Simulated"}</b><span>${s.mode === "real" ? "real Razorpay test-mode orders and webhooks" : "recorded client, no keys needed"}</span></div>
  </div>

  <h2 class="reveal">One purchase, step by step <small>every hop is either deterministic code or a human, the model only proposes</small></h2>
  <div class="flow reveal" data-delay="1">
    <div class="track" id="track">
      <div class="pulse"></div>
      ${flow.map(([t, d], i) => `<div class="node${i === 0 ? " lit" : ""}"><i></i><b>${t}</b><span>${d}</span></div>`).join("")}
    </div>
  </div>

  <h2 class="reveal">How it works</h2>
  <div class="cards">
    <div class="card lift reveal" data-delay="1"><h3><span class="num">1</span>Onboard in one form</h3><p>A shop name, a console password and a catalog JSON. Optional Razorpay test keys and two policy numbers. You get a console, a webhook URL and secret for the Razorpay dashboard, and a buyer agent kit.</p></div>
    <div class="card lift reveal" data-delay="2"><h3><span class="num">2</span>Connect a buyer</h3><p>Paste the kit into Claude Code's <code>.mcp.json</code>, or give your shop a Telegram bot from the console. The agent signs every call with its own Ed25519 key and buys under a mandate you set, categories, per-checkout cap, expiry.</p></div>
    <div class="card lift reveal" data-delay="3"><h3><span class="num">3</span>Sell, safely</h3><p>Every cart passes your policy gate with named rules. Orders over your threshold wait for your approval. A human clicks Confirm on the pay page before any money moves. The ledger records all of it.</p></div>
  </div>

  <h2 class="reveal">What a buyer agent can do here</h2>
  <div class="tools reveal" data-delay="1">${tools.map(([n, d]) => `<div><code>${n}</code><span>${d}</span></div>`).join("")}</div>

  <h2 class="reveal">Connect from Claude Code <small>mint a buyer agent in your console, save its key, paste this into <code>.mcp.json</code>, the demo shop here is <b>${s.defaultShop}</b></small></h2>
  <pre class="reveal" data-delay="1"><button class="copy" onclick="copySnippet(this)">Copy</button><code id="snippet">{
  "mcpServers": {
    "naka": {
      "command": "node",
      "args": ["node_modules/tsx/dist/cli.mjs", "apps/buyer/src/mcp-server.ts"],
      "env": {
        "NAKA_URL": "${base}",
        "NAKA_MERCHANT": "${s.defaultId}",
        "NAKA_AGENT_ID": "&lt;from your kit&gt;",
        "NAKA_MANDATE_ID": "&lt;from your kit&gt;",
        "NAKA_AGENT_KEY": "/path/to/agent.private.pem"
      }
    }
  }
}</code></pre>

  <h2 class="reveal">What is enforced, not promised</h2>
  <div class="rules">
    <div class="rule lift reveal" data-delay="1"><b>Explainable</b>Every decision carries rule ids and the numbers compared, B1_MAX_PER_CHECKOUT: 349900 vs 300000.</div>
    <div class="rule lift reveal" data-delay="2"><b>Bounded</b>Merchant policy caps, per-agent daily caps, mandate scope and expiry, coupon table only, the agent cannot set a price.</div>
    <div class="rule lift reveal" data-delay="3"><b>Gated</b>Orders are created only after a nonce-confirmed human click; large orders wait for you; refunds need your approval.</div>
    <div class="rule lift reveal" data-delay="1"><b>Audited</b>Append-only, SHA-256-chained ledger keyed to real Razorpay ids; verify and export from the console.</div>
    <div class="rule lift reveal" data-delay="2"><b>Recovers</b>Failed payments retry in-session; a webhook outage is covered by reconciliation against Razorpay.</div>
    <div class="rule lift reveal" data-delay="3"><b>No LLM on the merchant side</b>The buyer's assistant is the only model in the loop, and it holds no Razorpay credentials.</div>
  </div>

  <div class="cta-band reveal">
    <div><h3>Your shop, open to AI buyers in a minute.</h3><p>A catalog file and a password. Razorpay keys optional.</p></div>
    <a class="btn primary" href="/onboard">Onboard your shop →</a>
  </div>

  <footer><span>Runs on Razorpay <b>test mode</b> only; the server refuses live keys.</span><span><a href="/.well-known/naka.json">Manifest</a> · <a href="/shop">Demo shop</a> · Built for the Razorpay AI Buildathon</span></footer>
</div>
<script>
  (function(){
    var words=["coffee roaster","shoe store","bookshop","bakery","pharmacy","sari boutique"], i=0, el=document.getElementById('rot');
    if(window.matchMedia('(prefers-reduced-motion: reduce)').matches) return;
    setInterval(function(){ el.classList.add('out'); setTimeout(function(){ i=(i+1)%words.length; el.textContent=words[i]; el.classList.remove('out'); el.classList.add('pre'); requestAnimationFrame(function(){ requestAnimationFrame(function(){ el.classList.remove('pre'); }); }); },360); }, 2600);
    var nodes=[].slice.call(document.querySelectorAll('#track .node')), k=0;
    setInterval(function(){ nodes[k].classList.remove('lit'); k=(k+1)%nodes.length; nodes[k].classList.add('lit'); }, 1000);
  })();
  function copySnippet(btn){ navigator.clipboard.writeText(document.getElementById('snippet').textContent).then(function(){ btn.textContent='Copied'; nkToast('Snippet copied, fill in your agent id, mandate id and key path','ok'); setTimeout(function(){ btn.textContent='Copy'; },1500); }); }
</script>
</body></html>`;
}
