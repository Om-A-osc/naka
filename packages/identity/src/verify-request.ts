import type { Db } from "@naka/db";
import { canonicalJson } from "@naka/shared";
import { hashBody, signingMessage, verifyMessage } from "./ed25519.js";
import { checkAndRecordNonce, isWithinReplayWindow } from "./replay-cache.js";
import { getAgent, type Agent } from "./registry.js";

export interface SignedHeaders {
  "x-naka-agent": string;
  "x-naka-ts": string;
  "x-naka-nonce": string;
  "x-naka-sig": string;
}

export interface RuleHit {
  rule_id: string;
  passed: boolean;
  left: string | number;
  right: string | number;
}

export type VerifyOutcome =
  | { ok: true; agent: Agent; hit: RuleHit }
  | { ok: false; agent: Agent | undefined; hit: RuleHit };

/** Rule A1_SIGNATURE: request must be signed by a registered agent's private key, within a 5-minute window, and not a replay of a previously-used nonce. */
export function verifyAgentRequest(db: Db, headers: Partial<SignedHeaders>, body: unknown, tool: string): VerifyOutcome {
  const agentId = headers["x-naka-agent"];
  const tsRaw = headers["x-naka-ts"];
  const nonce = headers["x-naka-nonce"];
  const sig = headers["x-naka-sig"];
  const fail = (reason: string, agent?: Agent) =>
    ({ ok: false as const, agent, hit: { rule_id: "A1_SIGNATURE", passed: false, left: reason, right: "valid" } });

  if (!agentId || !tsRaw || !nonce || !sig) return fail("missing_headers");
  const ts = Number(tsRaw);
  if (!isWithinReplayWindow(ts)) return fail("ts_out_of_window", getAgent(db, agentId));

  const agent = getAgent(db, agentId);
  if (!agent) return fail("unknown_agent");

  const bodyHash = hashBody(canonicalJson(body));
  const message = signingMessage({ subject: `${agentId}:${tool}`, ts, nonce, bodyHash });
  if (!verifyMessage(message, sig, agent.pubkey)) return fail("bad_signature", agent);

  if (!checkAndRecordNonce(db, agentId, ts, nonce)) return fail("replay", agent);

  return { ok: true, agent, hit: { rule_id: "A1_SIGNATURE", passed: true, left: "valid", right: "valid" } };
}
