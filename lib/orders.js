/**
 * /api/sb/orders/<action> — orders, payments and their emails.   DFD: P10
 *
 * AUTHENTICATION then AUTHORIZATION, as everywhere else:
 *   - the bearer token is checked with Supabase Auth on every call (a
 *     signed-out or revoked session is refused before anything else);
 *   - the database functions in 0009 then decide whether THIS account may do
 *     THIS thing to THIS order, as that user, under RLS.
 * Nothing here trusts a price, a payee or a status from the browser. The
 * browser names a product, a quantity, an order; every amount comes from
 * begin_payment() and every capture is re-read from PayPal.
 *
 * The one privileged act — recording a captured payment — needs
 * PAYMENT_RECORDER_SECRET, which only this server has.
 */
const { serverCredentials, callerToken, callSupabase } = require('./supabase-proxy.js');
const { verifySession } = require('./auth.js');
const paypal = require('./paypal.js');
const notify = require('./notify.js');

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function recorderSecret() {
  return String(process.env.PAYMENT_RECORDER_SECRET || '').trim();
}

function paymentsReady() {
  return paypal.isConfigured() && recorderSecret().length >= 32;
}

/** A database function, called AS the signed-in user. */
async function rpc(ctx, fn, args) {
  const response = await callSupabase(`${ctx.url}/rest/v1/rpc/${fn}`, {
    method: 'POST',
    headers: { apikey: ctx.key, Authorization: `Bearer ${ctx.token}`, 'Content-Type': 'application/json' },
    body: JSON.stringify(args)
  });
  const text = await response.text();
  let body = null;
  try { body = text ? JSON.parse(text) : null; } catch { body = text; }
  if (!response.ok) {
    // The functions raise sentences written for people ("Only 2 left in
    // stock."). Anything else — a Postgres internal — is not passed on.
    const code = body?.code;
    const readable = typeof body?.message === 'string' && /^[A-Z].{3,200}[.!]$/.test(body.message)
      && !/relation|column|syntax|function .*does not exist/i.test(body.message);
    const error = new Error(readable ? body.message : 'That could not be completed. Please try again.');
    error.status = code === '42501' || code === '28000' ? 403 : response.status >= 500 ? 502 : 400;
    throw error;
  }
  return body;
}

function fail(status, message, code) {
  const error = new Error(message);
  error.status = status;
  if (code) error.code = code;
  return error;
}

function requireOrderId(value) {
  if (!UUID.test(String(value || ''))) throw fail(400, 'Unknown order.');
  return value;
}

/** Emails for an event, never blocking or failing the response. */
async function announce(ctx, orderId, event, extra = {}) {
  try {
    const contacts = { ...(await rpc(ctx, 'order_contacts', { p_order: orderId })), ...extra };
    await Promise.all(notify.messagesFor(event, contacts, ctx.site).map(message => notify.sendEmail(message)));
  } catch (error) {
    console.error(`[orders] could not send "${event}" emails: ${error.message}`);
  }
}

async function startPayment(ctx, orderId) {
  if (!paymentsReady()) throw fail(503, 'Online payments are not switched on yet.', 'payments_unconfigured');
  const due = await rpc(ctx, 'begin_payment', { p_order: orderId });
  if (!due?.stage) throw fail(409, 'Nothing is due on this order.', 'nothing_due');
  const created = await paypal.createOrder({
    orderId: due.order_id,
    reference: due.reference,
    stage: due.stage,
    amount: due.amount,
    currency: due.currency,
    payeeEmail: due.payee_email,
    description: `${due.product_name} — ${due.store_name} (${due.stage})`,
    returnUrl: `${ctx.site}/account?paypal=return`,
    cancelUrl: `${ctx.site}/account?paypal=cancel`
  }).catch(error => {
    throw fail(502, error.code === 'payments_unavailable'
      ? 'Online payments are unavailable right now. Please try again later.'
      : "PayPal couldn't start the payment. Please try again.");
  });
  return { orderId: due.order_id, reference: due.reference, stage: due.stage, amount: due.amount, approveUrl: created.approveUrl };
}

const EVENT_AFTER_CAPTURE = { paid: 'paid', deposit_paid: 'deposit_paid' };

async function capture(ctx, paypalOrderId) {
  if (!paymentsReady()) throw fail(503, 'Online payments are not switched on yet.', 'payments_unconfigured');
  if (!/^[A-Z0-9]{10,24}$/.test(String(paypalOrderId || ''))) throw fail(400, 'Unknown PayPal payment.');

  let facts = paypal.summarise(await paypal.getOrder(paypalOrderId).catch(() => {
    throw fail(502, "We couldn't confirm the payment with PayPal. Please try again.");
  }));
  if (!facts.orderId || !facts.stage) throw fail(400, 'That PayPal payment is not a FurnishAR order.');

  // Ownership and the amount due, from the database, as this user.
  const due = await rpc(ctx, 'begin_payment', { p_order: facts.orderId });

  if (facts.status === 'APPROVED') {
    const matches = due?.stage === facts.stage
      && Number(due.amount).toFixed(2) === Number(facts.amount).toFixed(2)
      && facts.currency === due.currency
      && facts.payeeEmail === String(due.payee_email).toLowerCase();
    if (!matches) {
      // Do not take money for something that no longer matches what is owed.
      throw fail(409, 'This payment no longer matches the order. Start the payment again from your orders.');
    }
    facts = paypal.summarise(await paypal.captureOrder(paypalOrderId).catch(error => {
      throw fail(error.issue === 'INSTRUMENT_DECLINED' ? 402 : 502,
        error.issue === 'INSTRUMENT_DECLINED'
          ? 'PayPal declined that payment method. Please try another.'
          : "PayPal couldn't complete the payment. You have not been charged.");
    }));
  } else if (facts.status !== 'COMPLETED') {
    throw fail(409, 'The payment was not approved on PayPal.');
  }

  if (facts.captureStatus === 'PENDING') {
    return { orderId: facts.orderId, pending: true };
  }
  if (facts.captureStatus !== 'COMPLETED' || !facts.captureId) {
    throw fail(402, 'PayPal did not complete the payment. You have not been charged.');
  }

  const recorded = await rpc(ctx, 'record_capture', {
    p_secret: recorderSecret(),
    p_order: facts.orderId,
    p_stage: facts.stage,
    p_provider_order: facts.paypalOrderId,
    p_capture: facts.captureId,
    p_amount: facts.amount,
    p_currency: facts.currency,
    p_payee: facts.payeeEmail,
    p_payer_email: facts.payerEmail
  });

  if (!recorded.duplicate) {
    if (!recorded.applied) await announce(ctx, facts.orderId, 'unapplied');
    else if (EVENT_AFTER_CAPTURE[recorded.status]) await announce(ctx, facts.orderId, EVENT_AFTER_CAPTURE[recorded.status]);
  }
  return { orderId: facts.orderId, status: recorded.status, applied: recorded.applied };
}

const ACTIONS = {
  async checkout(ctx, body) {
    if (!paymentsReady()) throw fail(503, 'Online payments are not switched on yet.', 'payments_unconfigured');
    if (!UUID.test(String(body.productId || ''))) throw fail(400, 'Unknown product.');
    const quantity = Number(body.quantity || 1);
    const created = await rpc(ctx, 'create_stock_order', { p_product: body.productId, p_quantity: quantity });
    try {
      return await startPayment(ctx, created.order_id);
    } catch (error) {
      // PayPal would not start: give the stock straight back.
      await rpc(ctx, 'cancel_order', { p_order: created.order_id }).catch(() => {});
      throw error;
    }
  },

  async pay(ctx, body) {
    return startPayment(ctx, requireOrderId(body.orderId));
  },

  async capture(ctx, body) {
    return capture(ctx, body.paypalOrderId);
  },

  async request(ctx, body) {
    if (!UUID.test(String(body.storeId || ''))) throw fail(400, 'Unknown shop.');
    const product = UUID.test(String(body.productId || '')) ? body.productId : null;
    const request = body.request && typeof body.request === 'object' ? body.request : {};
    const created = await rpc(ctx, 'create_custom_request', { p_store: body.storeId, p_product: product, p_request: request });
    await announce(ctx, created.order_id, 'requested');
    return { orderId: created.order_id, reference: created.reference };
  },

  async cancel(ctx, body) {
    const result = await rpc(ctx, 'cancel_order', { p_order: requireOrderId(body.orderId) });
    await announce(ctx, body.orderId, 'cancelled');
    return result;
  },

  async quote(ctx, body) {
    const result = await rpc(ctx, 'quote_custom_order', {
      p_order: requireOrderId(body.orderId),
      p_price: Number(body.price),
      p_lead_days: Number(body.leadDays),
      p_note: body.note ? String(body.note) : null
    });
    await announce(ctx, body.orderId, 'quoted');
    return result;
  },

  async decline(ctx, body) {
    const result = await rpc(ctx, 'decline_custom_order', {
      p_order: requireOrderId(body.orderId), p_reason: body.reason ? String(body.reason) : null
    });
    await announce(ctx, body.orderId, 'declined');
    return result;
  },

  async ready(ctx, body) {
    const result = await rpc(ctx, 'mark_order_ready', { p_order: requireOrderId(body.orderId) });
    if (result.status === 'balance_due') await announce(ctx, body.orderId, 'balance_due');
    return result;
  },

  async fulfil(ctx, body) {
    const result = await rpc(ctx, 'mark_order_fulfilled', { p_order: requireOrderId(body.orderId) });
    await announce(ctx, body.orderId, 'fulfilled');
    return result;
  },

  async 'store-billing'(ctx, body) {
    if (!UUID.test(String(body.storeId || ''))) throw fail(400, 'Unknown shop.');
    if (!['stocked', 'custom'].includes(body.fulfilment)) throw fail(400, 'Choose stocked or custom.');
    return rpc(ctx, 'save_store_billing', {
      p_store: body.storeId,
      p_fulfilment: body.fulfilment,
      p_paypal_email: body.paypalEmail ? String(body.paypalEmail) : null,
      p_notify_email: body.notifyEmail ? String(body.notifyEmail) : null
    });
  }
};

/** What the browser may know about this deployment's billing. No secrets. */
function billingConfig() {
  return {
    payments: paymentsReady(),
    email: notify.isConfigured(),
    feeRate: 0.10,
    currency: 'PHP',
    depositRate: 0.5,
    sandbox: paypal.credentials().env !== 'live'
  };
}

/**
 * The route's entry point. `req` is { method, headers }; `site` is the origin
 * PayPal returns the buyer to.
 */
async function handleOrders(req, action, body, site) {
  if (action === 'config' && req.method === 'GET') return { status: 200, body: billingConfig() };
  if (req.method !== 'POST' || !Object.hasOwn(ACTIONS, action)) {
    return { status: 404, body: { error: 'Unknown endpoint.' } };
  }
  const { url, key } = serverCredentials();
  if (!url || !key) return { status: 503, body: { error: 'This deployment has no Supabase backend configured.' } };

  const token = callerToken(req);
  if (!token) return { status: 401, body: { code: 'auth_required', error: 'Please sign in to continue.' } };
  const user = await verifySession({ url, key, token, call: callSupabase }).catch(() => null);
  if (!user) return { status: 401, body: { code: 'session_expired', error: 'Your session has expired. Please sign in again.' } };

  const ctx = { url, key, token, user, site };
  try {
    return { status: 200, body: await ACTIONS[action](ctx, body || {}) };
  } catch (error) {
    if (error.upstream) throw error;
    return { status: error.status || 500, body: { error: error.message, ...(error.code ? { code: error.code } : {}) } };
  }
}

module.exports = { handleOrders, billingConfig, paymentsReady, ACTIONS };
