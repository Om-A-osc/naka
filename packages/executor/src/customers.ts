import type { Db } from "@naka/db";
import type { RazorpayClient } from "@naka/razorpay";
import { rzpErrorDescription } from "@naka/razorpay";
import { insertLedgerRow } from "@naka/ledger";

/** Secondary-scope Customers API integration. */
export async function ensureRazorpayCustomer(db: Db, rzp: RazorpayClient, buyerRef: string): Promise<string | null> {
  const existing = db.prepare("SELECT razorpay_customer_id FROM buyers WHERE buyer_ref = ?").get(buyerRef) as
    | { razorpay_customer_id: string | null }
    | undefined;
  if (existing?.razorpay_customer_id) return existing.razorpay_customer_id;

  try {
    const customer = await rzp.customers.createOrFetch({ name: buyerRef });
    db.prepare(
      `INSERT INTO buyers (buyer_ref, razorpay_customer_id) VALUES (?, ?)
       ON CONFLICT(buyer_ref) DO UPDATE SET razorpay_customer_id = excluded.razorpay_customer_id`
    ).run(buyerRef, customer.id);
    insertLedgerRow(db, { actor: "executor", action: "CUSTOMER_ENSURED", inputs: { buyer_ref: buyerRef, razorpay_customer_id: customer.id } });
    return customer.id;
  } catch (err) {
    // Non-fatal: Customers API is a nice-to-have prefill, not on the money path.
    insertLedgerRow(db, { actor: "executor", action: "CUSTOMER_ENSURE_FAILED", inputs: { buyer_ref: buyerRef, description: rzpErrorDescription(err) } });
    return null;
  }
}
