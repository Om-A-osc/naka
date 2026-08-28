import { createHmac, timingSafeEqual } from "node:crypto";

function hmacHex(secret: string, message: string | Buffer): string {
  return createHmac("sha256", secret).update(message).digest("hex");
}

/** Constant-time hex-string compare (the razorpay-node helpers use plain `===`, which is not). */
export function safeEqualHex(expected: string, given: string | undefined | null): boolean {
  if (typeof given !== "string" || given.length !== expected.length) return false;
  return timingSafeEqual(Buffer.from(expected, "utf8"), Buffer.from(given, "utf8"));
}

/** Checkout.js handler payload: HMAC-SHA256(order_id|payment_id, key_secret). */
export function verifyCheckoutSignature(
  p: { razorpay_order_id: string; razorpay_payment_id: string; razorpay_signature: string },
  keySecret: string
): boolean {
  return safeEqualHex(hmacHex(keySecret, `${p.razorpay_order_id}|${p.razorpay_payment_id}`), p.razorpay_signature);
}

export function signCheckoutPayload(orderId: string, paymentId: string, keySecret: string): string {
  return hmacHex(keySecret, `${orderId}|${paymentId}`);
}

/** Webhook: HMAC-SHA256 over the RAW request body, keyed with the webhook secret(s). */
export function verifyWebhookSignature(rawBody: Buffer | string, header: string | undefined, secrets: string[]): boolean {
  if (!header) return false;
  return secrets.filter(Boolean).some((s) => safeEqualHex(hmacHex(s, rawBody), header));
}

export function signWebhookBody(rawBody: Buffer | string, secret: string): string {
  return hmacHex(secret, rawBody);
}
