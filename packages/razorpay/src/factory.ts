import { RecordedRazorpayClient, type WebhookSink } from "./recorded.js";
import { createRealRazorpayClient } from "./real.js";
import type { RazorpayClient } from "./types.js";

/** The one place `RAZORPAY_MODE` is read. */
export function createRazorpayClient(sink?: WebhookSink): RazorpayClient {
  const mode = process.env.RAZORPAY_MODE ?? "recorded";
  if (mode === "real") {
    const keyId = process.env.RAZORPAY_KEY_ID;
    const keySecret = process.env.RAZORPAY_KEY_SECRET;
    if (!keyId || !keySecret) {
      throw new Error("RAZORPAY_MODE=real requires RAZORPAY_KEY_ID and RAZORPAY_KEY_SECRET");
    }
    return createRealRazorpayClient(keyId, keySecret);
  }
  const webhookSecret = process.env.RZP_WEBHOOK_SECRET || "recorded-mode-dev-secret";
  return new RecordedRazorpayClient(webhookSecret, sink);
}

export function webhookSecrets(): string[] {
  const mode = process.env.RAZORPAY_MODE ?? "recorded";
  if (mode === "real") {
    return [process.env.RZP_WEBHOOK_SECRET, process.env.RZP_WEBHOOK_SECRET_PREVIOUS].filter(Boolean) as string[];
  }
  return [process.env.RZP_WEBHOOK_SECRET || "recorded-mode-dev-secret"];
}

/** A real test-mode client for one merchant's own keys (onboarded tenants); refuses live keys like the env path does. */
export function createRazorpayClientWithKeys(keyId: string, keySecret: string): RazorpayClient {
  if (!keyId.startsWith("rzp_test_")) throw new Error("Only rzp_test_ keys are accepted; this project never runs against live Razorpay keys.");
  return createRealRazorpayClient(keyId, keySecret);
}
