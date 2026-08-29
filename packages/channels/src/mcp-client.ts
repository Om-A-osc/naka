import { readFileSync } from "node:fs";
import { randomBytes } from "node:crypto";
import { canonicalJson, sha256hex } from "@naka/shared";
import { signMessage, signingMessage } from "@naka/identity";

export interface ToolError {
  error: { code: string; message?: string; rule_hit?: unknown };
}

function isToolError(x: unknown): x is ToolError {
  return typeof x === "object" && x !== null && "error" in x;
}

/** The one client both the replay buyer and the live Claude buyer use to reach Naka's eight tools. */
export class NakaClient {
  private privateKeyPem: string;

  constructor(
    private baseUrl: string,
    public agentId: string,
    privateKeyPathOrPem: string,
    /** Which merchant unsigned reads are for; signed calls are bound to the agent's merchant server-side regardless. */
    private merchantId?: string
  ) {
    this.privateKeyPem = privateKeyPathOrPem.includes("BEGIN PRIVATE KEY") ? privateKeyPathOrPem : readFileSync(privateKeyPathOrPem, "utf8");
  }

  private async call(tool: string, body: unknown, signed: boolean): Promise<any> {
    const headers: Record<string, string> = { "Content-Type": "application/json" };
    if (this.merchantId) headers["x-naka-merchant"] = this.merchantId;
    if (signed) {
      const ts = Math.floor(Date.now() / 1000);
      const nonce = randomBytes(16).toString("base64url");
      const bodyHash = sha256hex(canonicalJson(body ?? {}));
      const message = signingMessage({ subject: `${this.agentId}:${tool}`, ts, nonce, bodyHash });
      const sig = signMessage(message, this.privateKeyPem);
      headers["x-naka-agent"] = this.agentId;
      headers["x-naka-ts"] = String(ts);
      headers["x-naka-nonce"] = nonce;
      headers["x-naka-sig"] = sig;
    }
    const res = await fetch(`${this.baseUrl}/tools/${tool}`, { method: "POST", headers, body: JSON.stringify(body ?? {}) });
    const json = await res.json();
    if (!res.ok && !isToolError(json)) return { error: { code: `HTTP_${res.status}` } };
    return json;
  }

  searchCatalog(args: { query: string; category?: string; max_price_paise?: number; in_stock_only?: boolean; limit?: number }) {
    return this.call("search_catalog", args, false);
  }
  getProduct(args: { product_id: string }) {
    return this.call("get_product", args, false);
  }
  createCheckout(args: { mandate_id: string; line_items: Array<{ variant_id: string; quantity: number }>; coupon_code?: string; buyer_ref?: string }) {
    return this.call("create_checkout", args, true);
  }
  getCheckout(args: { checkout_id: string }) {
    return this.call("get_checkout", args, true);
  }
  updateCheckout(args: { checkout_id: string; line_items: Array<{ variant_id: string; quantity: number }>; coupon_code?: string }) {
    return this.call("update_checkout", args, true);
  }
  suggestAddons(args: { checkout_id: string }) {
    return this.call("suggest_addons", args, true);
  }
  completeCheckout(args: { checkout_id: string; line_items_hash: string }) {
    return this.call("complete_checkout", args, true);
  }
  cancelCheckout(args: { checkout_id: string; reason: string }) {
    return this.call("cancel_checkout", args, true);
  }
}

export { isToolError };
