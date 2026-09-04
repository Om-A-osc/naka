import { logoMark } from "./logo.js";

/** The shared shell for every merchant-facing page: one navigation bar, one set of base styles, and the small motion/toast runtime the pages share. */
export const BASE_CSS = `
  :root{--ink:#14181f;--muted:#5f6b7a;--line:#e6e8ec;--bg:#f6f7f9;--card:#fff;--accent:#2b6cb0;--accent2:#7c3aed;--ok:#2f855a;--warn:#b7791f;--bad:#c53030;--shadow:0 10px 30px -12px rgba(20,24,31,.18)}
  *{box-sizing:border-box}
  html{scroll-behavior:smooth}
  .nk-nav{position:sticky;top:0;z-index:50;display:flex;justify-content:space-between;align-items:center;gap:12px;padding:12px 20px;background:rgba(255,255,255,.85);backdrop-filter:saturate(180%) blur(10px);-webkit-backdrop-filter:saturate(180%) blur(10px);border-bottom:1px solid transparent;font-family:system-ui,sans-serif;transition:border-color .25s,box-shadow .25s}
  .nk-nav.scrolled{border-bottom-color:var(--line);box-shadow:0 6px 24px -18px rgba(20,24,31,.35)}
  .nk-nav .brand{font-weight:800;font-size:1.15em;color:var(--ink);text-decoration:none;letter-spacing:-.01em;display:inline-flex;align-items:center;gap:8px}
  .nk-nav .brand .nk-mark{width:24px;height:24px;border-radius:7px;box-shadow:0 4px 12px -4px rgba(43,108,176,.6)}
  .nk-mark{display:inline-block;vertical-align:middle}
  .nk-nav .brand small{font-weight:400;color:var(--muted);font-size:.7em;margin-left:4px}
  .nk-nav .links a{color:var(--muted);text-decoration:none;margin-left:16px;font-size:.95em;padding:6px 0;border-bottom:2px solid transparent;transition:color .2s,border-color .2s}
  .nk-nav .links a:hover{color:var(--ink)}
  .nk-nav .links a.on{color:var(--accent);border-bottom-color:var(--accent)}
  .nk-nav .links a.cta{background:var(--accent);color:#fff;padding:7px 12px;border-radius:6px;border:none;transition:transform .15s,box-shadow .2s}
  .nk-nav .links a.cta:hover{transform:translateY(-1px);box-shadow:0 8px 20px -10px rgba(43,108,176,.7);color:#fff}
  @media(max-width:640px){.nk-nav{flex-direction:column;align-items:flex-start}.nk-nav .links a{margin:0 14px 0 0}.nk-nav .brand small{display:none}}

  /* motion */
  .reveal{opacity:0;transform:translateY(18px);transition:opacity .6s cubic-bezier(.2,.7,.2,1),transform .6s cubic-bezier(.2,.7,.2,1)}
  .reveal.in{opacity:1;transform:none}
  .reveal[data-delay="1"]{transition-delay:.08s}.reveal[data-delay="2"]{transition-delay:.16s}.reveal[data-delay="3"]{transition-delay:.24s}.reveal[data-delay="4"]{transition-delay:.32s}.reveal[data-delay="5"]{transition-delay:.4s}
  .lift{transition:transform .2s cubic-bezier(.2,.7,.2,1),box-shadow .2s}.lift:hover{transform:translateY(-3px);box-shadow:var(--shadow)}
  @keyframes nk-fade-up{from{opacity:0;transform:translateY(10px)}to{opacity:1;transform:none}}
  @keyframes nk-pulse{0%{box-shadow:0 0 0 0 rgba(47,133,90,.45)}70%{box-shadow:0 0 0 9px rgba(47,133,90,0)}100%{box-shadow:0 0 0 0 rgba(47,133,90,0)}}
  .live-dot{display:inline-block;width:9px;height:9px;border-radius:50%;background:var(--ok);animation:nk-pulse 1.8s infinite;margin-right:6px;vertical-align:middle}
  @keyframes nk-spin{to{transform:rotate(360deg)}}
  .spinner{display:inline-block;width:18px;height:18px;border:2px solid rgba(43,108,176,.25);border-top-color:var(--accent);border-radius:50%;animation:nk-spin .8s linear infinite;vertical-align:middle;margin-right:8px}

  /* toasts */
  #nk-toasts{position:fixed;right:16px;bottom:16px;z-index:100;display:flex;flex-direction:column;gap:8px;pointer-events:none}
  .nk-toast{pointer-events:auto;background:#1f2430;color:#fff;padding:10px 14px;border-radius:10px;font:14px system-ui,sans-serif;box-shadow:0 14px 34px -12px rgba(0,0,0,.5);display:flex;align-items:center;gap:10px;animation:nk-fade-up .25s;max-width:360px}
  .nk-toast.ok{border-left:4px solid var(--ok)}.nk-toast.bad{border-left:4px solid var(--bad)}.nk-toast.warn{border-left:4px solid var(--warn)}
  .nk-toast.out{opacity:0;transform:translateY(8px);transition:opacity .3s,transform .3s}

  @media(prefers-reduced-motion:reduce){
    html{scroll-behavior:auto}
    .reveal{opacity:1;transform:none;transition:none}
    .lift,.nk-nav .links a.cta{transition:none}.lift:hover{transform:none}
    .live-dot,.spinner{animation:none}
    .parallax{transform:none!important}
  }
`;

/** Runs on every page: nav shadow on scroll, reveal-on-scroll, parallax layers, toasts. */
export const UI_JS = `
  (function(){
    var nav=document.querySelector('.nk-nav');
    var reduce=window.matchMedia('(prefers-reduced-motion: reduce)').matches;
    function onScroll(){ if(nav) nav.classList.toggle('scrolled', window.scrollY>8); if(!reduce) parallax(); }
    var px=[];
    function collect(){ px=[].slice.call(document.querySelectorAll('.parallax')).map(function(el){ return {el:el, f:parseFloat(el.dataset.parallax||'0.15')}; }); }
    var ticking=false;
    function parallax(){ if(ticking) return; ticking=true; requestAnimationFrame(function(){ var y=window.scrollY; px.forEach(function(p){ p.el.style.transform='translate3d(0,'+(y*p.f).toFixed(1)+'px,0)'; }); ticking=false; }); }
    window.addEventListener('scroll', onScroll, {passive:true});
    document.addEventListener('DOMContentLoaded', function(){
      collect(); onScroll();
      var io=new IntersectionObserver(function(es){ es.forEach(function(e){ if(e.isIntersecting){ e.target.classList.add('in'); io.unobserve(e.target); } }); },{threshold:.12});
      document.querySelectorAll('.reveal').forEach(function(el){ io.observe(el); });
      document.querySelectorAll('[data-count]').forEach(function(el){
        var target=Number(el.dataset.count)||0, prefix=el.dataset.prefix||'', suffix=el.dataset.suffix||'';
        if(reduce){ el.textContent=prefix+target.toLocaleString('en-IN')+suffix; return; }
        var o=new IntersectionObserver(function(es){ if(!es[0].isIntersecting) return; o.disconnect(); var t0=performance.now(), d=900;
          (function step(now){ var k=Math.min(1,(now-t0)/d); k=1-Math.pow(1-k,3); el.textContent=prefix+Math.round(target*k).toLocaleString('en-IN')+suffix; if(k<1) requestAnimationFrame(step); })(t0); },{threshold:.5});
        o.observe(el);
      });
    });
    window.nkToast=function(msg,kind){ var host=document.getElementById('nk-toasts'); if(!host){ host=document.createElement('div'); host.id='nk-toasts'; document.body.appendChild(host); }
      var t=document.createElement('div'); t.className='nk-toast '+(kind||''); t.textContent=msg; host.appendChild(t);
      setTimeout(function(){ t.classList.add('out'); setTimeout(function(){ t.remove(); },320); }, 3200); };
  })();
`;

export type NavPage = "home" | "console" | "onboard" | "shop" | "";

export function nav(active: NavPage): string {
  const link = (href: string, label: string, key: NavPage, cls = "") =>
    `<a href="${href}" class="${active === key ? "on " : ""}${cls}">${label}</a>`;
  return `<nav class="nk-nav">
    <a class="brand" href="/">${logoMark(24)}Naka <small>merchant storefront for AI buyers</small></a>
    <span class="links">${link("/", "Home", "home")}${link("/shop", "Demo shop", "shop")}${link("/console", "Console", "console")}${link("/onboard", "Onboard your shop", "onboard", "cta")}</span>
  </nav><script>${UI_JS}</script>`;
}
