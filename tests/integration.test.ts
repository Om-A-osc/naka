import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { existsSync, unlinkSync } from "node:fs";

/** A real end-to-end test: boots the actual Fastify server, seeds the actual demo catalog/agents. */
const DB_PATH = "./data/test-integration.db";
const PORT = 34117;

let close: () => Promise<void>;
let db: import("better-sqlite3").Database;
let baseUrl: string;
let seed: any;

beforeAll(async () => {
  for (const suffix of ["", "-wal", "-shm"]) if (existsSync(DB_PATH + suffix)) unlinkSync(DB_PATH + suffix);
  process.env.NAKA_DB = DB_PATH;
  process.env.NAKA_PORT = String(PORT);
  process.env.RAZORPAY_MODE = "recorded";
  process.env.CONSOLE_PASSWORD = "test-password";
  process.env.NAKA_BASE_URL = `http://127.0.0.1:${PORT}`;

  const { getDb } = await import("@naka/db");
  const { seedAll } = await import("../cli/seed.js");
  const { buildServer } = await import("@naka/server");

  db = getDb();
  seed = seedAll(db);
  const built = await buildServer();
  await built.app.listen({ port: PORT, host: "127.0.0.1" });
  close = built.close;
  baseUrl = `http://127.0.0.1:${PORT}`;
});

afterAll(async () => {
  await close();
});

function nonceFromUrl(url: string) {
  return new URL(url).searchParams.get("t")!;
}

async function signedCall(agentId: string, privateKeyPath: string, tool: string, body: unknown) {
  const { NakaClient } = await import("../apps/buyer/src/mcp-client.js");
  const client = new NakaClient(baseUrl, agentId, privateKeyPath);
  return (client as any)[tool](body);
}

describe("Naka end-to-end (recorded mode, no keys)", () => {
  it("completes a full happy-path purchase and reaches the ledger", async () => {
    const buyerId = seed.agents["buyer-claude"].id;
    const keyPath = seed.agents["buyer-claude"].privateKeyPath;

    const checkout = await signedCall(buyerId, keyPath, "createCheckout", {
      mandate_id: seed.mandates.buyer_claude,
      line_items: [{ variant_id: "var_fc8020_250", quantity: 1 }],
      buyer_ref: "test_buyer",
    });
    expect(checkout.decision.outcome).toBe("ALLOW");

    const completed = await signedCall(buyerId, keyPath, "completeCheckout", {
      checkout_id: checkout.checkout_id,
      line_items_hash: checkout.line_items_hash,
    });
    expect(completed.continue_url).toBeTruthy();

    const nonce = nonceFromUrl(completed.continue_url);
    const confirmRes = await fetch(`${baseUrl}/api/checkouts/${checkout.checkout_id}/confirm`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ nonce }),
    });
    const attempt = (await confirmRes.json()) as { razorpayOrderId: string };
    expect(confirmRes.ok).toBe(true);

    await fetch(`${baseUrl}/api/attempts/${attempt.razorpayOrderId}/simulate`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ result: "captured" }),
    });

    const final = await signedCall(buyerId, keyPath, "getCheckout", { checkout_id: checkout.checkout_id });
    expect(final.status).toBe("completed");

    const { verifyLedger } = await import("@naka/ledger");
    const v = verifyLedger(db);
    expect(v.ok).toBe(true);
  });

  it("denies a cart over the mandate's per-checkout cap", async () => {
    const rogueId = seed.agents["rogue-bot"].id;
    const keyPath = seed.agents["rogue-bot"].privateKeyPath;
    const checkout = await signedCall(rogueId, keyPath, "createCheckout", {
      mandate_id: seed.mandates.rogue_bot,
      line_items: [{ variant_id: "var_fc8020_500", quantity: 1 }],
      buyer_ref: "test_rogue",
    });
    expect(checkout.decision.outcome).toBe("DENY");
    expect(checkout.decision.rule_hits.find((h: any) => h.rule_id === "B3_MANDATE_AMOUNT").passed).toBe(false);
  });
});
