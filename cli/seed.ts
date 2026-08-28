import { mkdirSync, writeFileSync, readFileSync } from "node:fs";
import type { Db } from "@naka/db";
import { importCatalogFromFile, type CatalogFile } from "@naka/catalog";
import { generateEd25519KeyPair, registerAgent, setAgentStatus } from "@naka/identity";
import { issueMandate } from "@naka/mandate";
import { ensureLinkBudget } from "@naka/executor";

/** Where the generated agent keys and the seed manifest go. */
function seedPaths(): { dir: string; output: string } {
  const dbPath = (process.env.NAKA_DB ?? "./data/naka.db").replace(/\\/g, "/");
  // Only the checked-in default keeps the historical paths.
  if (dbPath === "./data/naka.db" || dbPath === "data/naka.db") return { dir: "data/agents", output: "data/seed-output.json" };
  const base = dbPath.replace(/\.db$/, "");
  return { dir: `${base}.agents`, output: `${base}.seed-output.json` };
}

export const SEED_DIR = seedPaths().dir;
export const SEED_OUTPUT = seedPaths().output;

export interface SeedOutput {
  agents: Record<string, { id: string; privateKeyPath: string; pubkey: string }>;
  mandates: { buyer_claude: string; replay_bot: string; rogue_bot: string; expired: string };
  merchant_id: string;
}

/** Sets up the whole demo merchant in one call: imports the catalog, registers four agents, issues one buyer key and four mandates against it. */
export function seedAll(db: Db, catalogPath = "data/catalog.json"): SeedOutput {
  importCatalogFromFile(db, catalogPath);
  // Everything merchant-specific below comes from the catalog file, so a different merchant is a different file, not a different seed script.
  const file = JSON.parse(readFileSync(catalogPath, "utf8")) as CatalogFile;
  const merchantId = file.merchant.id;
  const categories = [...new Set(file.products.map((p) => p.category))];
  ensureLinkBudget(db, merchantId); // 30 total / 10 held in reserve, per the documented test-mode cap
  // Resolved per call, not at import: a test sets NAKA_DB before importing this module, but a long-lived process can outlive that assumption.
  const { dir: seedDir, output: seedOutput } = seedPaths();
  mkdirSync(seedDir, { recursive: true });

  function makeAgent(name: string) {
    const { publicKeyPem, privateKeyPem } = generateEd25519KeyPair();
    const agent = registerAgent(db, { merchantId, name, pubkeyPem: publicKeyPem });
    const privateKeyPath = `${seedDir}/${name}.private.pem`;
    writeFileSync(privateKeyPath, privateKeyPem, "utf8");
    return { agent, privateKeyPem, publicKeyPem, privateKeyPath };
  }

  const agents = {
    "buyer-claude": makeAgent("buyer-claude"),
    "replay-bot": makeAgent("replay-bot"),
    "rogue-bot": makeAgent("rogue-bot"),
    "suspended-bot": makeAgent("suspended-bot"),
  };
  setAgentStatus(db, agents["suspended-bot"].agent.id, "suspended");

  const buyerKeys = generateEd25519KeyPair();
  const now = Math.floor(Date.now() / 1000);

  const mandateA = issueMandate(db, {
    merchant_id: merchantId,
    agent_id: agents["buyer-claude"].agent.id,
    agent_pubkey: agents["buyer-claude"].publicKeyPem,
    buyer_ref: "buyer_demo_1",
    max_per_checkout_paise: 300000,
    max_total_paise: 600000,
    allowed_categories: categories,
    expires_at: now + 30 * 24 * 3600,
    buyerPublicKeyPem: buyerKeys.publicKeyPem,
    buyerPrivateKeyPem: buyerKeys.privateKeyPem,
  });

  const mandateReplay = issueMandate(db, {
    merchant_id: merchantId,
    agent_id: agents["replay-bot"].agent.id,
    agent_pubkey: agents["replay-bot"].publicKeyPem,
    buyer_ref: "buyer_demo_replay",
    max_per_checkout_paise: 300000,
    max_total_paise: 600000,
    allowed_categories: categories,
    expires_at: now + 30 * 24 * 3600,
    buyerPublicKeyPem: buyerKeys.publicKeyPem,
    buyerPrivateKeyPem: buyerKeys.privateKeyPem,
  });

  const mandateB = issueMandate(db, {
    merchant_id: merchantId,
    agent_id: agents["rogue-bot"].agent.id,
    agent_pubkey: agents["rogue-bot"].publicKeyPem,
    buyer_ref: "buyer_demo_rogue",
    max_per_checkout_paise: 50000,
    max_total_paise: 50000,
    allowed_categories: categories.slice(0, 1),
    expires_at: now + 30 * 24 * 3600,
    buyerPublicKeyPem: buyerKeys.publicKeyPem,
    buyerPrivateKeyPem: buyerKeys.privateKeyPem,
  });

  const mandateExpired = issueMandate(db, {
    merchant_id: merchantId,
    agent_id: agents["buyer-claude"].agent.id,
    agent_pubkey: agents["buyer-claude"].publicKeyPem,
    buyer_ref: "buyer_demo_expired",
    max_per_checkout_paise: 300000,
    max_total_paise: 600000,
    allowed_categories: categories,
    expires_at: now - 3600,
    buyerPublicKeyPem: buyerKeys.publicKeyPem,
    buyerPrivateKeyPem: buyerKeys.privateKeyPem,
  });

  const output: SeedOutput = {
    agents: Object.fromEntries(
      Object.entries(agents).map(([name, a]) => [name, { id: a.agent.id, privateKeyPath: a.privateKeyPath, pubkey: a.publicKeyPem }])
    ) as SeedOutput["agents"],
    mandates: { buyer_claude: mandateA.id, replay_bot: mandateReplay.id, rogue_bot: mandateB.id, expired: mandateExpired.id },
    merchant_id: merchantId,
  };
  writeFileSync(seedOutput, JSON.stringify(output, null, 2), "utf8");
  return output;
}
