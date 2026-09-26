/**
 * PayMongo, from the server.                            DFD: P10 → PayMongo
 *
 * The raw client: Checkout Sessions (GCash), reading them back, refunds, and
 * webhook signature verification. Money decisions are not made here: the
 * amount, the fee and the payee come from begin_payment() in the database,
 * and whether a payment counts is decided by record_capture().
 *
 * GCash is a PayMongo payment METHOD. There is no separate GCash key:
 * FurnishAR authenticates to PayMongo with PayMongo's keys and asks for
 * payment_method_types ["gcash"].
 *
 * AS DOCUMENTED BY PAYMONGO (re-check before live; docs/PAYMONGO-GCASH-INTEGRATION.md §8):
 *   Base URL      https://api.paymongo.com
 *   Auth          HTTP Basic, the SECRET key as the user name, empty password
 *   Checkout      POST /v1/checkout_sessions → data.id (cs_…), data.attributes.checkout_url
 *                 GET  /v1/checkout_sessions/{id} (secret key) → attributes.payments[]
 *   Amounts       integers in centavos (₱499.00 = 49900) — lib/money.js
 *   Refunds       POST /v1/refunds { amount, payment_id, reason, notes }
 *   Webhooks      header Paymongo-Signature: t=<unix>,te=<test sig>,li=<live sig>
 *                 sig = HMAC-SHA256(webhook secret, `${t}.${raw body}`)
 *   Events used   checkout_session.payment.paid, payment.paid, payment.failed,
 *                 payment.refunded, payment.refund.updated
 *   Split         attributes.split_payment { transfer_to, recipients[{ merchant_id,
 *                 split_type, value }] } — only with Split Payments activated
 *                 and a configured merchant relationship.
 *
 * Environment (server only; none of these is ever NEXT_PUBLIC_):
 *   PAYMONGO_ENV            test (default) | live — live must be set on purpose
 *   PAYMONGO_SECRET_KEY     sk_test_… / sk_live_…
 *   PAYMONGO_PUBLIC_KEY     pk_test_… / pk_live_… (checked only; the hosted
 *                           checkout needs no key in the browser)
 *   PAYMONGO_WEBHOOK_SECRET the webhook's own signing secret (whsk_…)
 *   PAYMONGO_GCASH_ENABLED  true once GCash is activated on the PayMongo account
 *   PAYMONGO_SPLIT_MODE     disabled (default) | accrual | split
 */
const crypto = require('node:crypto');
const { phpToCentavos, centavosToPhp } = require('./money.js');

const BASE = 'https://api.paymongo.com';
const SPLIT_MODES = ['disabled', 'accrual', 'split'];
const SIGNATURE_TOLERANCE_SECONDS = 300;

const env = name => String(process.env[name] || '').trim();

function credentials() {
  const raw = env('PAYMONGO_ENV').toLowerCase();
  // Anything but an explicit "live" is test: never switch to live silently.
  const mode = raw === 'live' ? 'live' : 'test';
  // PAYMONGO_API_BASE points the server at a stand-in PayMongo for
  // scripts/check-billing.mjs. Only a local address is accepted, so a stray
  // setting can never send real keys somewhere else.
  const override = env('PAYMONGO_API_BASE');
  const local = /^http:\/\/(127\.0\.0\.1|localhost)(:\d+)?$/.test(override);
  return {
    mode,
    rawEnv: raw,
    env: mode === 'live' ? 'live' : 'sandbox',   // the database's environment names
    base: local ? override : BASE,
    secretKey: env('PAYMONGO_SECRET_KEY'),
    publicKey: env('PAYMONGO_PUBLIC_KEY'),
    webhookSecret: env('PAYMONGO_WEBHOOK_SECRET'),
    gcashEnabled: env('PAYMONGO_GCASH_ENABLED').toLowerCase() === 'true',
    rawSplit: env('PAYMONGO_SPLIT_MODE').toLowerCase()
  };
}

/** What is configured and what is not, in words an admin can act on. No secrets. */
function validateConfig() {
  const c = credentials();
  const problems = [];
  const warnings = [];
  if (c.rawEnv && !['test', 'live'].includes(c.rawEnv)) {
    problems.push(`PAYMONGO_ENV is "${c.rawEnv}"; it must be "test" or "live". Using test.`);
  }
  const want = c.mode === 'live' ? 'live' : 'test';
  let keysOk = Boolean(c.secretKey);
  if (!c.secretKey) problems.push('PAYMONGO_SECRET_KEY is not set.');
  else if (!c.secretKey.startsWith(`sk_${want}_`)) {
    keysOk = false;
    problems.push(c.secretKey.startsWith('pk_')
      ? 'PAYMONGO_SECRET_KEY holds a public key (pk_…); use the secret key (sk_…).'
      : `PAYMONGO_SECRET_KEY is not a ${want} secret key (sk_${want}_…). PAYMONGO_ENV is ${c.mode}.`);
  }
  if (c.publicKey && !c.publicKey.startsWith(`pk_${want}_`)) {
    keysOk = false;
    problems.push(`PAYMONGO_PUBLIC_KEY is not a ${want} public key (pk_${want}_…).`);
  }
  if (!c.webhookSecret) problems.push('PAYMONGO_WEBHOOK_SECRET is not set: payments could not be confirmed by webhook.');
  if (!c.gcashEnabled) warnings.push('PAYMONGO_GCASH_ENABLED is not true: GCash is not offered until it is activated on the PayMongo account.');

  let splitMode = c.rawSplit || 'disabled';
  if (!SPLIT_MODES.includes(splitMode)) {
    problems.push(`PAYMONGO_SPLIT_MODE is "${c.rawSplit}"; it must be disabled, accrual or split. Using disabled.`);
    splitMode = 'disabled';
  }
  const configured = keysOk && Boolean(c.webhookSecret);
  return {
    env: c.env,
    mode: c.mode,
    sandbox: c.mode !== 'live',
    configured,
    gcashEnabled: configured && c.gcashEnabled,
    splitMode,
    splitEnabled: configured && splitMode === 'split',
    webhooks: Boolean(c.webhookSecret),
    problems,
    warnings
  };
}

/** Ready to offer GCash: valid keys for the mode, a webhook secret, GCash activated. */
function isReady() {
  return validateConfig().gcashEnabled;
}

function basicAuth(key) {
  return `Basic ${Buffer.from(`${key}:`).toString('base64')}`;
}

/** One PayMongo call with the secret key. Throws with .status and .issue; never logs a key. */
async function call(path, { method = 'GET', body, fetchImpl = fetch } = {}) {
  const c = credentials();
  if (!c.secretKey) {
    throw Object.assign(new Error('PayMongo is not configured.'), { code: 'payments_unavailable' });
  }
  const response = await fetchImpl(`${c.base}${path}`, {
    method,
    headers: {
      Authorization: basicAuth(c.secretKey),
      Accept: 'application/json',
      ...(body ? { 'Content-Type': 'application/json' } : {})
    },
    body: body ? JSON.stringify(body) : undefined
  });
  const text = await response.text();
  let data = null;
  try { data = text ? JSON.parse(text) : null; } catch { data = null; }
  if (!response.ok) {
    const error = new Error(`PayMongo ${method} ${path.split('/').slice(0, 3).join('/')} answered ${response.status}`);
    error.status = response.status;
    error.issue = String(data?.errors?.[0]?.code || 'UNKNOWN').slice(0, 60);
    if (response.status === 401 || response.status === 403) error.code = 'payments_unavailable';
    throw error;
  }
  return data;
}

/**
 * Creates a hosted GCash checkout. `lines` are [{ name, amount }] in pesos,
 * straight from the database (the piece and FurnishAR's fee, shown to the
 * buyer as what they are). `split` is PayMongo's split_payment object, only
 * when Split Payments is activated for FurnishAR.
 */
async function createCheckoutSession({ reference, lines, description, successUrl, cancelUrl, metadata = {}, split = null }, fetchImpl) {
  const body = {
    data: {
      attributes: {
        line_items: lines.filter(line => phpToCentavos(line.amount) > 0).map(line => ({
          name: String(line.name).slice(0, 120),
          amount: phpToCentavos(line.amount),
          currency: 'PHP',
          quantity: 1
        })),
        payment_method_types: ['gcash'],
        success_url: successUrl,
        cancel_url: cancelUrl,
        reference_number: reference,
        description: String(description || 'FurnishAR order').slice(0, 255),
        send_email_receipt: false,
        show_description: true,
        show_line_items: true,
        metadata: Object.fromEntries(Object.entries(metadata).map(([k, v]) => [k, String(v)])),
        ...(split ? { split_payment: split } : {})
      }
    }
  };
  const data = await call('/v1/checkout_sessions', { method: 'POST', body, fetchImpl });
  const id = data?.data?.id;
  const checkoutUrl = data?.data?.attributes?.checkout_url;
  if (!id || !checkoutUrl) throw Object.assign(new Error('PayMongo did not return a checkout.'), { issue: 'NO_CHECKOUT' });
  return { id, checkoutUrl };
}

/** A checkout session, with its payments (secret key only). */
async function getCheckoutSession(id, fetchImpl) {
  const data = await call(`/v1/checkout_sessions/${encodeURIComponent(id)}`, { fetchImpl });
  return data?.data || null;
}

/** Refunds part or all of a PayMongo payment. `amount` in pesos. */
async function createRefund({ paymentId, amount, reason = 'requested_by_customer', notes }, fetchImpl) {
  const data = await call('/v1/refunds', {
    method: 'POST',
    fetchImpl,
    body: { data: { attributes: {
      amount: phpToCentavos(amount), payment_id: paymentId, reason,
      ...(notes ? { notes: String(notes).slice(0, 255) } : {})
    } } }
  });
  return summariseRefund(data?.data);
}

/* ------------------------------------------------------------ reading --- */

const centavos = value => (Number.isSafeInteger(Number(value)) ? centavosToPhp(Number(value)) : null);

/** The facts FurnishAR acts on, from a PayMongo payment resource. */
function summarisePayment(payment) {
  if (!payment || typeof payment !== 'object') return null;
  const a = payment.attributes || {};
  const status = String(a.status || '').toLowerCase();
  return {
    paymentId: payment.id ? String(payment.id) : null,
    status,
    paid: status === 'paid',
    failed: status === 'failed',
    amount: centavos(a.amount),               // pesos, "11000.00"
    fee: centavos(a.fee),                     // PayMongo's processing fee, when reported
    netAmount: centavos(a.net_amount),
    currency: String(a.currency || '').toUpperCase() || null,
    method: a.source?.type ? String(a.source.type).toLowerCase() : null,
    livemode: a.livemode === true,
    payerEmail: a.billing?.email || null
  };
}

/** A checkout session reduced to what settles an attempt. */
function summariseSession(session) {
  if (!session || typeof session !== 'object') return null;
  const a = session.attributes || {};
  return {
    id: session.id ? String(session.id) : null,
    reference: a.reference_number ? String(a.reference_number) : null,
    status: String(a.status || '').toLowerCase(),   // active | expired | …
    payments: (Array.isArray(a.payments) ? a.payments : []).map(summarisePayment).filter(Boolean),
    metadata: a.metadata || {}
  };
}

function summariseRefund(refund) {
  if (!refund || typeof refund !== 'object') return null;
  const a = refund.attributes || {};
  return {
    refundId: refund.id ? String(refund.id) : null,
    paymentId: a.payment_id ? String(a.payment_id) : null,
    status: String(a.status || '').toLowerCase(),    // pending | succeeded | failed
    amount: centavos(a.amount),
    currency: String(a.currency || 'PHP').toUpperCase()
  };
}

/* ----------------------------------------------------------- webhooks --- */

/**
 * Verifies Paymongo-Signature against the RAW body. Test events are signed in
 * `te`, live events in `li`; the one that must match is the server's mode, so
 * a test event can never settle a live order or the reverse. Rejects stale
 * timestamps (replays).
 */
function verifyWebhookSignature(rawBody, header, { secret = credentials().webhookSecret, mode = credentials().mode, now = Date.now() } = {}) {
  if (!secret || !header || typeof rawBody !== 'string') return false;
  const parts = Object.fromEntries(String(header).split(',').map(kv => {
    const i = kv.indexOf('=');
    return i > 0 ? [kv.slice(0, i).trim(), kv.slice(i + 1).trim()] : [kv.trim(), ''];
  }));
  const t = Number(parts.t);
  const given = mode === 'live' ? parts.li : parts.te;
  if (!Number.isFinite(t) || !given || !/^[0-9a-f]{64}$/i.test(given)) return false;
  if (Math.abs(now / 1000 - t) > SIGNATURE_TOLERANCE_SECONDS) return false;
  const expected = crypto.createHmac('sha256', secret).update(`${parts.t}.${rawBody}`).digest('hex');
  return crypto.timingSafeEqual(Buffer.from(expected, 'hex'), Buffer.from(given.toLowerCase(), 'hex'));
}

/** A webhook event, reduced: id, type, livemode, and the resource it is about. */
function parseEvent(json) {
  const event = json?.data;
  const a = event?.attributes || {};
  return {
    id: event?.id ? String(event.id) : null,
    type: a.type ? String(a.type) : null,
    livemode: a.livemode === true,
    resource: a.data || null
  };
}

module.exports = {
  BASE, validateConfig, isReady, credentials, createCheckoutSession, getCheckoutSession, createRefund,
  summarisePayment, summariseSession, summariseRefund, verifyWebhookSignature, parseEvent
};
