import type { Db } from "@naka/db";
import { createRazorpayClientWithKeys, type RazorpayClient } from "@naka/razorpay";
import { merchantCredentials } from "@naka/engine";

interface Defaults {
  merchantId: string;
  rzp: RazorpayClient;
  secrets: string[];
  keyId: string;
  keySecret: string;
}

/** Resolves the Razorpay client, webhook secret and API keys to use for one merchant. */
export class Tenants {
  private clients = new Map<string, RazorpayClient>();

  constructor(
    private db: Db,
    private defaults: Defaults
  ) {}

  get defaultMerchantId(): string {
    return this.defaults.merchantId;
  }

  rzpFor(merchantId: string): RazorpayClient {
    if (merchantId === this.defaults.merchantId) return this.defaults.rzp;
    const c = merchantCredentials(this.db, merchantId);
    if (!c?.razorpay_key_id || !c.razorpay_key_secret) return this.defaults.rzp;
    const cacheKey = `${merchantId}:${c.razorpay_key_id}`;
    let client = this.clients.get(cacheKey);
    if (!client) {
      client = createRazorpayClientWithKeys(c.razorpay_key_id, c.razorpay_key_secret);
      this.clients.set(cacheKey, client);
    }
    return client;
  }

  /** The client for whichever merchant owns this checkout. */
  rzpForCheckout(checkoutId: string): RazorpayClient {
    return this.rzpFor(this.merchantOfCheckout(checkoutId));
  }

  merchantOfCheckout(checkoutId: string): string {
    const row = this.db.prepare("SELECT merchant_id FROM checkouts WHERE id = ?").get(checkoutId) as { merchant_id: string } | undefined;
    return row?.merchant_id ?? this.defaults.merchantId;
  }

  secretsFor(merchantId: string): string[] {
    if (merchantId === this.defaults.merchantId) return this.defaults.secrets;
    const c = merchantCredentials(this.db, merchantId);
    return c?.webhook_secret ? [c.webhook_secret] : this.defaults.secrets;
  }

  keyIdFor(merchantId: string): string {
    if (merchantId === this.defaults.merchantId) return this.defaults.keyId;
    return merchantCredentials(this.db, merchantId)?.razorpay_key_id ?? this.defaults.keyId;
  }

  keySecretFor(merchantId: string): string {
    if (merchantId === this.defaults.merchantId) return this.defaults.keySecret;
    return merchantCredentials(this.db, merchantId)?.razorpay_key_secret ?? this.defaults.keySecret;
  }
}
