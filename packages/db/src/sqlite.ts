import Database from "better-sqlite3";
import { readFileSync, mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));

let singleton: Database.Database | undefined;

export function openDb(path: string): Database.Database {
  const db = new Database(path);
  db.pragma("journal_mode = WAL");
  db.pragma("foreign_keys = ON");
  db.pragma("busy_timeout = 5000");
  return db;
}

export function migrate(db: Database.Database): void {
  const sql = readFileSync(join(__dirname, "schema.sql"), "utf8");
  db.exec(sql);
  ensureMerchantColumns(db);
  ensureAgentColumns(db);
}

/** schema.sql is CREATE ... IF NOT EXISTS throughout, which never alters a table that already exists. */
function ensureAgentColumns(db: Database.Database): void {
  const have = new Set((db.prepare("PRAGMA table_info(agents)").all() as Array<{ name: string }>).map((c) => c.name));
  // Hashed bearer token for the remote MCP endpoint; null for agents that only ever sign.
  if (!have.has("token_hash")) db.exec("ALTER TABLE agents ADD COLUMN token_hash TEXT");
  db.exec("CREATE INDEX IF NOT EXISTS idx_agents_token_hash ON agents(token_hash)");
}

function ensureMerchantColumns(db: Database.Database): void {
  const have = new Set((db.prepare("PRAGMA table_info(merchants)").all() as Array<{ name: string }>).map((c) => c.name));
  const wanted: Array<[string, string]> = [
    ["razorpay_key_id", "TEXT"],
    ["razorpay_key_secret", "TEXT"],
    ["webhook_secret", "TEXT"],
    ["console_password_hash", "TEXT"],
    ["policy_json", "TEXT"],
    ["telegram_bot_token", "TEXT"],
    ["telegram_bot_username", "TEXT"],
    ["telegram_agent_id", "TEXT"],
    ["telegram_agent_key", "TEXT"],
    ["telegram_mandate_id", "TEXT"],
    ["telegram_alert_chat_id", "TEXT"],
  ];
  for (const [name, type] of wanted) {
    if (!have.has(name)) db.exec(`ALTER TABLE merchants ADD COLUMN ${name} ${type}`);
  }
}

/** Where the SQLite file lives. */
export function resolveDbPath(): string {
  if (process.env.NAKA_DB) return process.env.NAKA_DB;
  if (process.env.RAILWAY_VOLUME_MOUNT_PATH) return join(process.env.RAILWAY_VOLUME_MOUNT_PATH, "naka.db");
  return "./data/naka.db";
}

/** Process-wide singleton, opened from resolveDbPath(). */
export function getDb(): Database.Database {
  if (!singleton) {
    const path = resolveDbPath();
    mkdirSync(dirname(path), { recursive: true }); // a fresh volume is an empty directory
    singleton = openDb(path);
    migrate(singleton);
  }
  return singleton;
}

export function closeDb(): void {
  singleton?.close();
  singleton = undefined;
}

export type Db = Database.Database;
