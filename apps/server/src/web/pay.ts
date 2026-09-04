import type { FastifyInstance } from "fastify";
import type { Db } from "@naka/db";
import type { Tenants } from "../tenants.js";
import { RecordedRazorpayClient, verifyCheckoutSignature } from "@naka/razorpay";
import { getCheckout, onPaymentAuthorized, onPaymentCaptured, onPaymentFailed, merchantDisplayName } from "@naka/engine";
import { confirmAndPay, retryPayment, sendPaymentLink, ExecutorError } from "@naka/executor";
import { formatInr } from "@naka/shared";
import { insertLedgerRow } from "@naka/ledger";
import { env } from "../config/env.js";
import { BASE_CSS } from "./ui.js";
import { FAVICON_LINK, logoMark } from "./logo.js";

function layout(title: string, body: string, brand = "Naka"): string {
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">${FAVICON_LINK}<title>${title}</title>
<style>${BASE_CSS}
body{margin:0;font-family:system-ui,-apple-system,"Segoe UI",Roboto,sans-serif;color:var(--ink);background:var(--bg)}
.top{display:flex;justify-content:space-between;align-items:center;padding:12px 20px;background:#fff;border-bottom:1px solid var(--line)}
.top .b{font-weight:800;display:inline-flex;align-items:center;gap:8px}.top .b .nk-mark{width:22px;height:22px;border-radius:6px}
.top small{color:var(--muted);font-size:.85em}
.page{max-width:620px;margin:28px auto;padding:0 16px;animation:nk-fade-up .45s}
h2{margin:0 0 6px;letter-spacing:-.01em}
.card{background:#fff;border:1px solid var(--line);border-radius:14px;padding:20px;margin:16px 0;box-shadow:var(--shadow)}
.row{display:flex;justify-content:space-between;padding:6px 0;font-size:.98em}
.total{font-weight:700;font-size:1.25em;border-top:1px solid var(--line);margin-top:8px;padding-top:10px}
button{background:var(--accent);color:#fff;border:none;padding:12px 20px;border-radius:9px;cursor:pointer;font-size:1em;font-weight:600;margin:4px 8px 4px 0;box-shadow:0 10px 24px -12px rgba(43,108,176,.8);transition:transform .15s,box-shadow .2s}
button:hover{transform:translateY(-1px)}button.fail{background:var(--bad);box-shadow:none}button.ghost{background:#fff;color:var(--accent);border:1px solid var(--accent);box-shadow:none}
.muted{color:var(--muted);font-size:.9em}.small{font-size:.8em}
.pill{display:inline-block;background:#eef2f7;border-radius:999px;padding:2px 10px;font-size:.8em;font-family:ui-monospace,monospace}
.note{display:flex;gap:10px;align-items:flex-start;background:#eef4ff;border:1px solid #d6e2f5;border-radius:10px;padding:10px 12px;font-size:.88em;color:#2c4a75;margin:12px 0}

@keyframes draw{to{stroke-dashoffset:0}}@keyframes pop{0%{transform:scale(.6);opacity:0}60%{transform:scale(1.08);opacity:1}100%{transform:scale(1)}}
.mark{width:72px;height:72px;border-radius:50%;display:flex;align-items:center;justify-content:center;margin:6px 0 12px;animation:pop .5s cubic-bezier(.2,.7,.2,1)}
.mark.ok{background:#e6f4ea}.mark.bad{background:#fde8e8}.mark.wait{background:#eef4ff}
.mark svg{width:40px;height:40px;fill:none;stroke-width:3;stroke-linecap:round;stroke-linejoin:round;stroke-dasharray:60;stroke-dashoffset:60;animation:draw .6s .25s ease-out forwards}
.mark.ok svg{stroke:#2f855a}.mark.bad svg{stroke:#c53030}
.spinner.big{width:30px;height:30px;border-width:3px;margin:0}
@media(prefers-reduced-motion:reduce){.mark,.mark svg{animation:none;stroke-dashoffset:0}}
</style></head><body>
<div class="top"><span class="b">${logoMark(22)}${brand}</span><small>Secure checkout · Razorpay test mode</small></div>
<div class="page">${body}</div>
</body></html>`;
}

export function registerPayRoutes(app: FastifyInstance, db: Db, tenants: Tenants) {
  const defaultRzp = tenants.rzpFor(tenants.defaultMerchantId);
  app.get("/pay/:id", async (req, reply) => {
    const { id } = req.params as { id: string };
    const t = (req.query as any).t as string | undefined;
    const view = getCheckout(db, id);
    if (!view) return reply.code(404).send(layout("Not found", `<p>No such checkout.</p>`));
    const owner = db.prepare("SELECT merchant_id FROM checkouts WHERE id = ?").get(id) as { merchant_id: string } | undefined;
    const merchantId = owner?.merchant_id ?? env.merchantId;
    const merchantName = merchantDisplayName(db, merchantId);
    const rzp = tenants.rzpFor(merchantId);
    const keyId = tenants.keyIdFor(merchantId);

    const lines = view.line_items
      .map((l) => `<div class="row"><span>${l.title} × ${l.quantity}</span><span>${formatInr(l.line_total_paise as any)}</span></div>`)
      .join("");

    const body = `
      <h2>Confirm your payment</h2>
      <p class="muted">Your assistant proposed this cart at <b>${merchantName}</b>. Nothing is charged until you confirm below.</p>
      <div class="card">
        <p class="muted small">Agent <span class="pill">${view.agent_id}</span> · Mandate <span class="pill">${view.mandate_id}</span></p>
        ${lines}
        ${view.totals.discount_paise ? `<div class="row"><span>Discount</span><span>-${formatInr(view.totals.discount_paise as any)}</span></div>` : ""}
        <div class="row total"><span>Total</span><span>${formatInr(view.totals.total_paise as any)}</span></div>
      </div>
      <div id="action"></div>
      <p class="muted">Checkout: ${view.checkout_id}</p>
      <script>
        const checkoutId = ${JSON.stringify(id)};
        const nonce = ${JSON.stringify(t ?? "")};
        const recorded = ${JSON.stringify(rzp.mode === "recorded")};
        const actionEl = document.getElementById('action');

        function renderConfirm() {
          actionEl.innerHTML = '<button id="confirmBtn">Confirm &amp; Pay</button> <button id="linkBtn">Send Payment Link instead</button>';
          document.getElementById('confirmBtn').onclick = async () => {
            actionEl.innerHTML = '<p class="muted"><span class="spinner"></span>Confirming…</p>';
            const res = await fetch('/api/checkouts/' + checkoutId + '/confirm', { method: 'POST', headers: {'Content-Type':'application/json'}, body: JSON.stringify({ nonce }) });
            const data = await res.json();
            if (!res.ok) { actionEl.innerHTML = '<p style="color:#c53030">' + (data.error?.message || data.error?.code || 'Error') + '</p>'; return; }
            renderPaymentStep(data);
          };
          document.getElementById('linkBtn').onclick = async () => {
            actionEl.innerHTML = '<p class="muted"><span class="spinner"></span>Creating a payment link…</p>';
            const res = await fetch('/api/checkouts/' + checkoutId + '/send-payment-link', { method: 'POST', headers: {'Content-Type':'application/json'}, body: JSON.stringify({ nonce }) });
            const data = await res.json();
            if (!res.ok) { actionEl.innerHTML = '<p style="color:#c53030">' + (data.error?.message || data.error?.code || 'Error') + '</p>'; return; }
            renderPaymentLinkStep(data);
          };
        }

        function renderPaymentLinkStep(link) {
          let html = '<p>Payment link: <a href="' + link.shortUrl + '" target="_blank">' + link.shortUrl + '</a></p>';
          if (recorded) {
            html += '<p class="muted">Recorded mode, simulate the human paying via the link:</p>' +
              '<button id="linkOkBtn">Simulate paid</button> <button id="linkFailBtn" class="fail">Simulate failed</button>';
          } else {
            html += '<p class="muted">Waiting for the human to pay via the link…</p>';
          }
          actionEl.innerHTML = html;
          if (recorded) {
            document.getElementById('linkOkBtn').onclick = () => simulateLink(link.plinkId, 'captured');
            document.getElementById('linkFailBtn').onclick = () => simulateLink(link.plinkId, 'failed');
          } else {
            poll();
          }
        }

        async function simulateLink(plinkId, result) {
          actionEl.innerHTML = '<p class="muted"><span class="spinner"></span>Processing…</p>';
          await fetch('/api/links/' + plinkId + '/simulate', { method: 'POST', headers: {'Content-Type':'application/json'}, body: JSON.stringify({ result }) });
          poll();
        }

        function renderPaymentStep(attempt) {
          if (recorded) {
            actionEl.innerHTML =
              '<p class="muted">Recorded mode, no real Razorpay Checkout runs here. Simulate the human paying:</p>' +
              '<button id="okBtn">Simulate success@razorpay</button> ' +
              '<button id="failBtn" class="fail">Simulate failure@razorpay</button>';
            document.getElementById('okBtn').onclick = () => simulate(attempt.razorpayOrderId, 'captured');
            document.getElementById('failBtn').onclick = () => simulate(attempt.razorpayOrderId, 'failed');
          } else {
            actionEl.innerHTML = '<p class="muted"><span class="spinner"></span>Opening Razorpay Checkout…</p>';
            const rz = new Razorpay({
              key: ${JSON.stringify(keyId)},
              order_id: attempt.razorpayOrderId,
              amount: attempt.amountPaise,
              currency: attempt.currency,
              name: ${JSON.stringify(merchantName)},
              retry: { enabled: false },
              ...(attempt.razorpayCustomerId ? { customer_id: attempt.razorpayCustomerId } : {}),
              handler: async function (resp) {
                // Hand the signed result straight back so the server can
                // verify it and settle immediately, instead of the result
                // page waiting on the 30s reconciler. Best-effort: if this
                // POST fails the payment still stands and the reconciler
                // picks it up, so never block the redirect on it.
                try {
                  await fetch('/api/attempts/' + resp.razorpay_order_id + '/checkout-result', {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify(resp),
                  });
                } catch (e) {}
                window.location = '/pay/' + checkoutId + '/result';
              },
              modal: { ondismiss: function () { renderRetry(); } },
            });
            rz.open();
          }
        }

        async function simulate(orderId, result) {
          actionEl.innerHTML = '<p class="muted"><span class="spinner"></span>Processing…</p>';
          await fetch('/api/attempts/' + orderId + '/simulate', { method: 'POST', headers: {'Content-Type':'application/json'}, body: JSON.stringify({ result }) });
          poll();
        }

        function renderRetry() {
          actionEl.innerHTML = '<button id="retryBtn">Retry payment</button>';
          document.getElementById('retryBtn').onclick = async () => {
            actionEl.innerHTML = '<p class="muted"><span class="spinner"></span>Starting a new attempt…</p>';
            const res = await fetch('/api/checkouts/' + checkoutId + '/retry', { method: 'POST' });
            const data = await res.json();
            if (!res.ok) { actionEl.innerHTML = '<p style="color:#c53030">' + (data.error?.message || data.error?.code) + '</p>'; return; }
            renderPaymentStep(data);
          };
        }

        async function poll() {
          const res = await fetch('/api/checkouts/' + checkoutId + '/pay-status');
          const data = await res.json();
          if (data.status === 'completed') {
            actionEl.innerHTML = '<h3>Payment confirmed. Thank you!</h3>';
            return;
          }
          if (data.last_payment && data.last_payment.status === 'failed') {
            actionEl.innerHTML = '<p style="color:#c53030">Payment failed. An order was created, it is not paid, and nothing was charged.</p>';
            if (data.last_payment.retries_remaining > 0) renderRetry();
            else actionEl.innerHTML += '<p>No retries left, this has been flagged for the merchant.</p>';
            return;
          }
          actionEl.innerHTML = '<p class="muted">Waiting for payment confirmation…</p>';
          setTimeout(poll, 2000);
        }

        if (nonce) renderConfirm();
        else actionEl.innerHTML = '<p style="color:#c53030">Missing confirmation token.</p>';
      </script>
      ${rzp.mode === "recorded" ? "" : '<script src="https://checkout.razorpay.com/v1/checkout.js"></script>'}
    `;
    return reply.type("text/html").send(layout("Confirm payment", body, merchantName));
  });

  app.post("/api/checkouts/:id/confirm", async (req, reply) => {
    const { id } = req.params as { id: string };
    const { nonce } = req.body as { nonce: string };
    try {
      const rzp = tenants.rzpForCheckout(id);
      const result = await confirmAndPay(db, rzp, { checkoutId: id, nonce });
      return { ...result, keyId: tenants.keyIdFor(tenants.merchantOfCheckout(id)) || "rzp_test_recorded", mode: rzp.mode };
    } catch (err) {
      return reply.code(err instanceof ExecutorError ? 409 : 500).send({ error: { code: err instanceof ExecutorError ? err.code : "INTERNAL", message: (err as Error).message } });
    }
  });

  app.post("/api/checkouts/:id/retry", async (req, reply) => {
    const { id } = req.params as { id: string };
    try {
      const rzp = tenants.rzpForCheckout(id);
      const result = await retryPayment(db, rzp, { checkoutId: id });
      return { ...result, keyId: tenants.keyIdFor(tenants.merchantOfCheckout(id)) || "rzp_test_recorded", mode: rzp.mode };
    } catch (err) {
      return reply.code(err instanceof ExecutorError ? 409 : 500).send({ error: { code: err instanceof ExecutorError ? err.code : "INTERNAL", message: (err as Error).message } });
    }
  });

  // Fallback for a channel without a browser handoff.
  app.post("/api/checkouts/:id/send-payment-link", async (req, reply) => {
    const { id } = req.params as { id: string };
    const { nonce } = req.body as { nonce: string };
    try {
      const merchantId = tenants.merchantOfCheckout(id);
      const result = await sendPaymentLink(db, tenants.rzpFor(merchantId), { checkoutId: id, nonce, merchantId });
      return result;
    } catch (err) {
      return reply.code(err instanceof ExecutorError ? 409 : 500).send({ error: { code: err instanceof ExecutorError ? err.code : "INTERNAL", message: (err as Error).message } });
    }
  });

  /** The Checkout.js result endpoint. */
  app.post("/api/attempts/:razorpayOrderId/checkout-result", async (req, reply) => {
    const { razorpayOrderId } = req.params as { razorpayOrderId: string };
    const body = (req.body ?? {}) as { razorpay_payment_id?: string; razorpay_order_id?: string; razorpay_signature?: string };

    if (!body.razorpay_payment_id || !body.razorpay_order_id || !body.razorpay_signature) {
      return reply.code(400).send({ error: { code: "INVALID_ARGUMENT", message: "razorpay_order_id, razorpay_payment_id and razorpay_signature are required" } });
    }
    if (body.razorpay_order_id !== razorpayOrderId) {
      return reply.code(400).send({ error: { code: "ORDER_MISMATCH", message: "Signed order_id does not match the attempt in the path" } });
    }

    const attempt = db.prepare("SELECT id, checkout_id FROM payment_attempts WHERE razorpay_order_id = ?").get(razorpayOrderId) as
      | { id: string; checkout_id: string }
      | undefined;
    if (!attempt) return reply.code(404).send({ error: { code: "NOT_FOUND" } });
    const merchantId = tenants.merchantOfCheckout(attempt.checkout_id);
    const keySecret = tenants.keySecretFor(merchantId);
    const rzp = tenants.rzpFor(merchantId);
    if (!keySecret) return reply.code(400).send({ error: { code: "NOT_REAL_MODE", message: "No API secret configured; recorded mode uses /simulate." } });

    const ok = verifyCheckoutSignature(
      { razorpay_order_id: body.razorpay_order_id, razorpay_payment_id: body.razorpay_payment_id, razorpay_signature: body.razorpay_signature },
      keySecret
    );
    if (!ok) {
      insertLedgerRow(db, {
        actor: "buyer",
        action: "CHECKOUT_RESULT_REJECTED",
        checkout_id: attempt.checkout_id,
        attempt_id: attempt.id,
        razorpay_order_id: razorpayOrderId,
        inputs: { reason: "bad_signature", payment_id: body.razorpay_payment_id },
      });
      return reply.code(401).send({ error: { code: "BAD_SIGNATURE" } });
    }

    try {
      const payment = await rzp.payments.fetch(body.razorpay_payment_id);
      if (payment.status === "captured") onPaymentCaptured(db, payment, "api_fetch");
      else if (payment.status === "authorized") onPaymentAuthorized(db, payment, "api_fetch");
      else if (payment.status === "failed") onPaymentFailed(db, payment, "api_fetch");
      insertLedgerRow(db, {
        actor: "buyer",
        action: "CHECKOUT_RESULT_VERIFIED",
        checkout_id: attempt.checkout_id,
        attempt_id: attempt.id,
        razorpay_order_id: razorpayOrderId,
        razorpay_payment_id: payment.id,
        inputs: { status: payment.status },
      });
      return { ok: true, status: payment.status };
    } catch (err) {
      // The signature was good, so the payment is real even if we could not read it back right now; the reconciler will still settle it.
      insertLedgerRow(db, {
        actor: "buyer",
        action: "CHECKOUT_RESULT_FETCH_FAILED",
        checkout_id: attempt.checkout_id,
        attempt_id: attempt.id,
        razorpay_order_id: razorpayOrderId,
        inputs: { error: String(err) },
      });
      return { ok: true, status: "pending_reconcile" };
    }
  });

  app.post("/api/attempts/:razorpayOrderId/simulate", async (req, reply) => {
    const rzp = defaultRzp;
    if (!(rzp instanceof RecordedRazorpayClient)) return reply.code(400).send({ error: { code: "NOT_RECORDED_MODE" } });
    const { razorpayOrderId } = req.params as { razorpayOrderId: string };
    const { result, errorReason } = req.body as { result: "captured" | "failed"; errorReason?: string };
    const payment = await rzp.simulatePayment(razorpayOrderId, {
      result,
      method: "upi",
      errorCode: result === "failed" ? "BAD_REQUEST_ERROR" : undefined,
      errorReason: result === "failed" ? errorReason ?? "payment_failed" : undefined,
      errorSource: result === "failed" ? "customer" : undefined,
      errorStep: result === "failed" ? "payment_authentication" : undefined,
    });
    return { payment_id: payment.id, status: payment.status };
  });

  app.post("/api/links/:plinkId/simulate", async (req, reply) => {
    const rzp = defaultRzp;
    if (!(rzp instanceof RecordedRazorpayClient)) return reply.code(400).send({ error: { code: "NOT_RECORDED_MODE" } });
    const { plinkId } = req.params as { plinkId: string };
    const { result } = req.body as { result: "captured" | "failed" };
    const payment = await rzp.simulateLinkPayment(plinkId, result);
    return { payment_id: payment.id, status: payment.status };
  });

  /** Where Checkout.js sends the human after a successful payment. */
  app.get("/pay/:id/result", async (req, reply) => {
    const { id } = req.params as { id: string };
    const view = getCheckout(db, id);
    if (!view) return reply.code(404).send(layout("Not found", `<p>No such checkout.</p>`));

    const attempt = db.prepare("SELECT * FROM payment_attempts WHERE checkout_id = ? ORDER BY attempt_no DESC LIMIT 1").get(id) as any;
    const merchantName = merchantDisplayName(db, tenants.merchantOfCheckout(id));
    const paid = view.status === "completed" || attempt?.status === "captured";
    const failed = attempt?.status === "failed";

    const heading = paid
      ? `<div class="mark ok"><svg viewBox="0 0 24 24"><path d="M5 13l4 4L19 7"/></svg></div><h2>Payment received</h2><p>Thank you, your order is confirmed and the shop has been notified.</p>`
      : failed
        ? `<div class="mark bad"><svg viewBox="0 0 24 24"><path d="M6 6l12 12M18 6L6 18"/></svg></div><h2>Payment did not go through</h2><p class="muted">${attempt?.failure_category ? `Reason: ${attempt.failure_category}.` : ""} You can start a new attempt from the payment page.</p>`
        : `<div class="mark wait"><span class="spinner big"></span></div><h2>Confirming your payment…</h2><p class="muted">We are verifying this directly with Razorpay. This page updates itself.</p>`;

    const body = `
      ${heading}
      <div class="card">
        <div class="row"><span>Order</span><span class="pill">${view.checkout_id}</span></div>
        <div class="row total"><span>Total</span><span>${formatInr(view.totals.total_paise as any)}</span></div>
        <p class="muted">Status: <b id="st">${view.status}</b></p>
      </div>
      ${paid || failed ? "" : `<script>
        setInterval(async () => {
          const r = await fetch('/api/checkouts/${id}/pay-status');
          const d = await r.json();
          document.getElementById('st').textContent = d.status;
          if (d.status === 'completed' || d.last_payment?.status === 'captured' || d.last_payment?.status === 'failed') location.reload();
        }, 3000);
      </script>`}
    `;
    return reply.type("text/html").send(layout(paid ? "Payment received" : "Payment status", body));
  });

  app.get("/api/checkouts/:id/pay-status", async (req, reply) => {
    const { id } = req.params as { id: string };
    const view = getCheckout(db, id);
    if (!view) return reply.code(404).send({ error: { code: "NOT_FOUND" } });
    const attempt = db.prepare("SELECT * FROM payment_attempts WHERE checkout_id = ? ORDER BY attempt_no DESC LIMIT 1").get(id) as any;
    return {
      status: view.status,
      totals: view.totals,
      last_payment: attempt ? { status: attempt.status, retries_remaining: Math.max(0, 3 - attempt.attempt_no) } : null,
    };
  });
}
