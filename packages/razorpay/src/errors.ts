export class RazorpayApiError extends Error {
  description: string;
  constructor(description: string) {
    super(description);
    this.description = description;
    this.name = "RazorpayApiError";
  }
}

/** Extracts the human-readable description from either our own RazorpayApiError or the real SDK's error shape. */
export function rzpErrorDescription(err: unknown): string {
  if (err instanceof RazorpayApiError) return err.description;
  const e = err as any;
  return e?.error?.description ?? e?.description ?? e?.message ?? String(err);
}

export const DUPLICATE_RECEIPT_PREFIX = "Duplicate request. This request has already been processed.";
export const LOCK_ERROR_PREFIX = "Request failed because another order operation is in progress.";
export const AMOUNT_EXCEEDS_MAX = "Amount exceeds maximum amount allowed.";
