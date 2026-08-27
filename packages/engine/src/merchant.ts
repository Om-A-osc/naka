import { readFileSync } from "node:fs";
import type { Db } from "@naka/db";

export interface MerchantRow {
  id: string;
  name: string;
  display_name: string;
  currency: string;
}

/** The one place merchant identity comes from. */
export function defaultMerchantId(catalogPath = process.env.NAKA_CATALOG ?? "./data/catalog.json"): string {
  if (process.env.NAKA_MERCHANT_ID) return process.env.NAKA_MERCHANT_ID;
  try {
    const file = JSON.parse(readFileSync(catalogPath, "utf8")) as { merchant?: { id?: string } };
    if (file.merchant?.id) return file.merchant.id;
  } catch {
    // fall through to the error below
  }
  throw new Error(`No merchant id: set NAKA_MERCHANT_ID or provide a catalog file with a merchant block at ${catalogPath}`);
}

export function getMerchant(db: Db, id: string): MerchantRow | undefined {
  return db.prepare("SELECT id, name, display_name, currency FROM merchants WHERE id = ?").get(id) as MerchantRow | undefined;
}

/** Display name for a merchant, never throwing, a label must not take a request down. */
export function merchantDisplayName(db: Db, id: string): string {
  return getMerchant(db, id)?.display_name ?? id;
}
