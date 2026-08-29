/** The shared shell for every merchant-facing page: one navigation bar and one set of base styles, so the landing page, sign-in. */
export const BASE_CSS = `
  :root{--ink:#1a1a1a;--muted:#667;--line:#e6e8ec;--bg:#f6f7f9;--card:#fff;--accent:#2b6cb0;--ok:#2f855a;--warn:#b7791f;--bad:#c53030}
  *{box-sizing:border-box}
  .nk-nav{display:flex;justify-content:space-between;align-items:center;gap:12px;padding:12px 20px;background:#fff;border-bottom:1px solid var(--line);font-family:system-ui,sans-serif}
  .nk-nav .brand{font-weight:800;font-size:1.15em;color:var(--ink);text-decoration:none;letter-spacing:-.01em}
  .nk-nav .brand small{font-weight:400;color:var(--muted);font-size:.7em;margin-left:8px}
  .nk-nav .links a{color:var(--muted);text-decoration:none;margin-left:16px;font-size:.95em;padding:6px 0;border-bottom:2px solid transparent}
  .nk-nav .links a.on{color:var(--accent);border-bottom-color:var(--accent)}
  .nk-nav .links a.cta{background:var(--accent);color:#fff;padding:7px 12px;border-radius:6px;border:none}
  @media(max-width:640px){.nk-nav{flex-direction:column;align-items:flex-start}.nk-nav .links a{margin:0 14px 0 0}}
`;

export type NavPage = "home" | "console" | "onboard" | "";

export function nav(active: NavPage): string {
  const link = (href: string, label: string, key: NavPage, cls = "") =>
    `<a href="${href}" class="${active === key ? "on " : ""}${cls}">${label}</a>`;
  return `<nav class="nk-nav">
    <a class="brand" href="/">Naka <small>merchant storefront for AI buyers</small></a>
    <span class="links">${link("/", "Home", "home")}${link("/console", "Console", "console")}${link("/.well-known/naka.json", "Manifest", "")}${link("/onboard", "Onboard your shop", "onboard", "cta")}</span>
  </nav>`;
}
