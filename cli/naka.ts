#!/usr/bin/env -S tsx
import { getDb } from "@naka/db";
import { importCatalogFromFile } from "@naka/catalog";
import { generateEd25519KeyPair, registerAgent, setAgentStatus, listAgents } from "@naka/identity";
import { verifyLedger, exportLedgerArray } from "@naka/ledger";
import { seedAll, SEED_DIR } from "./seed.js";
import { insertLedgerRow } from "@naka/ledger";
import { newId } from "@naka/shared";
import { defaultMerchantId } from "@naka/engine";
import { mkdirSync, writeFileSync } from "node:fs";

const db = getDb();
const [, cmd, ...rest] = process.argv;

async function main() {
  switch (cmd) {
    case "seed":
      console.log(seedAll(db));
      return;
    case "catalog:import":
      importCatalogFromFile(db, rest[0] ?? "data/catalog.json");
      console.log(`imported catalog from ${rest[0] ?? "data/catalog.json"}`);
      return;
    case "agent:register": {
      const name = rest[0];
      if (!name) throw new Error("usage: naka agent:register <name>");
      const { publicKeyPem, privateKeyPem } = generateEd25519KeyPair();
      const agent = registerAgent(db, { merchantId: defaultMerchantId(), name, pubkeyPem: publicKeyPem });
      mkdirSync(SEED_DIR, { recursive: true });
      const keyPath = `${SEED_DIR}/${name}.private.pem`;
      writeFileSync(keyPath, privateKeyPem, "utf8");
      console.log(`agent ${agent.id} (${name}) registered; private key at ${keyPath}`);
      return;
    }
    case "agent:list":
      console.log(listAgents(db));
      return;
    case "agent:suspend":
      setAgentStatus(db, rest[0], "suspended");
      console.log(`suspended ${rest[0]}`);
      return;
    case "agent:activate":
      setAgentStatus(db, rest[0], "active");
      console.log(`activated ${rest[0]}`);
      return;
    case "ledger:verify": {
      const result = verifyLedger(db);
      console.log(result);
      process.exitCode = result.ok ? 0 : 1;
      return;
    }
    case "ledger:export":
      console.log(JSON.stringify(exportLedgerArray(db), null, 2));
      return;

    // CLI parity for every console action.
    case "escalations:list": {
      const rows = db
        .prepare(
          `SELECT c.id, c.total_paise, c.status, c.created_at FROM checkouts c
           WHERE c.status = 'requires_escalation' ORDER BY c.created_at DESC`
        )
        .all();
      console.log(rows.length ? rows : "no checkouts awaiting approval");
      return;
    }
    case "escalation:approve": {
      const checkoutId = rest[0];
      if (!checkoutId) throw new Error("usage: naka escalation:approve <checkout_id>");
      const { policyForCheckout } = await import("@naka/engine");
      const { policy } = policyForCheckout(db, checkoutId);
      const approvalId = newId("appr");
      const expiresAt = Math.floor(Date.now() / 1000) + policy.escalation_approval_ttl_seconds;
      db.prepare(
        `INSERT INTO approvals (id, checkout_id, kind, token_hash, expires_at, decided_by, decision, decided_at)
         VALUES (?, ?, 'escalation', '', ?, 'merchant', 'approved', strftime('%Y-%m-%dT%H:%M:%fZ','now'))`
      ).run(approvalId, checkoutId, expiresAt);
      insertLedgerRow(db, { actor: "merchant", action: "ESCALATION_APPROVED", checkout_id: checkoutId });
      console.log({ approval_id: approvalId, expires_at: expiresAt });
      return;
    }
    case "escalation:deny": {
      const checkoutId = rest[0];
      if (!checkoutId) throw new Error("usage: naka escalation:deny <checkout_id> [reason]");
      const reason = rest[1] ?? "merchant_denied";
      const { cancelCheckout } = await import("@naka/engine");
      const view = cancelCheckout(db, { checkoutId, reason });
      insertLedgerRow(db, { actor: "merchant", action: "ESCALATION_DENIED", checkout_id: checkoutId, inputs: { reason } });
      console.log({ checkout_id: view.checkout_id, status: view.status });
      return;
    }
    case "refunds:list":
      console.log(db.prepare(`SELECT id, checkout_id, razorpay_payment_id, amount_paise, status, reason FROM refunds ORDER BY created_at DESC`).all());
      return;
    case "refund:approve": {
      const refundId = rest[0];
      if (!refundId) throw new Error("usage: naka refund:approve <refund_id>");
      const { approveRefund } = await import("@naka/engine");
      const { executeRefund } = await import("@naka/executor");
      const { createRazorpayClient } = await import("@naka/razorpay");
      const { approvalId, token } = approveRefund(db, refundId, "merchant");
      const result = await executeRefund(db, createRazorpayClient(), { refundId, token });
      console.log({ approval_id: approvalId, razorpay_refund_id: result.id, status: result.status });
      return;
    }
    case "refund:deny": {
      const refundId = rest[0];
      if (!refundId) throw new Error("usage: naka refund:deny <refund_id>");
      const { denyRefund } = await import("@naka/engine");
      denyRefund(db, refundId, "merchant");
      console.log(`denied ${refundId}`);
      return;
    }
    case "kill-switch": {
      const on = rest[0] === "on";
      if (rest[0] !== "on" && rest[0] !== "off") throw new Error("usage: naka kill-switch <on|off>");
      const { setMerchantPolicy } = await import("@naka/engine");
      const merchantId = defaultMerchantId();
      setMerchantPolicy(db, merchantId, { kill_switch: on });
      insertLedgerRow(db, { actor: "merchant", action: on ? "KILL_SWITCH_ON" : "KILL_SWITCH_OFF" });
      // Persisted on the merchant row, so a running server sharing this database honours it on its next checkout, no restart needed.
      console.log(`kill switch ${on ? "ON, all new checkouts for " + merchantId + " will be denied" : "OFF"}`);
      return;
    }
    default:
      console.log(`Usage: naka <command>
  seed                     import the demo catalog and set up agents + mandates
  catalog:import [path]    import a catalog.json (default data/catalog.json)
  agent:register <name>    register a new agent, print its id and private key path
  agent:list
  agent:suspend <id>
  agent:activate <id>
  ledger:verify
  ledger:export

Merchant decisions (same actions as the web console, for scripts and runbooks):
  escalations:list                     checkouts waiting on merchant approval (G2)
  escalation:approve <checkout_id>     approve one, so complete_checkout can proceed
  escalation:deny <checkout_id> [why]  deny and cancel it
  refunds:list
  refund:approve <refund_id>           approve AND execute against Razorpay (R3)
  refund:deny <refund_id>
  kill-switch <on|off>                 deny all new checkouts (persisted; takes effect immediately)`);
  }
}

main()
  .catch((err) => {
    console.error(err);
    process.exit(1);
  })
  .finally(() => db.close());
