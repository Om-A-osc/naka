export type FailureCategory = "RETRY_NEW_ORDER" | "RETRY_AFTER_DELAY" | "HANDOFF";

/** Deterministic classification of a failed payment into what the buyer should be told and what the agent may suggest next, never a model judgment call. */
export function classifyFailure(errorSource: string | null | undefined, _errorStep: string | null | undefined, errorReason: string | null | undefined): FailureCategory {
  const source = (errorSource ?? "").toLowerCase();
  const reason = (errorReason ?? "").toLowerCase();

  if (source === "customer") return "RETRY_NEW_ORDER";
  if (source === "gateway" || source === "bank" || source === "issuer_bank" || source === "network") return "RETRY_AFTER_DELAY";
  if (reason.includes("server_error") || reason.includes("timeout")) return "RETRY_AFTER_DELAY";
  return "HANDOFF";
}

export function nextActionMessage(category: FailureCategory, retriesRemaining: number): string {
  switch (category) {
    case "RETRY_NEW_ORDER":
      return retriesRemaining > 0
        ? "That payment didn't go through. An order was created, it is not paid, and nothing was charged. Want to try again, maybe with a different payment method?"
        : "That payment didn't go through and we're out of retries for this order. Nothing was charged. I can hand this off to the merchant if you'd like.";
    case "RETRY_AFTER_DELAY":
      return "The payment gateway timed out. An order was created, it is not paid yet, and nothing was charged. Give it a moment and we'll check again before retrying.";
    case "HANDOFF":
      return "Something went wrong on the payment side that a retry won't fix. An order was created, it is not paid, and nothing was charged. I'll flag this for the merchant.";
  }
}
