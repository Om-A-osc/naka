import { ulid } from "ulid";

export function newId(prefix?: string): string {
  const id = ulid().toLowerCase();
  return prefix ? `${prefix}_${id}` : id;
}

/** Razorpay receipt: <= 40 chars, ASCII alphanumerics/hyphens only, and treated as an idempotency key for order creation. */
export function receiptFor(checkoutId: string, attemptNo: number): string {
  const clean = checkoutId.replace(/[^a-z0-9]/gi, "").toLowerCase().slice(0, 32);
  const receipt = `c${clean}a${String(attemptNo).padStart(2, "0")}`;
  if (receipt.length > 40) throw new Error(`receipt too long: ${receipt}`);
  if (!/^[a-z0-9-]+$/i.test(receipt)) throw new Error(`receipt not ASCII-safe: ${receipt}`);
  return receipt;
}

export function refundReceiptFor(refundId: string): string {
  const clean = refundId.replace(/[^a-z0-9]/gi, "").toLowerCase().slice(0, 32);
  return `rf${clean}`;
}

/** Payment Links' `reference_id` has the same 40-char/ASCII constraint as `receipt`, and is likewise its natural idempotency key. */
export function referenceIdFor(checkoutId: string, attemptNo: number): string {
  const clean = checkoutId.replace(/[^a-z0-9]/gi, "").toLowerCase().slice(0, 32);
  const ref = `l${clean}a${String(attemptNo).padStart(2, "0")}`;
  if (ref.length > 40) throw new Error(`reference_id too long: ${ref}`);
  return ref;
}
