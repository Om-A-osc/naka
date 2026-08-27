-- Naka database schema. Money columns are INTEGER paise. Status ranks make "monotonic state" a CHECK-able invariant instead of a convention.

PRAGMA foreign_keys = ON;

CREATE TABLE IF NOT EXISTS merchants (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  display_name TEXT NOT NULL,
  currency TEXT NOT NULL DEFAULT 'INR',
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);

CREATE TABLE IF NOT EXISTS agents (
  id TEXT PRIMARY KEY,
  merchant_id TEXT NOT NULL REFERENCES merchants(id),
  name TEXT NOT NULL,
  pubkey TEXT NOT NULL,        -- base64 SPKI DER (Ed25519)
  status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active','suspended')),
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);
CREATE INDEX IF NOT EXISTS idx_agents_status ON agents(status);

-- `nonce` is a random, client-generated value included in the signed message.
CREATE TABLE IF NOT EXISTS agent_nonces (
  agent_id TEXT NOT NULL,
  nonce TEXT NOT NULL,
  ts INTEGER NOT NULL,
  PRIMARY KEY (agent_id, nonce)
);
CREATE INDEX IF NOT EXISTS idx_agent_nonces_ts ON agent_nonces(ts);

CREATE TABLE IF NOT EXISTS mandates (
  id TEXT PRIMARY KEY,
  merchant_id TEXT NOT NULL REFERENCES merchants(id),
  agent_id TEXT NOT NULL REFERENCES agents(id),
  agent_pubkey TEXT NOT NULL,
  buyer_pubkey TEXT NOT NULL,
  buyer_ref TEXT NOT NULL,
  max_per_checkout_paise INTEGER NOT NULL,
  max_total_paise INTEGER NOT NULL,
  allowed_categories TEXT NOT NULL,   -- JSON array
  expires_at INTEGER NOT NULL,        -- unix seconds
  signature TEXT NOT NULL,            -- base64 Ed25519 signature by buyer_pubkey
  status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active','revoked','expired')),
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);
CREATE INDEX IF NOT EXISTS idx_mandates_agent_status ON mandates(agent_id, status);

CREATE TABLE IF NOT EXISTS products (
  id TEXT PRIMARY KEY,
  merchant_id TEXT NOT NULL REFERENCES merchants(id),
  title TEXT NOT NULL,
  description TEXT NOT NULL DEFAULT '',
  category TEXT NOT NULL,
  attributes TEXT NOT NULL DEFAULT '{}', -- JSON
  active INTEGER NOT NULL DEFAULT 1,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);

CREATE TABLE IF NOT EXISTS variants (
  id TEXT PRIMARY KEY,
  product_id TEXT NOT NULL REFERENCES products(id),
  title TEXT NOT NULL,
  sku TEXT NOT NULL,
  price_paise INTEGER NOT NULL CHECK (price_paise >= 0),
  stock_qty INTEGER NOT NULL DEFAULT 0 CHECK (stock_qty >= 0),
  reserved_qty INTEGER NOT NULL DEFAULT 0 CHECK (reserved_qty >= 0 AND reserved_qty <= stock_qty),
  attributes TEXT NOT NULL DEFAULT '{}',
  active INTEGER NOT NULL DEFAULT 1
);
CREATE INDEX IF NOT EXISTS idx_variants_product ON variants(product_id);

CREATE TABLE IF NOT EXISTS variant_aliases (
  variant_id TEXT NOT NULL REFERENCES variants(id),
  alias TEXT NOT NULL,
  lang TEXT NOT NULL DEFAULT 'en' CHECK (lang IN ('en','hi-Latn')),
  PRIMARY KEY (variant_id, alias)
);
CREATE INDEX IF NOT EXISTS idx_variant_aliases_alias ON variant_aliases(alias);

-- FTS5 external-content table over variants (title/description come from a join view refreshed on import).
CREATE VIRTUAL TABLE IF NOT EXISTS catalog_fts USING fts5(
  variant_id UNINDEXED,
  title,
  description,
  aliases,
  category
);

CREATE TABLE IF NOT EXISTS frequently_bought_with (
  variant_id TEXT NOT NULL REFERENCES variants(id),
  addon_variant_id TEXT NOT NULL REFERENCES variants(id),
  weight REAL NOT NULL DEFAULT 1.0,
  PRIMARY KEY (variant_id, addon_variant_id)
);

CREATE TABLE IF NOT EXISTS coupons (
  code TEXT PRIMARY KEY,
  merchant_id TEXT NOT NULL REFERENCES merchants(id),
  pct INTEGER NOT NULL CHECK (pct BETWEEN 0 AND 100),
  max_paise INTEGER NOT NULL,
  min_order_paise INTEGER NOT NULL DEFAULT 0,
  active INTEGER NOT NULL DEFAULT 1
);

-- Secondary-scope: Customers API integration.
CREATE TABLE IF NOT EXISTS buyers (
  buyer_ref TEXT PRIMARY KEY,
  razorpay_customer_id TEXT,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);

CREATE TABLE IF NOT EXISTS reservations (
  id TEXT PRIMARY KEY,
  checkout_id TEXT NOT NULL,
  variant_id TEXT NOT NULL REFERENCES variants(id),
  qty INTEGER NOT NULL CHECK (qty > 0),
  expires_at INTEGER NOT NULL,  -- unix seconds
  status TEXT NOT NULL DEFAULT 'held' CHECK (status IN ('held','released','consumed')),
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  UNIQUE (checkout_id, variant_id)
);
CREATE INDEX IF NOT EXISTS idx_reservations_status_exp ON reservations(status, expires_at);

-- status_rank: 0 incomplete, 1 requires_escalation, 2 ready_for_complete, 3 complete_in_progress, 4 completed, -1 canceled.
CREATE TABLE IF NOT EXISTS checkouts (
  id TEXT PRIMARY KEY,
  merchant_id TEXT NOT NULL REFERENCES merchants(id),
  agent_id TEXT NOT NULL REFERENCES agents(id),
  mandate_id TEXT NOT NULL REFERENCES mandates(id),
  buyer_ref TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'incomplete',
  status_rank INTEGER NOT NULL DEFAULT 0,
  subtotal_paise INTEGER NOT NULL DEFAULT 0,
  discount_paise INTEGER NOT NULL DEFAULT 0,
  total_paise INTEGER NOT NULL DEFAULT 0,
  coupon_code TEXT,
  line_items_hash TEXT NOT NULL DEFAULT '',
  nonce_hash TEXT,
  nonce_expires_at INTEGER,
  attempts INTEGER NOT NULL DEFAULT 0,
  cancel_reason TEXT,
  policy_version INTEGER NOT NULL DEFAULT 1,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  completed_at TEXT
);
CREATE INDEX IF NOT EXISTS idx_checkouts_agent_created ON checkouts(agent_id, created_at);

-- Amount immutability: once a checkout has entered complete_in_progress or beyond, total_paise/discount_paise/subtotal_paise can never change again.
CREATE TRIGGER IF NOT EXISTS trg_checkout_amount_immutable
BEFORE UPDATE OF total_paise, subtotal_paise, discount_paise ON checkouts
WHEN OLD.status_rank >= 3 AND (NEW.total_paise != OLD.total_paise OR NEW.subtotal_paise != OLD.subtotal_paise OR NEW.discount_paise != OLD.discount_paise)
BEGIN
  SELECT RAISE(ABORT, 'checkout amount is immutable after complete_in_progress');
END;

-- Monotonic status: rank may only increase, except the explicit move to canceled, which is allowed from any non-terminal rank.
CREATE TRIGGER IF NOT EXISTS trg_checkout_status_monotonic
BEFORE UPDATE OF status_rank ON checkouts
WHEN NEW.status_rank < OLD.status_rank AND NEW.status_rank != -1 AND OLD.status_rank != -1
BEGIN
  SELECT RAISE(ABORT, 'checkout status_rank cannot decrease');
END;

CREATE TABLE IF NOT EXISTS checkout_lines (
  id TEXT PRIMARY KEY,
  checkout_id TEXT NOT NULL REFERENCES checkouts(id),
  variant_id TEXT NOT NULL REFERENCES variants(id),
  title TEXT NOT NULL,
  quantity INTEGER NOT NULL CHECK (quantity > 0),
  unit_price_paise INTEGER NOT NULL,
  line_total_paise INTEGER NOT NULL,
  is_addon INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX IF NOT EXISTS idx_checkout_lines_checkout ON checkout_lines(checkout_id);

CREATE TABLE IF NOT EXISTS addon_offers (
  id TEXT PRIMARY KEY,
  checkout_id TEXT NOT NULL REFERENCES checkouts(id),
  variant_id TEXT NOT NULL REFERENCES variants(id),
  score REAL NOT NULL,
  reason TEXT NOT NULL,
  outcome TEXT NOT NULL DEFAULT 'offered' CHECK (outcome IN ('offered','accepted','rejected')),
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);
CREATE INDEX IF NOT EXISTS idx_addon_offers_checkout ON addon_offers(checkout_id);

CREATE TABLE IF NOT EXISTS decisions (
  id TEXT PRIMARY KEY,
  checkout_id TEXT NOT NULL REFERENCES checkouts(id),
  action TEXT NOT NULL CHECK (action IN ('create','update','complete','refund')),
  outcome TEXT NOT NULL CHECK (outcome IN ('ALLOW','DENY','NEEDS_HUMAN')),
  rule_hits TEXT NOT NULL,     -- JSON array
  explanation TEXT NOT NULL,
  policy_version INTEGER NOT NULL,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);
CREATE INDEX IF NOT EXISTS idx_decisions_checkout ON decisions(checkout_id);

CREATE TABLE IF NOT EXISTS approvals (
  id TEXT PRIMARY KEY,
  checkout_id TEXT,
  refund_id TEXT,
  kind TEXT NOT NULL CHECK (kind IN ('escalation','refund')),
  token_hash TEXT NOT NULL,
  expires_at INTEGER NOT NULL,
  decided_by TEXT,
  decision TEXT CHECK (decision IN ('approved','denied')),
  decided_at TEXT,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);

-- status_rank: 0 created, 1 opened, 2 failed, 3 authorized, 4 captured.
CREATE TABLE IF NOT EXISTS payment_attempts (
  id TEXT PRIMARY KEY,
  checkout_id TEXT NOT NULL REFERENCES checkouts(id),
  attempt_no INTEGER NOT NULL,
  kind TEXT NOT NULL DEFAULT 'checkout' CHECK (kind IN ('checkout','link')),
  status TEXT NOT NULL DEFAULT 'created',
  status_rank INTEGER NOT NULL DEFAULT 0,
  receipt TEXT NOT NULL UNIQUE,
  razorpay_order_id TEXT UNIQUE,
  plink_id TEXT UNIQUE,
  reference_id TEXT UNIQUE,
  amount_paise INTEGER NOT NULL,
  currency TEXT NOT NULL DEFAULT 'INR',
  expires_at INTEGER NOT NULL,
  opened_at TEXT,
  closed_at TEXT,
  last_reconciled_at TEXT,
  failure_category TEXT,
  UNIQUE (checkout_id, attempt_no)
);
CREATE INDEX IF NOT EXISTS idx_payment_attempts_checkout ON payment_attempts(checkout_id);
-- Only one open attempt (not failed/expired/abandoned/canceled) per checkout at a time.
CREATE UNIQUE INDEX IF NOT EXISTS idx_payment_attempts_one_open
  ON payment_attempts(checkout_id)
  WHERE status IN ('created','opened','authorized');

CREATE TABLE IF NOT EXISTS rzp_orders (
  razorpay_order_id TEXT PRIMARY KEY,
  attempt_id TEXT NOT NULL REFERENCES payment_attempts(id),
  status TEXT NOT NULL,
  amount INTEGER NOT NULL,
  amount_paid INTEGER NOT NULL DEFAULT 0,
  amount_due INTEGER NOT NULL DEFAULT 0,
  attempts INTEGER NOT NULL DEFAULT 0,
  receipt TEXT NOT NULL,
  notes TEXT NOT NULL DEFAULT '{}',
  created_at_rzp INTEGER,
  last_snapshot TEXT,
  snapshot_at TEXT
);

CREATE TABLE IF NOT EXISTS rzp_payments (
  razorpay_payment_id TEXT PRIMARY KEY,
  razorpay_order_id TEXT NOT NULL,
  attempt_id TEXT NOT NULL REFERENCES payment_attempts(id),
  checkout_id TEXT NOT NULL REFERENCES checkouts(id),
  status TEXT NOT NULL,
  status_rank INTEGER NOT NULL DEFAULT 0,
  captured INTEGER NOT NULL DEFAULT 0,
  amount INTEGER NOT NULL,
  currency TEXT NOT NULL DEFAULT 'INR',
  method TEXT,
  role TEXT NOT NULL DEFAULT 'primary' CHECK (role IN ('primary','surplus')),
  fee INTEGER,
  tax INTEGER,
  error_code TEXT,
  error_description TEXT,
  error_source TEXT,
  error_step TEXT,
  error_reason TEXT,
  acquirer_rrn TEXT,
  vpa_hash TEXT,
  email_hash TEXT,
  contact_hash TEXT,
  amount_refunded INTEGER NOT NULL DEFAULT 0,
  refund_status TEXT,
  created_at_rzp INTEGER,
  last_snapshot TEXT,
  source TEXT NOT NULL DEFAULT 'webhook' CHECK (source IN ('webhook','reconcile','api_fetch'))
);
CREATE INDEX IF NOT EXISTS idx_rzp_payments_checkout ON rzp_payments(checkout_id);
-- At most one PRIMARY captured payment per checkout.
CREATE UNIQUE INDEX IF NOT EXISTS idx_rzp_payments_one_primary_captured
  ON rzp_payments(checkout_id)
  WHERE role = 'primary' AND status = 'captured';

-- Secondary-scope: Payment Link fallback for channels without a browser handoff.
CREATE TABLE IF NOT EXISTS payment_links (
  plink_id TEXT PRIMARY KEY,
  attempt_id TEXT NOT NULL REFERENCES payment_attempts(id),
  reference_id TEXT NOT NULL UNIQUE,
  short_url TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'created' CHECK (status IN ('created','partially_paid','paid','expired','cancelled')),
  amount INTEGER NOT NULL,
  amount_paid INTEGER NOT NULL DEFAULT 0,
  razorpay_order_id TEXT,
  expire_by INTEGER,
  expired_at INTEGER,
  cancelled_at INTEGER,
  last_snapshot TEXT,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);
CREATE INDEX IF NOT EXISTS idx_payment_links_attempt ON payment_links(attempt_id);

CREATE TABLE IF NOT EXISTS link_budget (
  merchant_id TEXT PRIMARY KEY,
  total INTEGER NOT NULL DEFAULT 30,
  reserve INTEGER NOT NULL DEFAULT 10,
  used INTEGER NOT NULL DEFAULT 0
);

CREATE TABLE IF NOT EXISTS refunds (
  id TEXT PRIMARY KEY,
  checkout_id TEXT NOT NULL REFERENCES checkouts(id),
  razorpay_payment_id TEXT NOT NULL,
  razorpay_refund_id TEXT UNIQUE,
  amount_paise INTEGER,           -- null = full refund
  reason TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'requested' CHECK (status IN ('requested','approved','submitted','pending','processed','failed','denied')),
  approval_id TEXT,
  idempotency_key TEXT NOT NULL UNIQUE,
  receipt TEXT NOT NULL UNIQUE,
  speed_requested TEXT,
  speed_processed TEXT,
  requested_by TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  processed_at TEXT,
  last_snapshot TEXT
);
-- At most one refund per payment in the MVP.
CREATE UNIQUE INDEX IF NOT EXISTS idx_refunds_one_per_payment ON refunds(razorpay_payment_id);

CREATE TABLE IF NOT EXISTS webhook_events (
  event_id TEXT PRIMARY KEY,
  event TEXT NOT NULL,
  account_id TEXT,
  payload TEXT NOT NULL,
  signature_verified INTEGER NOT NULL DEFAULT 0,
  received_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  processed_at TEXT,
  status TEXT NOT NULL DEFAULT 'received' CHECK (status IN ('received','processing','processed','orphan','error')),
  error TEXT,
  attempt_id TEXT,
  checkout_id TEXT
);

CREATE TABLE IF NOT EXISTS jobs (
  id TEXT PRIMARY KEY,
  type TEXT NOT NULL,
  payload TEXT NOT NULL DEFAULT '{}',
  run_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  attempts INTEGER NOT NULL DEFAULT 0,
  max_attempts INTEGER NOT NULL DEFAULT 8,
  claimed_at TEXT,
  done_at TEXT,
  last_error TEXT,
  singleton_key TEXT UNIQUE
);
CREATE INDEX IF NOT EXISTS idx_jobs_pending ON jobs(run_at) WHERE done_at IS NULL;

-- Backs the secondary-scope UCP-shaped REST wrapper's Idempotency-Key header: same key + same body replays the stored response.
CREATE TABLE IF NOT EXISTS idempotency_keys (
  key TEXT PRIMARY KEY,
  scope TEXT NOT NULL,
  request_hash TEXT NOT NULL,
  status INTEGER NOT NULL,
  response TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);

CREATE TABLE IF NOT EXISTS fault_flags (
  name TEXT PRIMARY KEY,
  value TEXT,
  expires_at INTEGER
);

CREATE TABLE IF NOT EXISTS ledger (
  seq INTEGER PRIMARY KEY AUTOINCREMENT,
  ts TEXT NOT NULL,
  actor TEXT NOT NULL CHECK (actor IN ('agent','engine','gate','executor','webhook','reconciler','merchant','buyer','system')),
  agent_id TEXT,
  action TEXT NOT NULL,
  decision TEXT,
  rule_hits TEXT,
  inputs TEXT,
  checkout_id TEXT,
  attempt_id TEXT,
  razorpay_order_id TEXT,
  razorpay_payment_id TEXT,
  razorpay_refund_id TEXT,
  event_id TEXT,
  amount_paise INTEGER,
  prev_hash TEXT NOT NULL,
  hash TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_ledger_checkout ON ledger(checkout_id);
CREATE INDEX IF NOT EXISTS idx_ledger_order ON ledger(razorpay_order_id);
CREATE INDEX IF NOT EXISTS idx_ledger_event ON ledger(event_id);

-- The ledger is append-only: no application code, admin, or bug may edit history.
CREATE TRIGGER IF NOT EXISTS trg_ledger_no_update
BEFORE UPDATE ON ledger
BEGIN
  SELECT RAISE(ABORT, 'ledger rows are append-only: UPDATE is not permitted');
END;
CREATE TRIGGER IF NOT EXISTS trg_ledger_no_delete
BEFORE DELETE ON ledger
BEGIN
  SELECT RAISE(ABORT, 'ledger rows are append-only: DELETE is not permitted');
END;
