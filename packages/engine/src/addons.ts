import type { Db } from "@naka/db";
import { newId } from "@naka/shared";
import { insertLedgerRow } from "@naka/ledger";
import { currentPolicy } from "./policy.js";
import { policyForCheckout } from "./tenant.js";
import { buildMandateAgentCtx } from "./mandate-ctx.js";

export interface AddonCandidate {
  variant_id: string;
  title: string;
  price_paise: number;
  new_total_paise: number;
  reason: string;
  score: number;
}

/** Deterministic add-on candidate generation. */
export function suggestAddons(db: Db, checkoutId: string): AddonCandidate[] {
  const { policy } = policyForCheckout(db, checkoutId);
  const checkout = db.prepare("SELECT * FROM checkouts WHERE id = ?").get(checkoutId) as any;
  if (!checkout) return [];

  const lines = db.prepare("SELECT variant_id FROM checkout_lines WHERE checkout_id = ?").all(checkoutId) as Array<{ variant_id: string }>;
  const cartVariantIds = new Set(lines.map((l) => l.variant_id));
  if (cartVariantIds.size === 0) return [];

  const alreadyOffered = new Set(
    (db.prepare("SELECT variant_id FROM addon_offers WHERE checkout_id = ?").all(checkoutId) as Array<{ variant_id: string }>).map(
      (r) => r.variant_id
    )
  );

  const mandateAgent = buildMandateAgentCtx(db, checkout.mandate_id);
  if (mandateAgent.error) return [];

  const placeholders = [...cartVariantIds].map(() => "?").join(",");
  const fbw = db
    .prepare(`SELECT DISTINCT addon_variant_id, MAX(weight) AS weight FROM frequently_bought_with WHERE variant_id IN (${placeholders}) GROUP BY addon_variant_id`)
    .all(...cartVariantIds) as Array<{ addon_variant_id: string; weight: number }>;

  const remainingHeadroom = Math.max(
    0,
    Math.min(policy.max_per_checkout_paise, mandateAgent.mandate.remaining_paise, mandateAgent.mandate.max_per_checkout_paise) - checkout.total_paise
  );

  const candidates: AddonCandidate[] = [];
  for (const f of fbw) {
    if (cartVariantIds.has(f.addon_variant_id) || alreadyOffered.has(f.addon_variant_id)) continue;
    const v = db
      .prepare(
        `SELECT v.*, p.title AS product_title, p.category AS category FROM variants v JOIN products p ON p.id = v.product_id WHERE v.id = ? AND v.active = 1`
      )
      .get(f.addon_variant_id) as any;
    if (!v) continue;
    if (!mandateAgent.mandate.allowed_categories.includes(v.category)) continue;

    const netStock = v.stock_qty - v.reserved_qty;
    if (netStock <= 0) continue;

    const priceShareCap = policy.addon_max_price_share * checkout.subtotal_paise;
    if (v.price_paise > priceShareCap) continue;
    if (v.price_paise > remainingHeadroom) continue;

    const affinity = Math.min(1, f.weight);
    const budgetFit = remainingHeadroom > 0 ? Math.max(0, 1 - v.price_paise / remainingHeadroom) : 0;
    const availability = netStock >= 3 ? 1 : netStock > 0 ? 0.6 : 0;
    const priceShareFit = priceShareCap > 0 ? Math.max(0, 1 - v.price_paise / priceShareCap) : 0;

    const score = 0.45 * affinity + 0.25 * budgetFit + 0.15 * availability + 0.15 * priceShareFit;
    candidates.push({
      variant_id: v.id,
      title: `${v.product_title} ${v.title}`,
      price_paise: v.price_paise,
      new_total_paise: checkout.total_paise + v.price_paise,
      reason: `frequently bought with your cart; fits your remaining budget; ${netStock >= 3 ? "in stock" : "limited stock"}`,
      score: Math.round(score * 1000) / 1000,
    });
  }

  candidates.sort((a, b) => b.score - a.score);
  const top = candidates.slice(0, 5);

  for (const c of top) {
    db.prepare(`INSERT INTO addon_offers (id, checkout_id, variant_id, score, reason, outcome) VALUES (?, ?, ?, ?, ?, 'offered')`).run(
      newId("addon"),
      checkoutId,
      c.variant_id,
      c.score,
      c.reason
    );
  }
  if (top.length > 0) {
    insertLedgerRow(db, { actor: "engine", action: "ADDONS_OFFERED", checkout_id: checkoutId, inputs: { candidates: top.map((c) => c.variant_id) } });
  }
  return top;
}
