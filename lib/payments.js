/**
 * The shop's PayPal seller connection, PayPal webhooks and payment-setup
 * reminders.                                             DFD: P7 → P10, PayPal
 *
 *   POST /api/sb/payments/connect   owner: start PayPal Partner Referrals
 *   POST /api/sb/payments/refresh   owner: re-read the seller's status FROM PAYPAL
 *   GET  /api/sb/payments/admin     admin: the deployment's PayPal configuration
 *   POST /api/paypal/webhook        PayPal: signed events, processed once
 *   GET  /api/cron/payment-reminders  the scheduler: due reminders, with cooldown
 *
 * A seller's status is only ever what PayPal says. The query string PayPal
 * appends to the return URL (merchantIdInPayPal, permissionsGranted…) is a
 * hint that onboarding finished and is not believed: the server asks PayPal
 * for the merchant id behind OUR tracking id and reads that merchant's
 * integration itself.
 *
 * Google identity is not involved here. A shop's PayPal account is where it is
 * paid, never who it is: the owner is authorised as a store member (0001),
 * not by any PayPal email.
 */
const crypto = require('node:crypto');
const { serverCredentials, callSupabase } = require('./supabase-proxy.js');
const { isPlatformAdmin } = require('./auth.js');
const { rpc, serverRpc, serverSecretReady } = require('./server-db.js');
const paypal = require('./paypal.js');
const notify = require('./notify.js');
const orders = require('./orders.js');

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const PROBLEM = new Set(['ERROR', 'LIMITED', 'DISABLED', 'PAYMENTS_NEED_ATTENTION']);
const { fail } = orders;

async function send(event, data, site) {
  try {
    await Promise.all(notify.messagesFor(event, data, site).map(message => notify.sendEmail(message)));
  } catch (error) {
    console.error(`[payments] could not send "${event}": ${error.message}`);
  }
}

/** Emails for a change in a seller's status, once per change. */
async function announceStatus(storeId, before, after, detail, site) {
  if (!storeId || before === after) return;
  const config = paypal.validateConfig();
  try {
    const contacts = await serverRpc('server_store_contacts', { p_store: storeId });
    if (after === 'CONNECTED') {
      await send('paypal_connected', { ...contacts, sandbox: config.sandbox }, site);
    } else if (PROBLEM.has(after)) {
      const admins = await serverRpc('server_admin_emails', {}).catch(() => []);
      await send('paypal_connection_problem', { ...contacts, status: after, detail, admin_emails: admins, sandbox: config.sandbox }, site);
    }
  } catch (error) {
    console.error(`[payments] status email failed: ${error.message}`);
  }
}

/** The owner's own row, read under RLS: nobody else's is returned. */
async function ownAccount(ctx, storeId, environment) {
  const { url, key } = serverCredentials();
  const response = await callSupabase(
    `${url}/rest/v1/store_payment_accounts?store_id=eq.${encodeURIComponent(storeId)}&environment=eq.${environment}`
    + '&select=store_id,tracking_id,merchant_id,onboarding_status',
    { headers: { apikey: key, Authorization: `Bearer ${ctx.token}`, Accept: 'application/json' } });
  if (!response.ok) return null;
  const rows = await response.json().catch(() => []);
  return rows?.[0] || null;
}

/** Reads a seller's status from PayPal and records it. Returns the new row facts. */
async function syncSeller({ storeId = null, trackingId = null, merchantId = null, site, token = null }) {
  const config = paypal.validateConfig();
  let merchant = merchantId;
  if (!merchant && trackingId) merchant = await paypal.findMerchantByTracking(trackingId);
  const status = merchant
    ? paypal.sellerStatus(await paypal.merchantIntegration(merchant))
    : paypal.sellerStatus(null);
  const recorded = await serverRpc('server_record_payment_account', {
    p_env: config.env, p_store: storeId, p_tracking_id: trackingId, p_merchant_id: merchant || null,
    p_status: status.status, p_receivable: status.receivable, p_email_confirmed: status.emailConfirmed,
    p_partner_fee: status.partnerFee, p_detail: status.detail
  }, token);
  if (recorded?.found) {
    const detail = recorded.conflict ? 'This PayPal account is already connected to another store.' : status.detail;
    await announceStatus(recorded.store_id, recorded.before, recorded.status, detail, site);
  }
  return { ...status, status: recorded?.status || status.status, conflict: Boolean(recorded?.conflict) };
}

function requireSellerOnboarding() {
  const config = paypal.validateConfig();
  if (!config.onboarding || !serverSecretReady()) {
    throw fail(503, 'Connecting PayPal is not switched on for this site yet.', 'onboarding_unconfigured');
  }
  return config;
}

const STORE_ACTIONS = {
  /** Start (or restart) PayPal onboarding for a store this account owns. */
  async connect(ctx, body) {
    if (!UUID.test(String(body.storeId || ''))) throw fail(400, 'Unknown shop.');
    const config = requireSellerOnboarding();
    const trackingId = `fa-${body.storeId}-${crypto.randomBytes(6).toString('hex')}`;
    // Membership is checked by the database before anything goes to PayPal.
    await serverRpc('server_payment_onboarding_started', {
      p_store: body.storeId, p_env: config.env, p_tracking_id: trackingId
    }, ctx.token);
    const referral = await paypal.createPartnerReferral({
      trackingId,
      returnUrl: `${ctx.site}/portal?paypal_onboarding=return#billing`,
      partnerFee: config.feeModeConfigured === 'platform_split'
    }).catch(() => {
      throw fail(502, "PayPal couldn't start the connection. Please try again in a moment.");
    });
    return { actionUrl: referral.actionUrl, environment: config.env };
  },

  /** Re-read this store's seller status from PayPal (after the return, or on demand). */
  async refresh(ctx, body) {
    if (!UUID.test(String(body.storeId || ''))) throw fail(400, 'Unknown shop.');
    const config = requireSellerOnboarding();
    const own = await ownAccount(ctx, body.storeId, config.env);
    if (!own) throw fail(404, 'Start connecting PayPal first.');
    const result = await syncSeller({
      storeId: body.storeId, trackingId: own.tracking_id, merchantId: own.merchant_id,
      site: ctx.site, token: ctx.token
    }).catch(error => {
      if (error.status && error.status < 500 && !error.issue) throw error;
      throw fail(502, "We couldn't reach PayPal to check your account. Please try again.");
    });
    return { status: result.status, detail: result.detail, ready: result.status === 'CONNECTED' && !result.conflict };
  }
};

async function handlePayments(req, action, body, site) {
  if (action === 'admin' && req.method === 'GET') {
    const auth = await orders.authenticate(req);
    if (auth.error) return auth.error;
    const { url, key, token } = auth.ctx;
    if (!await isPlatformAdmin({ url, key, token, call: callSupabase })) {
      return { status: 403, body: { error: 'This is limited to platform administrators.' } };
    }
    return { status: 200, body: orders.billingConfig({ admin: true }) };
  }
  if (req.method !== 'POST' || !Object.hasOwn(STORE_ACTIONS, action)) {
    return { status: 404, body: { error: 'Unknown endpoint.' } };
  }
  const auth = await orders.authenticate(req);
  if (auth.error) return auth.error;
  try {
    return { status: 200, body: await STORE_ACTIONS[action]({ ...auth.ctx, site }, body || {}) };
  } catch (error) {
    if (error.upstream) throw error;
    return { status: error.status || 500, body: { error: error.message, ...(error.code ? { code: error.code } : {}) } };
  }
}

/* ------------------------------------------------------------ webhooks --- */

/** The capture id a refund belongs to, from its `up` link. */
function captureIdOfRefund(resource) {
  const up = (resource?.links || []).find(link => link.rel === 'up');
  const match = /\/captures\/([A-Z0-9]+)/.exec(up?.href || '');
  return match ? match[1] : null;
}

function sumFees(list) {
  if (!Array.isArray(list) || !list.length) return null;
  return Math.round(list.reduce((sum, f) => sum + Number(f?.amount?.value || 0), 0) * 100) / 100;
}

/** A capture event: re-read the whole PayPal order, never trust the event body alone. */
async function onCapture(event, site) {
  const resource = event.resource || {};
  const paypalOrderId = resource.supplementary_data?.related_ids?.order_id;
  if (!paypalOrderId) return 'no related order';
  const attempt = await serverRpc('server_payment_attempt', { p_provider_order: paypalOrderId });
  if (!attempt) return 'not a FurnishAR payment';

  if (event.event_type === 'PAYMENT.CAPTURE.PENDING') {
    await serverRpc('server_update_payment_attempt', { p_provider_order: paypalOrderId, p_status: 'PENDING', p_capture: resource.id, p_reason: resource.status_details?.reason || null });
    return 'pending';
  }
  if (event.event_type === 'PAYMENT.CAPTURE.DENIED' || event.event_type === 'PAYMENT.CAPTURE.DECLINED') {
    await serverRpc('server_update_payment_attempt', { p_provider_order: paypalOrderId, p_status: 'DECLINED', p_capture: resource.id, p_reason: event.event_type });
    await orders.announce({ site }, attempt.order_id, 'payment_failed');
    return 'declined';
  }

  const facts = paypal.summarise(await paypal.getOrder(paypalOrderId));
  const capture = facts.captureId === resource.id ? facts : { ...facts, captureId: null };
  if (!orders.matchesAttempt(capture, attempt) || capture.captureStatus !== 'COMPLETED' || !capture.captureId) {
    return 'does not match the attempt';
  }
  const recorded = await orders.recordCompletedCapture({ site }, capture, attempt);
  return recorded.duplicate ? 'already recorded' : `recorded (${recorded.status})`;
}

async function onRefund(event, site) {
  const resource = event.resource || {};
  const reversal = event.event_type === 'PAYMENT.CAPTURE.REVERSED';
  const captureId = reversal ? (captureIdOfRefund(resource) || resource.id) : captureIdOfRefund(resource);
  if (!captureId || !resource.id || !resource.amount) return 'no capture';
  const status = reversal ? 'COMPLETED' : String(resource.status || 'COMPLETED').toUpperCase();
  const recorded = await serverRpc('server_record_refund', {
    p_capture: captureId,
    p_refund: resource.id,
    p_amount: Number(resource.amount.value),
    p_currency: resource.amount.currency_code,
    p_fee_refunded: sumFees(resource.seller_payable_breakdown?.platform_fees),
    p_status: ['COMPLETED', 'PENDING', 'FAILED', 'CANCELLED'].includes(status) ? status : 'PENDING',
    p_kind: reversal ? 'reversal' : 'refund'
  });
  if (recorded?.duplicate) return 'already recorded';
  if (!recorded?.found && !recorded?.recorded) return 'unknown capture';
  if (recorded.completed) {
    await orders.announce({ site }, recorded.order_id, 'refund_completed', {
      refund_amount: recorded.amount, refund_platform_fee: recorded.platform_fee_refunded
    });
  }
  return `refund ${recorded.completed ? 'recorded' : 'pending'}`;
}

async function onSeller(event, site) {
  const resource = event.resource || {};
  const merchantId = resource.merchant_id || resource.merchantId || null;
  const trackingId = resource.tracking_id || null;
  if (!merchantId && !trackingId) return 'no merchant';
  if (event.event_type === 'MERCHANT.PARTNER-CONSENT.REVOKED') {
    const config = paypal.validateConfig();
    const recorded = await serverRpc('server_record_payment_account', {
      p_env: config.env, p_store: null, p_tracking_id: trackingId, p_merchant_id: merchantId,
      p_status: 'ERROR', p_receivable: false, p_email_confirmed: false, p_partner_fee: false,
      p_detail: 'The permissions given to FurnishAR were revoked in PayPal. Connect PayPal again.'
    });
    if (recorded?.found) await announceStatus(recorded.store_id, recorded.before, 'ERROR', 'The permissions given to FurnishAR were revoked in PayPal.', site);
    return 'consent revoked';
  }
  const result = await syncSeller({ trackingId, merchantId, site });
  return `seller ${result.status}`;
}

const WEBHOOK_HANDLERS = {
  'PAYMENT.CAPTURE.COMPLETED': onCapture,
  'PAYMENT.CAPTURE.PENDING': onCapture,
  'PAYMENT.CAPTURE.DENIED': onCapture,
  'PAYMENT.CAPTURE.DECLINED': onCapture,
  'PAYMENT.CAPTURE.REFUNDED': onRefund,
  'PAYMENT.CAPTURE.REVERSED': onRefund,
  'MERCHANT.ONBOARDING.COMPLETED': onSeller,
  'MERCHANT.PARTNER-CONSENT.REVOKED': onSeller,
  'CUSTOMER.MERCHANT-INTEGRATION.CAPABILITY-UPDATED': onSeller,
  'CUSTOMER.MERCHANT-INTEGRATION.SELLER-EMAIL-CONFIRMED': onSeller,
  'CUSTOMER.MERCHANT-INTEGRATION.PRODUCT-SUBSCRIPTION-UPDATED': onSeller
};

/**
 * One webhook delivery. 200 means "do not send it again": verified and
 * processed, a duplicate, or a type we do not act on. 400 is an unverified
 * delivery. 500 asks PayPal to retry (the claim expires after ten minutes).
 */
async function handleWebhook(headers, rawBody, site) {
  if (!paypal.isConfigured() || !serverSecretReady()) return { status: 503, body: { error: 'Payments are not configured.' } };
  let event;
  try { event = JSON.parse(rawBody); } catch { return { status: 400, body: { error: 'Not JSON.' } }; }
  if (!event?.id || !event?.event_type) return { status: 400, body: { error: 'Not a PayPal event.' } };

  if (!await paypal.verifyWebhookSignature(headers, event)) {
    console.warn(`[paypal] webhook ${String(event.event_type).slice(0, 60)} failed signature verification`);
    return { status: 400, body: { error: 'Signature not verified.' } };
  }

  const handler = WEBHOOK_HANDLERS[event.event_type];
  const config = paypal.validateConfig();
  const claimed = await serverRpc('server_claim_webhook_event', {
    p_event_id: String(event.id).slice(0, 100), p_type: String(event.event_type).slice(0, 100),
    p_resource: String(event.resource?.id || '').slice(0, 100) || null, p_env: config.env
  });
  if (!claimed) return { status: 200, body: { duplicate: true } };

  try {
    const outcome = handler ? await handler(event, site) : 'ignored';
    await serverRpc('server_finish_webhook_event', { p_event_id: String(event.id).slice(0, 100), p_outcome: outcome });
    return { status: 200, body: { ok: true, outcome } };
  } catch (error) {
    // Not finished: PayPal retries, and the claim can be taken again later.
    console.error(`[paypal] webhook ${event.event_type} failed: ${error.message}`);
    return { status: 500, body: { error: 'Processing failed; PayPal will retry.' } };
  }
}

/* ----------------------------------------------------------- reminders --- */

function reminderSchedule() {
  const hours = Number(process.env.PAYPAL_REMINDER_COOLDOWN_HOURS || 72);
  const max = Number(process.env.PAYPAL_REMINDER_MAX || 3);
  return {
    cooldownHours: Number.isFinite(hours) && hours >= 1 ? Math.round(hours) : 72,
    maxCount: Number.isFinite(max) && max >= 0 ? Math.round(max) : 3
  };
}

/**
 * Emails every approved store that still cannot take payments and is due a
 * reminder. Server-side only (the cron route); a page load never sends one.
 * A reminder counts only when it was actually sent, so an email outage does
 * not use up the cap.
 */
async function sendPaymentReminders(site) {
  if (!serverSecretReady()) return { sent: 0, skipped: 'unconfigured' };
  const config = paypal.validateConfig();
  const { cooldownHours, maxCount } = reminderSchedule();
  const due = await serverRpc('server_stores_needing_payment_setup', {
    p_env: config.env, p_cooldown_hours: cooldownHours, p_max_count: maxCount
  }) || [];
  let sent = 0;
  for (const store of due) {
    const contacts = await serverRpc('server_store_contacts', { p_store: store.store_id });
    const results = await Promise.all(notify.messagesFor('paypal_connection_required',
      { ...contacts, sandbox: config.sandbox }, site).map(message => notify.sendEmail(message)));
    if (results.some(result => result.sent)) {
      await serverRpc('server_mark_payment_reminder', { p_store: store.store_id, p_env: config.env });
      sent += 1;
    }
  }
  return { due: due.length, sent, cooldownHours, maxCount };
}

module.exports = {
  handlePayments, handleWebhook, sendPaymentReminders, syncSeller, reminderSchedule,
  captureIdOfRefund, STORE_ACTIONS, WEBHOOK_HANDLERS
};
