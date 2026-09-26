/**
 * /api/sb/orders/<action> — orders, payments and their emails.   DFD: P10
 *
 * AUTHENTICATION then AUTHORIZATION, as everywhere else:
 *   - the bearer token is checked with Supabase Auth on every call (a
 *     signed-out or revoked session is refused before anything else);
 *   - the database functions (0009–0011) then decide whether THIS account
 *     may do THIS thing to THIS order, as that user, under RLS.
 * Nothing here trusts a price, a fee, a payee, a merchant or a status from
 * the browser. The browser names a product, a quantity, an order and a
 * payment method (PayPal, or GCash through PayMongo — lib/providers); every amount and payee
 * comes from begin_payment(), and every payment is re-read from its provider.
 *
 * The privileged acts — recording what PayPal or PayMongo did — need
 * PAYMENT_RECORDER_SECRET, which only this server has (lib/server-db.js).
 */
const { serverCredentials, callerToken, callSupabase } = require('./supabase-proxy.js');
const { verifySession } = require('./auth.js');
const { rpc, serverRpc, serverSecretReady } = require('./server-db.js');
const paypal = require('./paypal.js');
const paymongo = require('./paymongo.js');
const { isPlatformAdmin } = require('./auth.js');
const providers = require('./providers/index.js');
const notify = require('./notify.js');
const { dispatchPaymentNotifications } = require('./payment-notifications.js');

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

/** Can this server take ANY online payment? (PayPal, GCash via PayMongo, or both.) */
function paymentsReady() {
  return providers.configured().length > 0 && serverSecretReady();
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

const { phpToCentavos, centavosToPhp } = require('./money.js');
const money2 = value => Number(value).toFixed(2);

/*
  The provider arguments (0015/0016) are sent only for PayMongo. For PayPal the calls are
  exactly the pre-0015 ones, which both schemas answer: with 0015 applied the
  new functions default p_provider to 'paypal'; without it, the old ones are
  still there. So PayPal keeps working whichever lands first, the deploy or
  the migration.
*/
const providerArgs = (id, extra = {}) => (id === 'paypal' ? {} : { p_provider: id, ...extra });

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

const { feeModeFor } = providers.PROVIDERS.paypal;

/**
 * Starts paying what is due on an order, through the chosen provider. The
 * amount, the fee and the payee are begin_payment()'s; the attempt is
 * recorded before the buyer leaves, and whatever comes back is checked
 * against it, never against the browser.
 */
async function startPayment(ctx, orderId, providerId = 'paypal') {
  const provider = providers.get(providerId);
  if (!provider.ready()) {
    throw fail(503, paymentsReady()
      ? `${provider.label} payments are not switched on. Choose another payment method.`
      : 'Online payments are not switched on yet.', 'payments_unconfigured');
  }
  const env = provider.env();
  const due = await rpc(ctx, 'begin_payment', { p_order: orderId, p_env: env, ...providerArgs(provider.id) });
  if (!due?.stage) throw fail(409, 'Nothing is due on this order.', 'nothing_due');

  const started = await provider.start(ctx, due);

  // What FurnishAR asked the provider for, recorded before the buyer leaves.
  await serverRpc('server_record_payment_attempt', {
    p_order: due.order_id, p_stage: due.stage, p_env: env, p_provider_order: started.providerOrder,
    p_amount: due.amount, p_platform_fee: due.platform_fee, p_fee_mode: started.feeMode, p_merchant: started.payee,
    ...providerArgs(provider.id, { p_reference: started.reference, p_method: started.method })
  }, ctx.token);

  return {
    orderId: due.order_id, reference: due.reference, stage: due.stage, amount: due.amount,
    provider: provider.id, approveUrl: started.redirectUrl
  };
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
 * record_capture for PayPal. Two things beyond one call:
 *   - PayPal's processing fee is recorded where the database can take it
 *     (0016's p_processing_fee); on an older schema it is left out rather
 *     than failing the payment;
 *   - the buyer's return and PayPal's webhook can record the same capture at
 *     the same moment; the loser of that race gets a unique violation, and
 *     asking again returns the winner's row as a duplicate. Same payment,
 *     never two.
 */
async function recordPaypalCapture(ctx, args, processingFee) {
  const token = ctx?.token || null;
  const withFee = processingFee != null ? { ...args, p_processing_fee: processingFee } : args;
  const once = async body => {
    try {
      return await serverRpc('record_capture', body, token);
    } catch (error) {
      if (error.dbCode === '23505') return serverRpc('record_capture', body, token);
      throw error;
    }
  };
  try {
    return await once(withFee);
  } catch (error) {
    if (withFee !== args && error.dbCode === 'PGRST202') return once(args);
    throw error;
  }
}

/**
 * Records a COMPLETED payment and sends its emails. Shared by the buyer's
 * return (with their token) and the webhooks (without), for both providers.
 * `facts.provider` is 'paypal' unless said otherwise.
 */
async function recordCompletedCapture(ctx, facts, attempt) {
  const provider = providers.get(facts.provider || attempt?.provider || 'paypal');
  const config = provider.config();
  const args = {
    p_order: facts.orderId,
    p_stage: facts.stage,
    p_provider_order: facts.providerOrder || facts.paypalOrderId,
    p_capture: facts.captureId,
    p_amount: facts.amount,
    p_currency: facts.currency,
    p_payee: facts.payeeEmail || null,
    p_payer_email: facts.payerEmail,
    p_payee_merchant: facts.payeeMerchantId,
    p_fee_mode: attempt?.fee_mode || 'accrual',
    p_fee_collected: facts.platformFeeCollected ?? null,
    p_env: attempt?.environment || config.env,
    ...providerArgs(provider.id, facts.processingFee != null ? { p_processing_fee: facts.processingFee } : {})
  };
  const recorded = provider.id === 'paypal'
    ? await recordPaypalCapture(ctx, args, facts.processingFee)
    : await serverRpc('record_capture', args, ctx?.token || null);

  if (provider.id === 'paypal') {
    // PayPal's payment emails come from the 0017 ledger: written with the
    // payment, claimed atomically, sent once whichever path (return, retry,
    // webhook) gets here first. A duplicate capture still dispatches, so an
    // email that failed or was interrupted earlier is retried — never doubled.
    const dispatched = await dispatchPaymentNotifications({ captureId: facts.captureId, site: ctx?.site || notify.siteUrl() })
      .catch(error => { console.error(`[orders] payment emails: ${error.message}`); return { ledger: true }; });
    if (dispatched.ledger) return recorded;
    // Before 0017: the previous behaviour (sent once, by the path that recorded it).
  }

  if (!recorded.duplicate) {
    if (!recorded.applied) {
      await announce(ctx, facts.orderId, 'unapplied', { provider: provider.id });
      // A GCash payment sits in FurnishAR's PayMongo account: FurnishAR refunds it, not the shop.
      if (provider.id === 'paymongo') {
        await tellAdmins('payment_problem', {
          provider: 'paymongo', reference: attempt?.provider_reference || facts.captureId,
          detail: `A GCash payment of ${money2(facts.amount)} ${facts.currency} (PayMongo payment ${facts.captureId}) could not be applied to its order. Refund it from admin billing.`
        }, ctx?.site);
      }
    }
    else {
      if (EVENT_AFTER_CAPTURE[recorded.status]) await announce(ctx, facts.orderId, EVENT_AFTER_CAPTURE[recorded.status]);
      await tellAdmins('platform_fee_recorded', {
        order_id: facts.orderId, stage: facts.stage, amount: facts.amount,
        platform_fee: recorded.platform_fee, fee_mode: recorded.fee_mode, sandbox: config.sandbox,
        provider: provider.id
      }, ctx?.site);
    }
  }
  return recorded;
}

async function capture(ctx, paypalOrderId) {
  if (!providers.PROVIDERS.paypal.ready()) throw fail(503, 'Online payments are not switched on yet.', 'payments_unconfigured');
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
  } else if (attempt && !matchesAttempt(facts, attempt)) {
    // Already captured (by the webhook, or an earlier try): it still has to be
    // exactly what FurnishAR asked for before it is recorded.
    throw fail(409, 'This payment does not match the order. FurnishAR has been told.');
  }

  // What PayPal actually captured must be in the order's currency; a payment
  // in another currency is never applied (record_capture refuses it too).
  if (facts.captureStatus === 'COMPLETED' && attempt && (facts.captureCurrency || facts.currency) !== attempt.currency) {
    await tellAdmins('payment_problem', {
      provider: 'paypal', reference: facts.captureId || paypalOrderId,
      detail: `PayPal captured ${facts.captureCurrency || facts.currency}, not ${attempt.currency}. It was not recorded; refund it in PayPal.`
    }, ctx.site);
    throw fail(409, 'This payment does not match the order. FurnishAR has been told.');
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

const REFERENCE = /^[A-Za-z0-9-]{6,64}$/;
const ATTEMPT_STATUS = { failed: 'DECLINED', none: 'CANCELLED' };

/**
 * Settles ONE PayMongo (GCash) attempt from what PayMongo itself says: the
 * checkout session is re-read with the secret key. Shared by the buyer's
 * return (ctx with their token) and the signed webhook (ctx without). A
 * redirect is never proof of payment.
 *
 *   paid      record_capture (idempotent on PayMongo's payment id), emails once
 *   mismatch  PayMongo took an amount the attempt did not ask for: recorded
 *             anyway (the money exists), which the database marks unapplied,
 *             so the order does not move and FurnishAR refunds it
 *   pending   nothing recorded yet
 *   failed    the attempt is marked declined; `notifyFailure` emails the buyer
 *   none      the session expired unpaid, or the buyer cancelled
 */
async function settlePaymongo(ctx, attempt, { notifyFailure = false } = {}) {
  const provider = providers.PROVIDERS.paymongo;
  const session = await paymongo.getCheckoutSession(attempt.provider_order_id).catch(() => {
    throw fail(502, "We couldn't confirm the payment with PayMongo. Please try again.");
  });
  const verdict = provider.judgeSession(attempt, session);
  const { payment } = verdict;

  if (verdict.state === 'paid' || (verdict.state === 'mismatch' && payment.currency === attempt.currency)) {
    const recorded = await recordCompletedCapture(ctx, {
      provider: 'paymongo',
      orderId: attempt.order_id,
      stage: attempt.stage,
      providerOrder: attempt.provider_order_id,
      captureId: payment.paymentId,
      amount: payment.amount,
      currency: payment.currency,
      payeeEmail: null,
      payerEmail: payment.payerEmail,
      payeeMerchantId: attempt.payee_merchant_id,
      processingFee: payment.fee
    }, attempt);
    return { state: recorded.applied ? 'paid' : 'unapplied', orderId: attempt.order_id, status: recorded.status,
             applied: recorded.applied, duplicate: recorded.duplicate };
  }
  if (verdict.state === 'mismatch') {
    await tellAdmins('payment_problem', {
      provider: 'paymongo', order_id: attempt.order_id, reference: attempt.provider_reference,
      detail: `PayMongo reports a paid GCash payment in ${payment.currency || 'an unknown currency'}, not ${attempt.currency}. It was not recorded; refund it in the PayMongo dashboard.`
    }, ctx?.site);
    return { state: 'mismatch', orderId: attempt.order_id };
  }
  if (verdict.state === 'pending') return { state: 'pending', orderId: attempt.order_id };

  await serverRpc('server_update_payment_attempt', {
    p_provider_order: attempt.provider_order_id, p_status: ATTEMPT_STATUS[verdict.state],
    p_capture: payment?.paymentId || null, p_reason: payment?.status || null
  }).catch(() => {});
  if (verdict.state === 'failed' && notifyFailure) await announce(ctx, attempt.order_id, 'payment_failed', { provider: 'paymongo' });
  return { state: verdict.state === 'failed' ? 'failed' : 'cancelled', orderId: attempt.order_id };
}

/** The buyer is back from PayMongo: what happened to their GCash payment? */
async function verifyPaymongo(ctx, reference) {
  if (!providers.PROVIDERS.paymongo.ready()) throw fail(503, 'GCash payments are not switched on.', 'payments_unconfigured');
  if (!REFERENCE.test(String(reference || ''))) throw fail(400, 'Unknown GCash payment.');
  const attempt = await serverRpc('server_payment_attempt_by_reference',
    { p_provider: 'paymongo', p_reference: reference }, ctx.token);
  if (!attempt) throw fail(404, 'Unknown GCash payment.');
  // Only the buyer who started it may ask about it (RLS: their own orders).
  if (!await ownsOrder(ctx, attempt.order_id)) throw fail(404, 'Unknown GCash payment.');
  const result = await settlePaymongo(ctx, attempt);
  return { provider: 'paymongo', method: 'gcash', orderId: result.orderId, state: result.state,
           status: result.status ?? null, applied: result.applied ?? null };
}

/**
 * Refunds a GCash payment through PayMongo. Admin only: the money is in
 * FurnishAR's PayMongo account. The refund is recorded here only when
 * PayMongo reports it succeeded; a pending one is recorded by the
 * payment.refund.updated webhook. PayPal refunds stay in PayPal (0011).
 */
async function refundPaymongo(ctx, body) {
  const { url, key } = serverCredentials();
  if (!await isPlatformAdmin({ url, key, token: ctx.token, call: callSupabase })) {
    throw fail(403, 'Only a platform administrator can refund a GCash payment.');
  }
  if (!providers.PROVIDERS.paymongo.ready()) throw fail(503, 'GCash payments are not switched on.', 'payments_unconfigured');
  const paymentId = String(body.paymentId || '');
  if (!/^pay_[A-Za-z0-9]{6,64}$/.test(paymentId)) throw fail(400, 'Unknown GCash payment.');
  // The payment as FurnishAR recorded it, read as this admin under RLS.
  const response = await callSupabase(
    `${url}/rest/v1/payments?capture_id=eq.${encodeURIComponent(paymentId)}&provider=eq.paymongo`
    + '&select=capture_id,amount,refunded_amount,currency,order_id',
    { headers: { apikey: key, Authorization: `Bearer ${ctx.token}`, Accept: 'application/json' } });
  const row = response.ok ? (await response.json().catch(() => []))[0] : null;
  if (!row) throw fail(404, 'Unknown GCash payment.');
  // In centavos, through the one helper: no float decides a refund.
  const remaining = phpToCentavos(money2(row.amount)) - phpToCentavos(money2(row.refunded_amount || 0));
  let amount;
  try { amount = body.amount == null || body.amount === '' ? remaining : phpToCentavos(String(body.amount).trim()); } catch { amount = 0; }
  if (!(amount > 0) || amount > remaining) throw fail(400, `Refund between ₱0.01 and ₱${centavosToPhp(remaining)}.`);
  const refund = await paymongo.createRefund({ paymentId, amount: centavosToPhp(amount), reason: 'requested_by_customer', notes: body.note })
    .catch(() => { throw fail(502, "PayMongo couldn't start the refund. Nothing was refunded; try again."); });
  if (refund?.status === 'succeeded') await recordPaymongoRefund(ctx, refund);
  return { refundId: refund?.refundId, status: refund?.status || 'pending' };
}

/** Records a SUCCEEDED PayMongo refund once, and tells the buyer and shop. */
async function recordPaymongoRefund(ctx, refund) {
  if (!refund?.refundId || refund.status !== 'succeeded' || !refund.paymentId || !refund.amount) return { skipped: true };
  const recorded = await serverRpc('server_record_refund', {
    p_capture: refund.paymentId, p_refund: refund.refundId, p_amount: Number(refund.amount),
    p_currency: refund.currency || 'PHP', p_fee_refunded: null, p_status: 'COMPLETED', p_kind: 'refund'
  });
  if (recorded?.completed) {
    await announce({ site: ctx?.site }, recorded.order_id, 'refund_completed', {
      refund_amount: recorded.amount, refund_platform_fee: recorded.platform_fee_refunded, provider: 'paymongo'
    });
  }
  return recorded;
}

/** Is this order the caller's? Read under RLS, as them. */
async function ownsOrder(ctx, orderId) {
  const { url, key } = serverCredentials();
  const response = await callSupabase(`${url}/rest/v1/orders?id=eq.${encodeURIComponent(orderId)}&select=id`,
    { headers: { apikey: key, Authorization: `Bearer ${ctx.token}`, Accept: 'application/json' } });
  if (!response.ok) return false;
  const rows = await response.json().catch(() => []);
  return Array.isArray(rows) && rows.length === 1;
}

const ACTIONS = {
  async checkout(ctx, body) {
    if (!paymentsReady()) throw fail(503, 'Online payments are not switched on yet.', 'payments_unconfigured');
    const provider = providers.get(body.provider);   // an unknown method is refused before any order exists
    if (!UUID.test(String(body.productId || ''))) throw fail(400, 'Unknown product.');
    const quantity = Number(body.quantity || 1);
    const created = await rpc(ctx, 'create_stock_order', {
      p_product: body.productId, p_quantity: quantity, ...deliveryArgs(body)
    });
    try {
      return await startPayment(ctx, created.order_id, provider.id);
    } catch (error) {
      // The provider would not start: give the stock straight back.
      await rpc(ctx, 'cancel_order', { p_order: created.order_id }).catch(() => {});
      throw error;
    }
  },

  async pay(ctx, body) {
    return startPayment(ctx, requireOrderId(body.orderId), body.provider);
  },

  async capture(ctx, body) {
    return capture(ctx, body.paypalOrderId);
  },

  /* The buyer's return from a provider that captures by itself (PayMongo / GCash). */
  async verify(ctx, body) {
    const provider = providers.get(body.provider);
    if (provider.id !== 'paymongo') throw fail(400, 'Unknown payment method.');
    return verifyPaymongo(ctx, body.reference);
  },

  /* Admin: refund a GCash payment through PayMongo. */
  async refund(ctx, body) {
    return refundPaymongo(ctx, body);
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
  const paymongoConfig = paymongo.validateConfig();
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
    // Each payment method this server can take, with its own environment.
    providers: serverSecretReady() ? providers.summary() : [],
    ...(admin ? {
      problems: config.problems,
      warnings: config.warnings,
      paymongo: {
        configured: paymongoConfig.configured, gcashEnabled: paymongoConfig.gcashEnabled,
        sandbox: paymongoConfig.sandbox, environment: paymongoConfig.env, mode: paymongoConfig.mode,
        splitMode: paymongoConfig.splitMode, splitEnabled: paymongoConfig.splitEnabled,
        problems: paymongoConfig.problems, warnings: paymongoConfig.warnings
      }
    } : {})
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
async function handleOrders(req, action, body, site, query = null) {
  if (action === 'config' && req.method === 'GET') return { status: 200, body: billingConfig() };
  // Public: which payment methods this shop can be paid through, right now.
  if (action === 'providers' && req.method === 'GET') {
    try {
      return { status: 200, body: { providers: await providers.forStore(query?.get?.('store')) } };
    } catch (error) {
      return { status: error.status || 502, body: { error: error.message } };
    }
  }
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
  feeModeFor, matchesAttempt, recordCompletedCapture, settlePaymongo, recordPaymongoRefund, announce, tellAdmins, fail
};
