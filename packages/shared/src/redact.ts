import { createHash } from "node:crypto";

const SECRET_KEYS = new Set([
  "key_secret",
  "razorpay_key_secret",
  "webhook_secret",
  "authorization",
  "x-razorpay-signature",
  "razorpay_signature",
  "sig",
  "signature",
  "private_key",
  "pubkey_priv",
]);

/** Deep-redacts anything that looks like a secret before it is written to a log or the ledger. */
export function redact(value: unknown): unknown {
  if (value === null || value === undefined) return value;
  if (Array.isArray(value)) return value.map(redact);
  if (typeof value === "object") {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
      if (SECRET_KEYS.has(k.toLowerCase())) {
        out[k] = typeof v === "string" ? `sha256:${sha256hex(v)}` : "[redacted]";
      } else {
        out[k] = redact(v);
      }
    }
    return out;
  }
  return value;
}

export function sha256hex(input: string | Buffer): string {
  return createHash("sha256").update(input).digest("hex");
}

let salt = process.env.LEDGER_SALT ?? "dev-salt-change-me";
export function setPiiSalt(s: string) {
  salt = s;
}

/** One-way hash for PII we still need to correlate (contact, email, vpa). */
export function hashPii(value: string | null | undefined): string | null {
  if (!value) return null;
  return sha256hex(`${salt}:${value}`);
}
