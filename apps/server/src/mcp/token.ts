import { createHash, randomBytes } from "node:crypto";
import type { Db } from "@naka/db";

/** Bearer tokens for the remote MCP endpoint. */
export function newAgentToken(): string {
  return `nk_${randomBytes(24).toString("base64url")}`;
}

export function hashToken(token: string): string {
  return createHash("sha256").update(token).digest("hex");
}

/** Mint a fresh token for an agent (replacing any earlier one) and return it once. */
export function issueAgentToken(db: Db, agentId: string): string {
  const token = newAgentToken();
  db.prepare("UPDATE agents SET token_hash = ? WHERE id = ?").run(hashToken(token), agentId);
  return token;
}
