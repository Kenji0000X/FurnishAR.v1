/**
 * /api/sb/orders/<action> — orders, payments and their emails.   DFD: P10
 *
 * AUTHENTICATION then AUTHORIZATION, as everywhere else:
 *   - the bearer token is checked with Supabase Auth on every call (a
 *     signed-out or revoked session is refused before anything else);
 *   - the database functions (0009–0011) then decide whether THIS account
 *     may do THIS thing to THIS order, as that user, under RLS.
 * Nothing here trusts a price, a fee, a payee, a merchant or a status from
 * the browser. The browser names a product, a quantity, an order; every
 * amount and the seller's PayPal merchant id come from begin_payment(), and
 * every capture is re-read from PayPal.
 *
 * The privileged acts — recording what PayPal did — need
 * PAYMENT_RECORDER_SECRET, which only this server has (lib/server-db.js).
 */
const { serverCredentials, callerToken, callSupabase } = require('./supabase-proxy.js');
const { verifySession } = require('./auth.js');
const { rpc, serverRpc, serverSecretReady } = require('./server-db.js');
const paypal = require('./paypal.js');
const notify = require('./notify.js');

/** The buyer's delivery choice, as the 0010 functions take it. Checked there. */
function deliveryArgs(body) {
  const d = body.delivery && typeof body.delivery === 'object' ? body.delivery : {};
  const text = (value, max) => (value == null ? null : String(value).slice(0, max));
  return {
    p_method: text(d.method, 20),
    p_address: text(d.address, 300),
    p_municipality: text(d.municipality, 80),
    p_phone: text(d.phone, 30),
    p_notes: text(d.notes, 300)
  };
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function paymentsReady() {
  return paypal.isConfigured() && serverSecretReady();
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

const money2 = value => Number(value).toFixed(2);

/**
 * Emails for an order event. Never blocks, never fails the response: an
 * email is a notification of something already recorded, never the record.
 * `ctx` with a user token asks as that party; without one (webhooks) the
 * server-only contacts function is used.
 */
async function announce(ctx, orderId, event, extra = {}) {
  try {
    const contacts = ctx?.token
      ? await rpc(ctx, 'order_contacts', { p_order: orderId })
      : await serverRpc('server_order_contacts', { p_order: orderId });
    if (!contacts) return;
    const site = ctx?.site || notify.siteUrl();
    await Promise.all(notify.messagesFor(event, { ...contacts, ...extra }, site).map(message => notify.sendEmail(message)));
  } catch (error) {
    console.error(`[orders] could not send "${event}" emails: ${error.message}`);
  }
}

/** Operational emails to the platform admins (platform_fee_recorded, problems). */
async function tellAdmins(event, data, site) {
  try {
    const admins = await serverRpc('server_admin_emails', {});
    if (!admins?.length) return;
    await Promise.all(notify.messagesFor(event, { ...data, admin_emails: admins }, site || notify.siteUrl())
      .map(message => notify.sendEmail(message)));
  } catch (error) {
    console.error(`[orders] could not send "${event}" admin email: ${error.message}`);
  }
}

/**
 * The fee mode for ONE payment. platform_split only when the deployment is
 * configured for it (partner id + attribution id) and this seller granted
 * FurnishAR the partner-fee permission; otherwise the fee accrues. Never a
 * split that PayPal would not honour.
 */
function feeModeFor(due, config = paypal.validateConfig()) {
  return config.feeMode === 'platform_split' && due?.partner_fee_granted === true && Number(due.platform_fee) > 0
    ? 'platform_split'
    : 'accrual';
}

async function startPayment(ctx, orderId) {
  if (!paymentsReady()) throw fail(503, 'Online payments are not switched on yet.', 'payments_unconfigured');
  const config = paypal.validateConfig();
  const due = await rpc(ctx, 'begin_payment', { p_order: orderId, p_env: config.env });
  if (!due?.stage) throw fail(409, 'Nothing is due on this order.', 'nothing_due');
  if (!due.merchant_id) throw fail(409, 'This shop is finishing its PayPal setup and cannot take online payments yet.', 'seller_not_connected');

  const feeMode = feeModeFor(due, config);
  const created = await paypal.createOrder({
    orderId: due.order_id,
    reference: due.reference,
    stage: due.stage,
    amount: due.amount,
    currency: due.currency,
    merchantId: due.merchant_id,
    platformFee: due.platform_fee,
    feeMode,
    description: `${due.product_name} — ${due.store_name} (${due.stage})`,
    returnUrl: `${ctx.site}/account?paypal=return`,
    cancelUrl: `${ctx.site}/account?paypal=cancel`
  }).catch(error => {
    throw fail(502, error.code === 'payments_unavailable'
      ? 'Online payments are unavailable right now. Please try again later.'
      : "PayPal couldn't start the payment. Please try again.");
  });

  // What FurnishAR asked PayPal for, recorded before the buyer leaves. The
  // capture is checked against this row, not against anything the browser
  // brings back.
  await serverRpc('server_record_payment_attempt', {
    p_order: due.order_id, p_stage: due.stage, p_env: config.env, p_provider_order: created.id,
    p_amount: due.amount, p_platform_fee: due.platform_fee, p_fee_mode: feeMode, p_merchant: due.merchant_id
  }, ctx.token);

  return { orderId: due.order_id, reference: due.reference, stage: due.stage, amount: due.amount, approveUrl: created.approveUrl };
}

/**
 * Does PayPal's order say exactly what FurnishAR asked for? Compared with the
 * recorded attempt: the order, the stage, the amount, the currency, the
 * seller's merchant id and — for a split — the platform fee.
 */
function matchesAttempt(facts, attempt) {
  return facts.orderId === attempt.order_id
    && facts.stage === attempt.stage
    && money2(facts.amount) === money2(attempt.amount)
    && facts.currency === attempt.currency
    && facts.payeeMerchantId === attempt.payee_merchant_id
    && (attempt.fee_mode !== 'platform_split' || money2(facts.requestedPlatformFee) === money2(attempt.platform_fee));
}

const EVENT_AFTER_CAPTURE = { paid: 'paid', deposit_paid: 'deposit_paid' };

/**
 * Records a COMPLETED capture and sends its emails. Shared by the buyer's
 * return from PayPal (with their token) and the webhook (without).
 */
async function recordCompletedCapture(ctx, facts, attempt) {
  const config = paypal.validateConfig();
  const recorded = await serverRpc('record_capture', {
    p_order: facts.orderId,
    p_stage: facts.stage,
    p_provider_order: facts.paypalOrderId,
    p_capture: facts.captureId,
    p_amount: facts.amount,
    p_currency: facts.currency,
    p_payee: facts.payeeEmail || null,
    p_payer_email: facts.payerEmail,
    p_payee_merchant: facts.payeeMerchantId,
    p_fee_mode: attempt?.fee_mode || 'accrual',
    p_fee_collected: facts.platformFeeCollected,
    p_env: attempt?.environment || config.env
  }, ctx?.token || null);

  if (!recorded.duplicate) {
    if (!recorded.applied) await announce(ctx, facts.orderId, 'unapplied');
    else {
      if (EVENT_AFTER_CAPTURE[recorded.status]) await announce(ctx, facts.orderId, EVENT_AFTER_CAPTURE[recorded.status]);
      await tellAdmins('platform_fee_recorded', {
        order_id: facts.orderId, stage: facts.stage, amount: facts.amount,
        platform_fee: recorded.platform_fee, fee_mode: recorded.fee_mode, sandbox: config.sandbox
      }, ctx?.site);
    }
  }
  return recorded;
}

async function capture(ctx, paypalOrderId) {
  if (!paymentsReady()) throw fail(503, 'Online payments are not switched on yet.', 'payments_unconfigured');
  if (!/^[A-Z0-9]{10,24}$/.test(String(paypalOrderId || ''))) throw fail(400, 'Unknown PayPal payment.');
  const config = paypal.validateConfig();

  let facts = paypal.summarise(await paypal.getOrder(paypalOrderId).catch(() => {
    throw fail(502, "We couldn't confirm the payment with PayPal. Please try again.");
  }));
  if (!facts.orderId || !facts.stage) throw fail(400, 'That PayPal payment is not a FurnishAR order.');

  const attempt = await serverRpc('server_payment_attempt', { p_provider_order: paypalOrderId }, ctx.token);

  if (facts.status === 'APPROVED') {
    // Ownership and what is owed NOW, from the database, as this user.
    const due = await rpc(ctx, 'begin_payment', { p_order: facts.orderId, p_env: attempt?.environment || config.env });
    const owed = due?.stage === facts.stage && money2(due.amount) === money2(facts.amount) && facts.currency === due.currency;
    const asAsked = attempt ? matchesAttempt(facts, attempt) : facts.payeeMerchantId === null; // pre-0011 orders named an email
    if (!owed || !asAsked) {
      // Do not take money for something that no longer matches what is owed.
      throw fail(409, 'This payment no longer matches the order. Start the payment again from your orders.');
    }
    facts = paypal.summarise(await paypal.captureOrder(paypalOrderId).catch(async error => {
      const declined = error.issue === 'INSTRUMENT_DECLINED';
      await serverRpc('server_update_payment_attempt', {
        p_provider_order: paypalOrderId, p_status: declined ? 'DECLINED' : 'FAILED', p_capture: null, p_reason: error.issue
      }).catch(() => {});
      throw fail(declined ? 402 : 502, declined
        ? 'PayPal declined that payment method. Please try another.'
        : "PayPal couldn't complete the payment. You have not been charged.");
    }));
  } else if (facts.status !== 'COMPLETED') {
    throw fail(409, 'The payment was not approved on PayPal.');
  }

  if (facts.captureStatus === 'PENDING') {
    await serverRpc('server_update_payment_attempt', {
      p_provider_order: paypalOrderId, p_status: 'PENDING', p_capture: facts.captureId, p_reason: null
    }).catch(() => {});
    return { orderId: facts.orderId, pending: true };
  }
  if (facts.captureStatus !== 'COMPLETED' || !facts.captureId) {
    await serverRpc('server_update_payment_attempt', {
      p_provider_order: paypalOrderId, p_status: 'DECLINED', p_capture: facts.captureId, p_reason: facts.captureStatus
    }).catch(() => {});
    throw fail(402, 'PayPal did not complete the payment. You have not been charged.');
  }

  const recorded = await recordCompletedCapture(ctx, facts, attempt);
  return { orderId: facts.orderId, status: recorded.status, applied: recorded.applied };
}

const ACTIONS = {
  async checkout(ctx, body) {
    if (!paymentsReady()) throw fail(503, 'Online payments are not switched on yet.', 'payments_unconfigured');
    if (!UUID.test(String(body.productId || ''))) throw fail(400, 'Unknown product.');
    const quantity = Number(body.quantity || 1);
    const created = await rpc(ctx, 'create_stock_order', {
      p_product: body.productId, p_quantity: quantity, ...deliveryArgs(body)
    });
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
    const created = await rpc(ctx, 'create_custom_request', {
      p_store: body.storeId, p_product: product, p_request: request, ...deliveryArgs(body)
    });
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
    await announce(ctx, body.orderId, 'delivered');
    return result;
  },

  /* The shop's delivery steps: out_for_delivery | ready_for_pickup | delivered. */
  async delivery(ctx, body) {
    const status = String(body.status || '');
    if (!['out_for_delivery', 'ready_for_pickup', 'delivered'].includes(status)) throw fail(400, 'Unknown delivery step.');
    const result = await rpc(ctx, 'update_delivery_status', { p_order: requireOrderId(body.orderId), p_status: status });
    await announce(ctx, body.orderId, status);
    return result;
  },

  async 'store-billing'(ctx, body) {
    if (!UUID.test(String(body.storeId || ''))) throw fail(400, 'Unknown shop.');
    if (!['stocked', 'custom'].includes(body.fulfilment)) throw fail(400, 'Choose stocked or custom.');
    return rpc(ctx, 'save_store_billing', {
      p_store: body.storeId,
      p_fulfilment: body.fulfilment,
      // Legacy / manual record only (0011): it no longer enables checkout.
      p_paypal_email: body.paypalEmail ? String(body.paypalEmail) : null,
      p_notify_email: body.notifyEmail ? String(body.notifyEmail) : null,
      p_delivery_days: Number(body.deliveryDays ?? 3),
      p_pickup_days: Number(body.pickupDays ?? 1)
    });
  }
};

/**
 * What the browser may know about this deployment's billing. No secrets:
 * whether things are switched on, which environment, which fee mode is
 * really in force, and the configuration problems an admin must fix.
 */
function billingConfig({ admin = false } = {}) {
  const config = paypal.validateConfig();
  return {
    payments: paymentsReady(),
    email: notify.isConfigured(),
    feeRate: config.feeRate,
    currency: 'PHP',
    depositRate: 0.5,
    sandbox: config.sandbox,
    environment: config.env,
    feeMode: config.feeMode,
    feeModeConfigured: config.feeModeConfigured,
    sellerOnboarding: config.onboarding && serverSecretReady(),
    sellerMode: config.sellerMode,
    webhooks: config.webhooks,
    ...(admin ? { problems: config.problems, warnings: config.warnings } : {})
  };
}

async function authenticate(req) {
  const { url, key } = serverCredentials();
  if (!url || !key) return { error: { status: 503, body: { error: 'This deployment has no Supabase backend configured.' } } };
  const token = callerToken(req);
  if (!token) return { error: { status: 401, body: { code: 'auth_required', error: 'Please sign in to continue.' } } };
  const user = await verifySession({ url, key, token, call: callSupabase }).catch(() => null);
  if (!user) return { error: { status: 401, body: { code: 'session_expired', error: 'Your session has expired. Please sign in again.' } } };
  return { ctx: { url, key, token, user } };
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
  const auth = await authenticate(req);
  if (auth.error) return auth.error;
  const ctx = { ...auth.ctx, site };
  try {
    return { status: 200, body: await ACTIONS[action](ctx, body || {}) };
  } catch (error) {
    if (error.upstream) throw error;
    return { status: error.status || 500, body: { error: error.message, ...(error.code ? { code: error.code } : {}) } };
  }
}

module.exports = {
  handleOrders, billingConfig, paymentsReady, ACTIONS, authenticate,
  feeModeFor, matchesAttempt, recordCompletedCapture, announce, tellAdmins, fail
};
