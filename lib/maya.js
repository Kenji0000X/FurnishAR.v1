/**
 * Maya Checkout, from the server.                           DFD: P10 → Maya
 *
 * The raw client: create a hosted checkout, and read payments back. Money
 * decisions are not made here — the amount, the fee and the payee come from
 * begin_payment() in the database, and whether a payment counts is decided
 * by record_capture(). This file only talks to Maya.
 *
 * AS DOCUMENTED BY MAYA (developers.maya.ph), to be re-checked before live:
 *   Base URLs     sandbox     https://pg-sandbox.paymaya.com
 *                 production  https://pg.paymaya.com
 *   Auth          HTTP Basic, the API key as the user name, empty password.
 *                 Create Checkout uses the PUBLIC key; reading a payment
 *                 uses the SECRET key.
 *   Checkout      POST /checkout/v1/checkouts  → { checkoutId, redirectUrl }
 *   Payment       GET  /payments/v1/payments/{paymentId}
 *                 GET  /payments/v1/payment-rrns/{requestReferenceNumber}
 *   Webhooks      the body is the payment resource; Maya retries on non-2xx
 *                 (up to four attempts). They are not signed, so a webhook
 *                 is only a prompt: the payment is always re-read here with
 *                 the secret key before anything is recorded.
 *   PayFac        metadata.subMerchantRequestReferenceNumber and metadata.pf
 *                 { smi, smn, mci, mpc, mco }, only when Maya has enabled
 *                 Payment Facilitator for the account.
 * This session could not open Maya's documentation directly (blocked by the
 * network policy); docs/MAYA-INTEGRATION.md lists each name to confirm.
 *
 * Environment (server only; none of these is ever a NEXT_PUBLIC_ variable):
 *   MAYA_ENV              sandbox (default) | production
 *   MAYA_PUBLIC_KEY       Maya's public API key for that environment
 *   MAYA_SECRET_KEY       Maya's secret API key for that environment
 *   MAYA_PAYFAC_ENABLED   true only once Maya has enabled PayFac (default false)
 *   MAYA_FEE_MODE         PayFac only: accrual (default) | provider_settlement
 *   MAYA_WEBHOOK_ALLOWED_IPS  optional: comma-separated source addresses
 *                         Maya publishes for webhooks; others are refused
 */

const BASES = {
  sandbox: 'https://pg-sandbox.paymaya.com',
  production: 'https://pg.paymaya.com'
};
const PAYFAC_FEE_MODES = ['accrual', 'provider_settlement'];

const env = name => String(process.env[name] || '').trim();

function credentials() {
  const raw = env('MAYA_ENV').toLowerCase();
  const mayaEnv = raw === 'production' ? 'production' : 'sandbox';
  // MAYA_API_BASE points the server at a stand-in Maya for
  // scripts/check-maya.mjs. Only a local address is accepted, so a stray
  // setting can never send real keys somewhere else.
  const override = env('MAYA_API_BASE');
  const local = /^http:\/\/(127\.0\.0\.1|localhost)(:\d+)?$/.test(override);
  return {
    mayaEnv,
    // The database's environment names (store_payment_accounts.environment).
    env: mayaEnv === 'production' ? 'live' : 'sandbox',
    base: local ? override : BASES[mayaEnv],
    publicKey: env('MAYA_PUBLIC_KEY'),
    secretKey: env('MAYA_SECRET_KEY'),
    payfac: env('MAYA_PAYFAC_ENABLED').toLowerCase() === 'true',
    rawFeeMode: env('MAYA_FEE_MODE').toLowerCase(),
    allowedIps: env('MAYA_WEBHOOK_ALLOWED_IPS').split(',').map(v => v.trim()).filter(Boolean)
  };
}

/** What is configured and what is not, in words an admin can act on. No secrets. */
function validateConfig() {
  const c = credentials();
  const problems = [];
  const warnings = [];
  const raw = env('MAYA_ENV').toLowerCase();
  if (raw && !['sandbox', 'production'].includes(raw)) {
    problems.push(`MAYA_ENV is "${raw}"; it must be "sandbox" or "production". Using sandbox.`);
  }
  if (!c.publicKey || !c.secretKey) problems.push('MAYA_PUBLIC_KEY and MAYA_SECRET_KEY are required for Maya payments.');
  if (c.publicKey && /^sk-/.test(c.publicKey)) problems.push('MAYA_PUBLIC_KEY looks like a secret key (sk-…).');
  if (c.secretKey && /^pk-/.test(c.secretKey)) problems.push('MAYA_SECRET_KEY looks like a public key (pk-…).');

  let payfacFeeMode = c.rawFeeMode || 'accrual';
  if (!PAYFAC_FEE_MODES.includes(payfacFeeMode)) {
    problems.push(`MAYA_FEE_MODE is "${c.rawFeeMode}"; it must be "accrual" or "provider_settlement". Using accrual.`);
    payfacFeeMode = 'accrual';
  }
  if (!c.payfac && c.rawFeeMode) {
    warnings.push('MAYA_FEE_MODE only applies to Payment Facilitator stores, and MAYA_PAYFAC_ENABLED is not true.');
  }
  if (!c.allowedIps.length) {
    warnings.push('MAYA_WEBHOOK_ALLOWED_IPS is not set. Webhooks are still verified by re-reading each payment from Maya.');
  }
  return {
    env: c.env,
    mayaEnv: c.mayaEnv,
    sandbox: c.mayaEnv !== 'production',
    configured: Boolean(c.publicKey && c.secretKey),
    payfac: c.payfac,
    payfacFeeMode,
    webhooks: true,
    problems,
    warnings
  };
}

function isConfigured() {
  const c = credentials();
  return Boolean(c.publicKey && c.secretKey);
}

function basicAuth(key) {
  return `Basic ${Buffer.from(`${key}:`).toString('base64')}`;
}

/** One Maya call. Throws an error with .status and .issue; never logs a key. */
async function call(path, { method = 'GET', body, key = 'secret', fetchImpl = fetch } = {}) {
  const c = credentials();
  const token = key === 'public' ? c.publicKey : c.secretKey;
  if (!token) {
    const error = new Error('Maya is not configured.');
    error.code = 'payments_unavailable';
    throw error;
  }
  const response = await fetchImpl(`${c.base}${path}`, {
    method,
    headers: {
      Authorization: basicAuth(token),
      Accept: 'application/json',
      ...(body ? { 'Content-Type': 'application/json' } : {})
    },
    body: body ? JSON.stringify(body) : undefined
  });
  const text = await response.text();
  let data = null;
  try { data = text ? JSON.parse(text) : null; } catch { data = null; }
  if (!response.ok) {
    const error = new Error(`Maya ${method} ${path.split('/').slice(0, 4).join('/')} answered ${response.status}`);
    error.status = response.status;
    error.issue = String(data?.code || data?.error || 'UNKNOWN').slice(0, 60);
    if (response.status === 401 || response.status === 403) error.code = 'payments_unavailable';
    throw error;
  }
  return data;
}

const peso = value => Math.round(Number(value) * 100) / 100;

/**
 * Creates a hosted Maya checkout for one stage of an order. Every amount is
 * the database's (begin_payment). `payfac` is { submerchantId, name, city,
 * postal, country } only for a PayFac store; otherwise the payment settles to
 * the merchant that owns the keys (FurnishAR).
 */
async function createCheckout({
  reference, amount, platformFee, currency = 'PHP', description, buyer = {},
  returnUrls, payfac = null
}, fetchImpl) {
  const total = peso(amount);
  const fee = peso(platformFee);
  const body = {
    totalAmount: {
      value: total,
      currency,
      // The service fee is shown to the buyer as what it is.
      details: { subtotal: peso(total - fee), serviceCharge: fee }
    },
    buyer: {
      ...(buyer.firstName ? { firstName: String(buyer.firstName).slice(0, 60) } : {}),
      ...(buyer.lastName ? { lastName: String(buyer.lastName).slice(0, 60) } : {}),
      ...(buyer.email ? { contact: { email: String(buyer.email).slice(0, 254) } } : {})
    },
    items: [{
      name: String(description || 'FurnishAR order').slice(0, 120),
      quantity: 1,
      code: reference,
      amount: { value: total },
      totalAmount: { value: total }
    }],
    redirectUrl: {
      success: returnUrls.success,
      failure: returnUrls.failure,
      cancel: returnUrls.cancel
    },
    requestReferenceNumber: reference,
    metadata: payfac
      ? {
          subMerchantRequestReferenceNumber: reference,
          pf: {
            smi: payfac.submerchantId,
            smn: String(payfac.name || '').slice(0, 60),
            mci: payfac.city,
            mpc: payfac.postal,
            mco: payfac.country || 'PHL'
          }
        }
      : { source: 'furnishar' }
  };
  const data = await call('/checkout/v1/checkouts', { method: 'POST', body, key: 'public', fetchImpl });
  if (!data?.checkoutId || !data?.redirectUrl) {
    const error = new Error('Maya did not return a checkout.');
    error.issue = 'NO_CHECKOUT';
    throw error;
  }
  return { checkoutId: data.checkoutId, redirectUrl: data.redirectUrl };
}

function getPayment(paymentId, fetchImpl) {
  return call(`/payments/v1/payments/${encodeURIComponent(paymentId)}`, { fetchImpl });
}

/** Every payment Maya has for one of FurnishAR's references. */
async function paymentsForReference(reference, fetchImpl) {
  const data = await call(`/payments/v1/payment-rrns/${encodeURIComponent(reference)}`, { fetchImpl });
  return Array.isArray(data) ? data : data ? [data] : [];
}

/**
 * The facts FurnishAR acts on, from a Maya payment resource. `paid` is true
 * only for PAYMENT_SUCCESS with isPaid — Maya's own statuses, not ours.
 */
function summarise(payment) {
  if (!payment || typeof payment !== 'object') return null;
  const status = String(payment.status || payment.paymentStatus || '').toUpperCase();
  const amount = payment.amount ?? payment.totalAmount?.value ?? payment.totalAmount?.amount;
  return {
    paymentId: payment.id ? String(payment.id) : null,
    reference: payment.requestReferenceNumber ? String(payment.requestReferenceNumber) : null,
    status,
    paid: status === 'PAYMENT_SUCCESS' && payment.isPaid !== false,
    failed: ['PAYMENT_FAILED', 'PAYMENT_EXPIRED', 'PAYMENT_CANCELLED', 'VOIDED', 'AUTH_FAILED'].includes(status),
    pending: ['PENDING_TOKEN', 'PENDING_PAYMENT', 'FOR_AUTHENTICATION', 'AUTHENTICATING', 'PAYMENT_PROCESSING', 'AUTHORIZED'].includes(status),
    amount: amount == null ? null : peso(amount),
    currency: String(payment.currency || payment.totalAmount?.currency || '').toUpperCase() || null,
    receiptNumber: payment.receiptNumber ? String(payment.receiptNumber) : null,
    payerEmail: payment.buyer?.contact?.email || null
  };
}

/** Is this webhook from an address Maya publishes? Always true when no list is set. */
function webhookSourceAllowed(ip) {
  const { allowedIps } = credentials();
  if (!allowedIps.length) return true;
  return Boolean(ip) && allowedIps.includes(String(ip).trim());
}

module.exports = {
  BASES, validateConfig, isConfigured, createCheckout, getPayment, paymentsForReference,
  summarise, webhookSourceAllowed, credentials
};
