import { z } from "zod";

/** The fields the buyer actually signs (everything except `signature` and `id`/`status`/`created_at`). */
export const MandateBodySchema = z.object({
  merchant_id: z.string().min(1),
  agent_id: z.string().min(1),
  agent_pubkey: z.string().min(1),
  buyer_ref: z.string().min(1),
  max_per_checkout_paise: z.number().int().nonnegative(),
  max_total_paise: z.number().int().nonnegative(),
  allowed_categories: z.array(z.string()).min(1),
  expires_at: z.number().int(), // unix seconds
});
export type MandateBody = z.infer<typeof MandateBodySchema>;

export interface Mandate extends MandateBody {
  id: string;
  buyer_pubkey: string;
  signature: string;
  status: "active" | "revoked" | "expired";
  created_at: string;
}
