import type { Db } from "@naka/db";
import { newId } from "@naka/shared";

export interface Agent {
  id: string;
  merchant_id: string;
  name: string;
  pubkey: string;
  status: "active" | "suspended";
  created_at: string;
}

export function registerAgent(db: Db, args: { merchantId: string; name: string; pubkeyPem: string; id?: string }): Agent {
  const id = args.id ?? newId("agent");
  db.prepare(
    `INSERT INTO agents (id, merchant_id, name, pubkey, status) VALUES (?, ?, ?, ?, 'active')`
  ).run(id, args.merchantId, args.name, args.pubkeyPem);
  return getAgent(db, id)!;
}

export function getAgent(db: Db, id: string): Agent | undefined {
  return db.prepare("SELECT * FROM agents WHERE id = ?").get(id) as Agent | undefined;
}

export function setAgentStatus(db: Db, id: string, status: "active" | "suspended"): void {
  db.prepare("UPDATE agents SET status = ? WHERE id = ?").run(status, id);
}

export function listAgents(db: Db): Agent[] {
  return db.prepare("SELECT * FROM agents ORDER BY created_at").all() as Agent[];
}
