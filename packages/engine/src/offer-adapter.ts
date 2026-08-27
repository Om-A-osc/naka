import { z } from "zod";
import { readFileSync, existsSync } from "node:fs";

const OfferConfigSchema = z.object({
  dashboard_offer_id: z.string().nullable().default(null),
  dashboard_offer_expected_discount_paise: z.number().int().nonnegative().default(0),
});
export type OfferConfig = z.infer<typeof OfferConfigSchema>;

/** Offers adapter: applies ONE dashboard- created test-mode Offer via `offers:[id]` + `force_offer:true` on order creation. */
export function loadOfferConfig(path = process.env.NAKA_POLICY ?? "./data/policy.json"): OfferConfig {
  if (!existsSync(path)) return OfferConfigSchema.parse({});
  const raw = JSON.parse(readFileSync(path, "utf8"));
  return OfferConfigSchema.parse({
    dashboard_offer_id: raw.dashboard_offer_id ?? null,
    dashboard_offer_expected_discount_paise: raw.dashboard_offer_expected_discount_paise ?? 0,
  });
}

export interface OfferVerification {
  configured: boolean;
  applied: boolean;
  expectedAmountDue: number;
  actualAmountDue: number;
}

/** Called by the executor right after Create Order, when an offer was configured and passed. */
export function verifyOfferApplied(cfg: OfferConfig, orderAmount: number, observedAmount: number): OfferVerification {
  if (!cfg.dashboard_offer_id) return { configured: false, applied: false, expectedAmountDue: observedAmount, actualAmountDue: observedAmount };
  const expectedAmountDue = orderAmount - cfg.dashboard_offer_expected_discount_paise;
  return { configured: true, applied: observedAmount <= expectedAmountDue, expectedAmountDue, actualAmountDue: observedAmount };
}
