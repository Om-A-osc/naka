import { randomBytes } from "node:crypto";
import type { Db } from "@naka/db";
import { decide, type Decision, type GateCtx } from "@naka/gate";
import { insertLedgerRow } from "@naka/ledger";
import { newId, canonicalJson, sha256hex } from "@naka/shared";
import { priceLines, type PricedLine } from "./pricing.js";
import { applyCoupon } from "./coupons.js";
import { reserveStock, releaseReservations, reservationExpired } from "./reservations.js";
import { buildMandateAgentCtx } from "./mandate-ctx.js";
import { currentPolicy } from "./policy.js";
import { policyFor } from "./tenant.js";

export type CheckoutStatus =
  | "incomplete" | "requires_escalation" | "ready_for_complete" | "complete_in_progress" | "completed" | "canceled";

const STATUS_RANK: Record<CheckoutStatus, number> = {
  incomplete: 0,
  requires_escalation: 1,
  ready_for_complete: 2,
  complete_in_progress: 3,
  completed: 4,
  canceled: -1,
};

export interface CheckoutView {
  checkout_id: string;
  status: CheckoutStatus;
  agent_id: string;
  mandate_id: string;
  line_items: PricedLine[];
  totals: { subtotal_paise: number; discount_paise: number; total_paise: number };
  coupon_code: string | null;
  line_items_hash: string;
  reservation_expires_at: number | null;
  attempts: number;
  continue_url: string | null;
}

export class CheckoutError extends Error {
  constructor(public code: string, message?: string) {
    super(message ?? code);
  }
}

function computeLinesHash(lines: PricedLine[]): string {
  return sha256hex(canonicalJson(lines.map((l) => ({ variant_id: l.variant_id, quantity: l.quantity, unit_price_paise: l.unit_price_paise }))));
}

function rowToView(row: any, lines: PricedLine[]): CheckoutView {
  return {
    checkout_id: row.id,
    status: row.status,
    agent_id: row.agent_id,
    mandate_id: row.mandate_id,
    line_items: lines,
    totals: { subtotal_paise: row.subtotal_paise, discount_paise: row.discount_paise, total_paise: row.total_paise },
    coupon_code: row.coupon_code,
    line_items_hash: row.line_items_hash,
    reservation_expires_at: null,
    attempts: row.attempts,
    // nonce_hash actually stores the raw, unguessable, single-use nonce token.
    continue_url:
      row.status === "complete_in_progress" && row.nonce_hash
        ? `${process.env.NAKA_BASE_URL ?? "http://localhost:3000"}/pay/${row.id}?t=${row.nonce_hash}`
        : null,
  };
}

function readLines(db: Db, checkoutId: string): PricedLine[] {
  const rows = db.prepare("SELECT * FROM checkout_lines WHERE checkout_id = ?").all(checkoutId) as any[];
  return rows.map((r) => ({
    variant_id: r.variant_id,
    title: r.title,
    category: "", // not needed on read; category only matters at decide() time
    quantity: r.quantity,
    unit_price_paise: r.unit_price_paise,
    line_total_paise: r.line_total_paise,
    is_addon: !!r.is_addon,
  }));
}

interface ProposeArgs {
  checkoutId: string; // caller decides: new ulid for create, existing id for update
  merchantId: string;
  agentId: string;
  mandateId: string;
  buyerRef: string;
  lines: Array<{ variant_id: string; quantity: number; is_addon?: boolean }>;
  couponCode?: string;
  isNew: boolean;
}

function propose(db: Db, args: ProposeArgs): { view: CheckoutView; decision: Decision } {
  const { policy, version: policyVersion } = policyFor(db, args.merchantId);
  const { lines, subtotal_paise } = priceLines(db, args.lines, args.merchantId);
  const coupon = applyCoupon(db, subtotal_paise, args.couponCode);
  const discount = coupon?.valid ? coupon.discount_paise : 0;
  const total = subtotal_paise - discount;

  const mandateAgent = buildMandateAgentCtx(db, args.mandateId);
  if (mandateAgent.error) {
    const decision: Decision = {
      outcome: "DENY",
      rule_hits: [{ rule_id: "B4_MANDATE_EXPIRY", passed: false, left: mandateAgent.error, right: "valid_mandate" }],
      explanation: "Your mandate could not be verified.",
    };
    return persist(db, args, lines, subtotal_paise, discount, total, coupon, decision, policyVersion, { ok: true, insufficient_variant_ids: [] });
  }

  const stock = reserveStock(
    db,
    args.checkoutId,
    lines.filter((l) => l.quantity > 0),
    policy.reservation_ttl_seconds
  );

  const ctx: GateCtx = {
    now: Math.floor(Date.now() / 1000),
    checkout: { total_paise: total, lines: lines.map((l) => ({ variant_id: l.variant_id, category: l.category, qty: l.quantity })) },
    mandate: mandateAgent.mandate,
    agent: mandateAgent.agent,
    policy: {
      max_per_checkout_paise: policy.max_per_checkout_paise,
      merchant_approval_over_paise: policy.merchant_approval_over_paise,
      per_agent_daily_cap_paise: policy.per_agent_daily_cap_paise,
      max_qty_per_line: policy.max_qty_per_line,
      kill_switch: policy.kill_switch,
    },
    stock,
    coupon: coupon ? { code: coupon.code, valid: coupon.valid, reason: coupon.reason } : undefined,
  };

  const decision = decide(ctx);
  if (decision.outcome === "DENY" && stock.ok) {
    // don't hold stock for a cart that is being denied for an unrelated reason
    releaseReservations(db, args.checkoutId);
  }

  return persist(db, args, lines, subtotal_paise, discount, total, coupon, decision, policyVersion, stock);
}

function persist(
  db: Db,
  args: ProposeArgs,
  lines: PricedLine[],
  subtotal: number,
  discount: number,
  total: number,
  coupon: ReturnType<typeof applyCoupon>,
  decision: Decision,
  policyVersion: number,
  stock: { ok: boolean; insufficient_variant_ids: string[] }
): { view: CheckoutView; decision: Decision } {
  return db.transaction(() => {
    const linesHash = computeLinesHash(lines);
    const status: CheckoutStatus =
      decision.outcome === "DENY" ? "canceled" : decision.outcome === "NEEDS_HUMAN" ? "requires_escalation" : "ready_for_complete";

    if (args.isNew) {
      db.prepare(
        `INSERT INTO checkouts (id, merchant_id, agent_id, mandate_id, buyer_ref, status, status_rank,
                                 subtotal_paise, discount_paise, total_paise, coupon_code, line_items_hash, policy_version)
         VALUES (@id,@merchant_id,@agent_id,@mandate_id,@buyer_ref,@status,@status_rank,
                 @subtotal_paise,@discount_paise,@total_paise,@coupon_code,@line_items_hash,@policy_version)`
      ).run({
        id: args.checkoutId,
        merchant_id: args.merchantId,
        agent_id: args.agentId,
        mandate_id: args.mandateId,
        buyer_ref: args.buyerRef,
        status,
        status_rank: STATUS_RANK[status],
        subtotal_paise: subtotal,
        discount_paise: discount,
        total_paise: total,
        coupon_code: coupon?.valid ? coupon.code : null,
        line_items_hash: linesHash,
        policy_version: policyVersion,
      });
    } else {
      const existing = db.prepare("SELECT status_rank FROM checkouts WHERE id = ?").get(args.checkoutId) as
        | { status_rank: number }
        | undefined;
      if (!existing) throw new CheckoutError("NOT_FOUND");
      if (existing.status_rank >= STATUS_RANK.complete_in_progress) throw new CheckoutError("STATE_CONFLICT", "checkout already completing");

      db.prepare(
        `UPDATE checkouts SET status=@status, status_rank=@status_rank, subtotal_paise=@subtotal_paise,
                discount_paise=@discount_paise, total_paise=@total_paise, coupon_code=@coupon_code,
                line_items_hash=@line_items_hash, policy_version=@policy_version, updated_at=strftime('%Y-%m-%dT%H:%M:%fZ','now')
         WHERE id=@id`
      ).run({
        id: args.checkoutId,
        status,
        status_rank: STATUS_RANK[status],
        subtotal_paise: subtotal,
        discount_paise: discount,
        total_paise: total,
        coupon_code: coupon?.valid ? coupon.code : null,
        line_items_hash: linesHash,
        policy_version: policyVersion,
      });
      db.prepare("DELETE FROM checkout_lines WHERE checkout_id = ?").run(args.checkoutId);
    }

    for (const l of lines) {
      db.prepare(
        `INSERT INTO checkout_lines (id, checkout_id, variant_id, title, quantity, unit_price_paise, line_total_paise, is_addon)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
      ).run(newId("cl"), args.checkoutId, l.variant_id, l.title, l.quantity, l.unit_price_paise, l.line_total_paise, l.is_addon ? 1 : 0);
    }

    const decisionId = newId("dec");
    db.prepare(
      `INSERT INTO decisions (id, checkout_id, action, outcome, rule_hits, explanation, policy_version)
       VALUES (?, ?, ?, ?, ?, ?, ?)`
    ).run(decisionId, args.checkoutId, args.isNew ? "create" : "update", decision.outcome, JSON.stringify(decision.rule_hits), decision.explanation, policyVersion);

    insertLedgerRow(db, {
      actor: "gate",
      agent_id: args.agentId,
      action: args.isNew ? "CHECKOUT_CREATED" : "CHECKOUT_UPDATED",
      decision: decision.outcome,
      rule_hits: decision.rule_hits,
      inputs: { lines: args.lines, coupon_code: args.couponCode ?? null },
      checkout_id: args.checkoutId,
      amount_paise: total,
    });

    const row = db.prepare("SELECT * FROM checkouts WHERE id = ?").get(args.checkoutId);
    return { view: rowToView(row, lines), decision };
  })();
}

export function createCheckout(db: Db, args: Omit<ProposeArgs, "checkoutId" | "isNew">): { view: CheckoutView; decision: Decision } {
  return propose(db, { ...args, checkoutId: newId("chk"), isNew: true });
}

export function updateCheckout(
  db: Db,
  args: Omit<ProposeArgs, "isNew" | "merchantId" | "mandateId" | "buyerRef"> & { checkoutId: string }
): { view: CheckoutView; decision: Decision } {
  const existing = db.prepare("SELECT * FROM checkouts WHERE id = ?").get(args.checkoutId) as any;
  if (!existing) throw new CheckoutError("NOT_FOUND");
  return propose(db, {
    checkoutId: args.checkoutId,
    merchantId: existing.merchant_id,
    agentId: args.agentId,
    mandateId: existing.mandate_id,
    buyerRef: existing.buyer_ref,
    lines: args.lines,
    couponCode: args.couponCode,
    isNew: false,
  });
}

export function getCheckout(db: Db, checkoutId: string): CheckoutView | undefined {
  const row = db.prepare("SELECT * FROM checkouts WHERE id = ?").get(checkoutId) as any;
  if (!row) return undefined;
  return rowToView(row, readLines(db, checkoutId));
}

export function cancelCheckout(db: Db, args: { checkoutId: string; reason: string }): CheckoutView {
  return db.transaction(() => {
    const row = db.prepare("SELECT * FROM checkouts WHERE id = ?").get(args.checkoutId) as any;
    if (!row) throw new CheckoutError("NOT_FOUND");
    if (row.status_rank >= STATUS_RANK.completed) throw new CheckoutError("STATE_CONFLICT", "already completed");
    releaseReservations(db, args.checkoutId);
    db.prepare("UPDATE checkouts SET status='canceled', status_rank=-1, cancel_reason=? WHERE id=?").run(args.reason, args.checkoutId);
    insertLedgerRow(db, { actor: "engine", action: "CHECKOUT_CANCELED", checkout_id: args.checkoutId, inputs: { reason: args.reason } });
    return getCheckout(db, args.checkoutId)!;
  })();
}

/** Rule G1_HUMAN_CONFIRM starts here: transition ready_for_complete -> complete_in_progress, mint a one-time nonce, and return continue_url. */
export function completeCheckout(db: Db, args: { checkoutId: string; agentId: string; lineItemsHash: string }): {
  view: CheckoutView;
  nonce: string | null; // raw nonce, only ever returned here, never stored in plaintext
  decision: Decision;
} {
  return db.transaction(() => {
    const row = db.prepare("SELECT * FROM checkouts WHERE id = ?").get(args.checkoutId) as any;
    if (!row) throw new CheckoutError("NOT_FOUND");
    if (row.agent_id !== args.agentId) throw new CheckoutError("FORBIDDEN");
    if (row.line_items_hash !== args.lineItemsHash) throw new CheckoutError("STALE_HASH", "price or cart changed since proposal");

    if (row.status_rank === STATUS_RANK.complete_in_progress) {
      // I1: idempotent replay, already minted, don't mint again
      return { view: rowToView(row, readLines(db, args.checkoutId)), nonce: null, decision: lastDecision(db, args.checkoutId) };
    }
    if (row.status_rank === STATUS_RANK.completed) {
      return { view: rowToView(row, readLines(db, args.checkoutId)), nonce: null, decision: lastDecision(db, args.checkoutId) };
    }

    if (row.status === "requires_escalation") {
      const approval = db
        .prepare(
          `SELECT * FROM approvals WHERE checkout_id = ? AND kind='escalation' AND decision='approved' AND expires_at > ? ORDER BY decided_at DESC LIMIT 1`
        )
        .get(args.checkoutId, Math.floor(Date.now() / 1000)) as any;
      if (!approval) throw new CheckoutError("NEEDS_APPROVAL", "waiting on merchant approval");
    } else if (row.status !== "ready_for_complete") {
      throw new CheckoutError("STATE_CONFLICT", `cannot complete from status ${row.status}`);
    }

    if (reservationExpired(db, args.checkoutId)) throw new CheckoutError("RESERVATION_EXPIRED");

    const rawNonce = randomBytes(24).toString("base64url");
    const expiresAt = Math.floor(Date.now() / 1000) + 900; // 15 min to open the pay page and confirm

    db.prepare(
      `UPDATE checkouts SET status='complete_in_progress', status_rank=3, nonce_hash=?, nonce_expires_at=?,
              updated_at=strftime('%Y-%m-%dT%H:%M:%fZ','now') WHERE id=?`
    ).run(rawNonce, expiresAt, args.checkoutId);

    insertLedgerRow(db, { actor: "engine", agent_id: args.agentId, action: "CHECKOUT_COMPLETE_REQUESTED", checkout_id: args.checkoutId });

    const updated = db.prepare("SELECT * FROM checkouts WHERE id = ?").get(args.checkoutId);
    return { view: rowToView(updated, readLines(db, args.checkoutId)), nonce: rawNonce, decision: lastDecision(db, args.checkoutId) };
  })();
}

/** Rule G1_HUMAN_CONFIRM completes here: the pay page posts back the nonce from its own URL. */
export function confirmNonce(db: Db, args: { checkoutId: string; nonce: string }): { ok: boolean; reason?: string } {
  return db.transaction(() => {
    const row = db.prepare("SELECT nonce_hash, nonce_expires_at, status FROM checkouts WHERE id = ?").get(args.checkoutId) as
      | { nonce_hash: string | null; nonce_expires_at: number | null; status: string }
      | undefined;
    if (!row) return { ok: false, reason: "NOT_FOUND" };
    if (row.status !== "complete_in_progress") return { ok: false, reason: "STATE_CONFLICT" };
    if (!row.nonce_hash) return { ok: false, reason: "NONCE_ALREADY_CONSUMED" };
    if (row.nonce_expires_at !== null && row.nonce_expires_at < Math.floor(Date.now() / 1000)) {
      return { ok: false, reason: "NONCE_EXPIRED" };
    }
    if (row.nonce_hash !== args.nonce) return { ok: false, reason: "NONCE_INVALID" };

    db.prepare("UPDATE checkouts SET nonce_hash = NULL WHERE id = ?").run(args.checkoutId);
    insertLedgerRow(db, { actor: "buyer", action: "HUMAN_CONFIRMED_PAYMENT", checkout_id: args.checkoutId });
    return { ok: true };
  })();
}

function lastDecision(db: Db, checkoutId: string): Decision {
  const d = db.prepare("SELECT * FROM decisions WHERE checkout_id = ? ORDER BY created_at DESC LIMIT 1").get(checkoutId) as any;
  return d
    ? { outcome: d.outcome, rule_hits: JSON.parse(d.rule_hits), explanation: d.explanation }
    : { outcome: "ALLOW", rule_hits: [], explanation: "" };
}

export { STATUS_RANK };
