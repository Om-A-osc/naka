import type { Db } from "@naka/db";

const REPLAY_WINDOW_SECONDS = 300;

/** Records a pair the first time it is seen; returns false if that exact nonce has been used before by this agent. */
export function checkAndRecordNonce(db: Db, agentId: string, ts: number, nonce: string): boolean {
  const now = Math.floor(Date.now() / 1000);
  db.prepare("DELETE FROM agent_nonces WHERE ts < ?").run(now - REPLAY_WINDOW_SECONDS * 2);
  try {
    db.prepare("INSERT INTO agent_nonces (agent_id, nonce, ts) VALUES (?, ?, ?)").run(agentId, nonce, ts);
    return true; // first time seen
  } catch {
    return false; // primary key collision => replay
  }
}

export function isWithinReplayWindow(ts: number, now = Math.floor(Date.now() / 1000)): boolean {
  return Number.isFinite(ts) && Math.abs(now - ts) <= REPLAY_WINDOW_SECONDS;
}

export { REPLAY_WINDOW_SECONDS };
