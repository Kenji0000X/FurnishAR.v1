/**
 * PayPal Orders v2, server side only.                          DFD: P10
 *
 * The client secret lives in PAYPAL_CLIENT_SECRET on the server and nowhere
 * else; the browser never talks to PayPal's API, it is only redirected to
 * PayPal's own approval page and back.
 *
 * WHERE THE MONEY GOES
 * Each order names the SHOP's PayPal account as `payee`, so the buyer pays
 * the shop directly and FurnishAR never holds the money. FurnishAR's 10% is
 * recorded per payment (0009) and billed to the shop separately.
 *
 * Every write carries a PayPal-Request-Id, so a retry after a timeout is the
 * same request to PayPal, not a second charge.
 */

const BASES = {
  live: 'https://api-m.paypal.com',
  sandbox: 'https://api-m.sandbox.paypal.com'
};

function credentials() {
  const clientId = String(process.env.PAYPAL_CLIENT_ID || '').trim();
  const secret = String(process.env.PAYPAL_CLIENT_SECRET || '').trim();
  const env = String(process.env.PAYPAL_ENV || 'sandbox').trim().toLowerCase() === 'live' ? 'live' : 'sandbox';
  // PAYPAL_API_BASE points the server at a stand-in PayPal for
  // scripts/check-billing.mjs. Only a local address is accepted, so a stray
  // setting can never send real credentials somewhere else.
  const override = String(process.env.PAYPAL_API_BASE || '').trim();
  const local = /^http:\/\/(127\.0\.0\.1|localhost)(:\d+)?$/.test(override);
  return { clientId, secret, env, base: local ? override : BASES[env] };
}

function isConfigured() {
  const { clientId, secret } = credentials();
  return Boolean(clientId && secret);
}

let cachedToken = null;   // { value, expiresAt, clientId }

async function accessToken(fetchImpl = fetch) {
  const { clientId, secret, base } = credentials();
  if (!clientId || !secret) {
    const error = new Error('PayPal is not configured on this deployment.');
    error.code = 'payments_unconfigured';
    throw error;
  }
  if (cachedToken && cachedToken.clientId === clientId && cachedToken.expiresAt > Date.now() + 60_000) {
    return cachedToken.value;
  }
  const response = await fetchImpl(`${base}/v1/oauth2/token`, {
    method: 'POST',
    headers: {
      Authorization: `Basic ${Buffer.from(`${clientId}:${secret}`).toString('base64')}`,
      'Content-Type': 'application/x-www-form-urlencoded'
    },
    body: 'grant_type=client_credentials',
    signal: AbortSignal.timeout(15_000)
  });
  const body = await response.json().catch(() => ({}));
  if (!response.ok || !body.access_token) {
    // Never log the secret or the token; the status is enough to act on.
    console.error(`[paypal] token request failed: ${response.status} ${body.error || ''}`);
    const error = new Error('PayPal refused this deployment\'s credentials.');
    error.code = 'payments_unavailable';
    throw error;
  }
  cachedToken = { value: body.access_token, expiresAt: Date.now() + Number(body.expires_in || 300) * 1000, clientId };
  return cachedToken.value;
}

async function call(path, { method = 'GET', body, requestId, fetchImpl = fetch } = {}) {
  const { base } = credentials();
  const token = await accessToken(fetchImpl);
  const headers = { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json', Prefer: 'return=representation' };
  if (requestId) headers['PayPal-Request-Id'] = requestId;
  const response = await fetchImpl(`${base}${path}`, {
    method, headers, body: body ? JSON.stringify(body) : undefined, signal: AbortSignal.timeout(20_000)
  });
  const data = await response.json().catch(() => ({}));
  if (!response.ok) {
    const issue = data?.details?.[0]?.issue || data?.name || 'UNKNOWN';
    console.error(`[paypal] ${method} ${path.replace(/[A-Z0-9]{10,}/g, ':id')} -> ${response.status} ${issue}`);
    const error = new Error(issue);
    error.status = response.status;
    error.issue = issue;
    throw error;
  }
  return data;
}

/** Amounts as PayPal wants them: a string with exactly two decimals. */
function amountString(value) {
  const number = Number(value);
  if (!Number.isFinite(number) || number <= 0) throw new Error(`Bad amount: ${value}`);
  return number.toFixed(2);
}

/**
 * A PayPal order for one stage of one FurnishAR order, paid to the shop.
 * Returns { id, approveUrl }.
 */
async function createOrder({ orderId, reference, stage, amount, currency, payeeEmail, description, returnUrl, cancelUrl }, fetchImpl) {
  const data = await call('/v2/checkout/orders', {
    method: 'POST',
    // One PayPal order per attempt; the random part lets a buyer who
    // abandoned PayPal start again without colliding with the first try.
    requestId: `create-${orderId}-${stage}-${Date.now()}`,
    fetchImpl,
    body: {
      intent: 'CAPTURE',
      purchase_units: [{
        reference_id: orderId,
        custom_id: `${orderId}:${stage}`,
        invoice_id: `FA-${reference}-${stage}-${Date.now().toString(36)}`,
        description: String(description || 'FurnishAR order').slice(0, 127),
        amount: { currency_code: currency, value: amountString(amount) },
        payee: { email_address: payeeEmail }
      }],
      payment_source: {
        paypal: {
          experience_context: {
            brand_name: 'FurnishAR',
            user_action: 'PAY_NOW',
            shipping_preference: 'NO_SHIPPING',
            return_url: returnUrl,
            cancel_url: cancelUrl
          }
        }
      }
    }
  });
  const approve = (data.links || []).find(link => link.rel === 'payer-action' || link.rel === 'approve');
  if (!approve?.href) throw new Error('PayPal did not return an approval link.');
  return { id: data.id, approveUrl: approve.href };
}

function getOrder(id, fetchImpl) {
  return call(`/v2/checkout/orders/${encodeURIComponent(id)}`, { fetchImpl });
}

function captureOrder(id, fetchImpl) {
  // The same request id every time: capturing twice is the one thing that
  // must never happen, and PayPal answers a repeat with the first result.
  return call(`/v2/checkout/orders/${encodeURIComponent(id)}/capture`, {
    method: 'POST', requestId: `capture-${id}`, body: {}, fetchImpl
  });
}

/**
 * The facts FurnishAR needs from a PayPal order, whatever state it is in.
 * Everything here is read from PayPal's answer, never from the browser.
 */
function summarise(order) {
  const unit = order?.purchase_units?.[0] || {};
  const capture = unit.payments?.captures?.[0] || null;
  const [orderId, stage] = String(unit.custom_id || capture?.custom_id || '').split(':');
  return {
    paypalOrderId: order?.id,
    status: order?.status,                         // CREATED | APPROVED | COMPLETED | …
    orderId: /^[0-9a-f-]{36}$/i.test(orderId || '') ? orderId : null,
    stage: ['full', 'deposit', 'balance'].includes(stage) ? stage : null,
    amount: Number(capture?.amount?.value ?? unit.amount?.value),
    currency: capture?.amount?.currency_code || unit.amount?.currency_code,
    payeeEmail: String(unit.payee?.email_address || '').toLowerCase(),
    payerEmail: order?.payer?.email_address || order?.payment_source?.paypal?.email_address || null,
    captureId: capture?.id || null,
    captureStatus: capture?.status || null         // COMPLETED | PENDING | DECLINED …
  };
}

module.exports = { isConfigured, createOrder, getOrder, captureOrder, summarise, amountString, credentials };
