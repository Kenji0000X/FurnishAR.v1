/**
 * PayPal, server side only.                         DFD: P10, P7 (seller connection)
 *
 * Orders v2 for checkout, Partner Referrals for connecting a shop's PayPal
 * seller account, merchant-integration reads for that account's status, and
 * webhook signature verification. The client secret lives in
 * PAYPAL_CLIENT_SECRET on the server and nowhere else; the browser never
 * talks to PayPal's API. It is only sent to PayPal's own pages and back.
 *
 * WHERE THE MONEY GOES
 * Each order names the SHOP's PayPal merchant id as `payee`, so the buyer pays
 * the shop directly. FurnishAR's 10% is either
 *   - platform_split: taken by PayPal at capture as a platform fee — only when
 *     this partner account is configured for it AND the seller granted the
 *     partner-fee permission. It counts as collected only when the capture's
 *     seller_receivable_breakdown reports it;
 *   - accrual (default): recorded per payment and settled by the shop later.
 *
 * SANDBOX BY DEFAULT
 * PAYPAL_ENV must say `live` exactly for anything real to happen; anything
 * else, including a typo, is sandbox and reported as a configuration problem.
 *
 * Every write carries a PayPal-Request-Id, so a retry after a timeout is the
 * same request to PayPal, not a second charge.
 */

const BASES = {
  live: 'https://api-m.paypal.com',
  sandbox: 'https://api-m.sandbox.paypal.com'
};

const FEE_MODES = ['accrual', 'platform_split'];
/** The database's rate (0009 platform_fee_rate). The server never overrides it. */
const DATABASE_FEE_RATE = 0.10;

const env = name => String(process.env[name] || '').trim();

function credentials() {
  const clientId = env('PAYPAL_CLIENT_ID');
  const secret = env('PAYPAL_CLIENT_SECRET');
  const environment = env('PAYPAL_ENV').toLowerCase() === 'live' ? 'live' : 'sandbox';
  // PAYPAL_API_BASE points the server at a stand-in PayPal for
  // scripts/check-billing.mjs. Only a local address is accepted, so a stray
  // setting can never send real credentials somewhere else.
  const override = env('PAYPAL_API_BASE');
  const local = /^http:\/\/(127\.0\.0\.1|localhost)(:\d+)?$/.test(override);
  return {
    clientId,
    secret,
    env: environment,
    base: local ? override : BASES[environment],
    partnerMerchantId: env('PAYPAL_PARTNER_MERCHANT_ID'),
    attributionId: env('PAYPAL_PARTNER_ATTRIBUTION_ID'),
    webhookId: env('PAYPAL_WEBHOOK_ID')
  };
}

/**
 * What this deployment can do with PayPal, and what is wrong with its
 * settings. Never returns a secret — only whether each one is present.
 */
function validateConfig() {
  const c = credentials();
  const problems = [];
  const warnings = [];

  const rawEnv = env('PAYPAL_ENV').toLowerCase();
  if (rawEnv && !['sandbox', 'live'].includes(rawEnv)) {
    problems.push(`PAYPAL_ENV is "${rawEnv}"; it must be "sandbox" or "live". Using sandbox.`);
  }
  if (!c.clientId || !c.secret) problems.push('PAYPAL_CLIENT_ID and PAYPAL_CLIENT_SECRET are required for online payments.');

  const rawMode = env('PAYPAL_FEE_MODE').toLowerCase();
  let feeModeConfigured = rawMode || 'accrual';
  if (!FEE_MODES.includes(feeModeConfigured)) {
    problems.push(`PAYPAL_FEE_MODE is "${rawMode}"; it must be "accrual" or "platform_split". Using accrual.`);
    feeModeConfigured = 'accrual';
  }

  const rawRate = env('PAYPAL_PLATFORM_FEE_RATE');
  if (rawRate && Number(rawRate) !== DATABASE_FEE_RATE) {
    problems.push(`PAYPAL_PLATFORM_FEE_RATE is ${rawRate}, but the database charges ${DATABASE_FEE_RATE}. The database's rate is used.`);
  }

  const onboarding = Boolean(c.clientId && c.secret && c.partnerMerchantId);
  if (!c.partnerMerchantId) {
    problems.push('PAYPAL_PARTNER_MERCHANT_ID is not set, so shops cannot connect their PayPal seller accounts.');
  }

  // platform_split needs the partner identity on every order; without it
  // PayPal would refuse the fee, so the split is not attempted at all.
  let splitAvailable = feeModeConfigured === 'platform_split';
  if (splitAvailable && (!c.partnerMerchantId || !c.attributionId)) {
    problems.push('PAYPAL_FEE_MODE=platform_split needs PAYPAL_PARTNER_MERCHANT_ID and PAYPAL_PARTNER_ATTRIBUTION_ID. Falling back to accrual.');
    splitAvailable = false;
  }
  if (!c.webhookId) {
    warnings.push('PAYPAL_WEBHOOK_ID is not set: webhooks are refused, so pending captures, refunds and seller status changes are not picked up automatically.');
  }

  return {
    env: c.env,
    sandbox: c.env !== 'live',
    configured: Boolean(c.clientId && c.secret),
    onboarding,
    feeModeConfigured,
    // The mode the platform may use. Each payment still falls back to
    // accrual when its seller did not grant the partner fee.
    feeMode: splitAvailable ? 'platform_split' : 'accrual',
    feeRate: DATABASE_FEE_RATE,
    webhooks: Boolean(c.webhookId),
    problems,
    warnings
  };
}

function isConfigured() {
  const { clientId, secret } = credentials();
  return Boolean(clientId && secret);
}

let cachedToken = null;   // { value, expiresAt, clientId, base }

async function accessToken(fetchImpl = fetch) {
  const { clientId, secret, base } = credentials();
  if (!clientId || !secret) {
    const error = new Error('PayPal is not configured on this deployment.');
    error.code = 'payments_unconfigured';
    throw error;
  }
  if (cachedToken && cachedToken.clientId === clientId && cachedToken.base === base
      && cachedToken.expiresAt > Date.now() + 60_000) {
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
  cachedToken = { value: body.access_token, expiresAt: Date.now() + Number(body.expires_in || 300) * 1000, clientId, base };
  return cachedToken.value;
}

async function call(path, { method = 'GET', body, requestId, headers: extra = {}, fetchImpl = fetch } = {}) {
  const { base, attributionId } = credentials();
  const token = await accessToken(fetchImpl);
  const headers = { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json', Prefer: 'return=representation', ...extra };
  if (requestId) headers['PayPal-Request-Id'] = requestId;
  if (attributionId) headers['PayPal-Partner-Attribution-Id'] = attributionId;
  const response = await fetchImpl(`${base}${path}`, {
    method, headers, body: body ? JSON.stringify(body) : undefined, signal: AbortSignal.timeout(20_000)
  });
  const data = await response.json().catch(() => ({}));
  if (!response.ok) {
    const issue = data?.details?.[0]?.issue || data?.name || 'UNKNOWN';
    const detail = String(data?.details?.[0]?.description || data?.message || '').slice(0, 200);
    console.error(`[paypal] ${method} ${path.replace(/[A-Z0-9]{10,}/g, ':id').replace(/tracking_id=[^&]+/, 'tracking_id=:id')} -> ${response.status} ${issue}${detail ? ` — ${detail}` : ''}`);
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

/* ------------------------------------------------------------ checkout --- */

/**
 * A PayPal order for one stage of one FurnishAR order, paid to the shop.
 * Everything here comes from the database via begin_payment(), never the
 * browser. `feeMode` is the mode decided for THIS payment.
 * Returns { id, approveUrl }.
 */
async function createOrder({
  orderId, reference, stage, amount, currency, merchantId, payeeEmail,
  platformFee, feeMode = 'accrual', description, returnUrl, cancelUrl
}, fetchImpl) {
  const unit = {
    reference_id: orderId,
    custom_id: `${orderId}:${stage}`,
    invoice_id: `FA-${reference}-${stage}-${Date.now().toString(36)}`,
    description: String(description || 'FurnishAR order').slice(0, 127),
    amount: { currency_code: currency, value: amountString(amount) },
    payee: merchantId ? { merchant_id: merchantId } : { email_address: payeeEmail }
  };
  if (feeMode === 'platform_split') {
    if (!merchantId || !(Number(platformFee) > 0)) throw new Error('A platform fee needs a connected seller and a fee.');
    unit.payment_instruction = {
      disbursement_mode: 'INSTANT',
      platform_fees: [{ amount: { currency_code: currency, value: amountString(platformFee) } }]
    };
  }
  const data = await call('/v2/checkout/orders', {
    method: 'POST',
    // One PayPal order per attempt; the random part lets a buyer who
    // abandoned PayPal start again without colliding with the first try.
    requestId: `create-${orderId}-${stage}-${Date.now()}`,
    fetchImpl,
    body: {
      intent: 'CAPTURE',
      purchase_units: [unit],
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

function sumAmounts(list) {
  if (!Array.isArray(list) || !list.length) return null;
  return Math.round(list.reduce((sum, item) => sum + Number(item?.amount?.value || 0), 0) * 100) / 100;
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
    payeeMerchantId: unit.payee?.merchant_id || null,
    requestedPlatformFee: sumAmounts(unit.payment_instruction?.platform_fees),
    payerEmail: order?.payer?.email_address || order?.payment_source?.paypal?.email_address || null,
    captureId: capture?.id || null,
    captureStatus: capture?.status || null,        // COMPLETED | PENDING | DECLINED …
    // What PayPal says it actually took for the platform. Null when it
    // reported nothing — which is never "collected".
    platformFeeCollected: sumAmounts(capture?.seller_receivable_breakdown?.platform_fees)
  };
}

/* -------------------------------------------------- seller onboarding --- */

/**
 * A Partner Referrals link for one shop. `trackingId` is ours (it names the
 * store), the seller signs in to PayPal there — never here — and PayPal sends
 * them back to `returnUrl`. Asks for payments and refunds; asks for the
 * partner fee only when the platform is configured to split.
 */
async function createPartnerReferral({ trackingId, returnUrl, partnerFee = false }, fetchImpl) {
  const features = ['PAYMENT', 'REFUND', ...(partnerFee ? ['PARTNER_FEE'] : [])];
  const data = await call('/v2/customer/partner-referrals', {
    method: 'POST',
    requestId: `referral-${trackingId}`,
    fetchImpl,
    body: {
      tracking_id: trackingId,
      partner_config_override: { return_url: returnUrl, return_url_description: 'Return to FurnishAR' },
      operations: [{
        operation: 'API_INTEGRATION',
        api_integration_preference: {
          rest_api_integration: {
            integration_method: 'PAYPAL',
            integration_type: 'THIRD_PARTY',
            third_party_details: { features }
          }
        }
      }],
      products: ['EXPRESS_CHECKOUT'],
      legal_consents: [{ type: 'SHARE_DATA_CONSENT', granted: true }]
    }
  });
  const action = (data.links || []).find(link => link.rel === 'action_url');
  if (!action?.href) throw new Error('PayPal did not return an onboarding link.');
  return { actionUrl: action.href };
}

/** The merchant id PayPal assigned to our tracking id, or null while none. */
async function findMerchantByTracking(trackingId, fetchImpl) {
  const { partnerMerchantId } = credentials();
  try {
    const data = await call(`/v1/customer/partners/${encodeURIComponent(partnerMerchantId)}/merchant-integrations?tracking_id=${encodeURIComponent(trackingId)}`, { fetchImpl });
    return data?.merchant_id || null;
  } catch (error) {
    if (error.status === 404) return null;
    throw error;
  }
}

function merchantIntegration(merchantId, fetchImpl) {
  const { partnerMerchantId } = credentials();
  return call(`/v1/customer/partners/${encodeURIComponent(partnerMerchantId)}/merchant-integrations/${encodeURIComponent(merchantId)}`, { fetchImpl });
}

const PARTNER_FEE_SCOPE = /\/services\/payments\/partnerfee$/;

/**
 * FurnishAR's status for a seller, from PayPal's merchant-integration answer.
 * Pure, so it is tested without PayPal. Receiving payments needs all three:
 * permissions granted to FurnishAR, a confirmed email, payments receivable.
 */
function sellerStatus(info) {
  if (!info || !info.merchant_id) {
    return { status: 'ONBOARDING_STARTED', receivable: false, emailConfirmed: false, partnerFee: false,
             detail: 'Onboarding has not finished on PayPal yet.' };
  }
  const receivable = info.payments_receivable === true;
  const emailConfirmed = info.primary_email_confirmed === true;
  const thirdParty = (info.oauth_integrations || []).flatMap(o => o.oauth_third_party || []);
  const scopes = thirdParty.flatMap(t => t.scopes || []);
  const partnerFee = scopes.some(scope => PARTNER_FEE_SCOPE.test(scope));
  const base = { merchantId: info.merchant_id, receivable, emailConfirmed, partnerFee };
  const blocked = (info.capabilities || []).some(cap => ['SUSPENDED', 'REVOKED', 'INACTIVE'].includes(String(cap.status || '').toUpperCase()));

  if (!thirdParty.length) {
    return { ...base, status: 'ERROR', detail: 'FurnishAR was not given permission to take payments for this PayPal account. Connect it again and accept the permissions.' };
  }
  if (blocked) {
    return { ...base, status: 'LIMITED', detail: 'PayPal has limited this account. Log in to PayPal to see what it needs.' };
  }
  if (!emailConfirmed) {
    return { ...base, status: 'PENDING', detail: 'Confirm the email address on your PayPal account; PayPal sent you a link.' };
  }
  if (!receivable) {
    return { ...base, status: 'PAYMENTS_NEED_ATTENTION', detail: 'PayPal says this account cannot receive payments yet. Log in to PayPal to fix it.' };
  }
  return { ...base, status: 'CONNECTED', detail: null };
}

/* ------------------------------------------------------------ webhooks --- */

/**
 * Asks PayPal whether a webhook delivery really came from PayPal, for this
 * app's webhook. Fails closed: no webhook id, a missing header or any error
 * is "not verified".
 */
async function verifyWebhookSignature(headers, event, fetchImpl) {
  const { webhookId } = credentials();
  const h = name => headers[name] || headers[name.toLowerCase()] || '';
  const fields = {
    auth_algo: h('paypal-auth-algo'),
    cert_url: h('paypal-cert-url'),
    transmission_id: h('paypal-transmission-id'),
    transmission_sig: h('paypal-transmission-sig'),
    transmission_time: h('paypal-transmission-time')
  };
  if (!webhookId || Object.values(fields).some(value => !value)) return false;
  // PayPal's certificate always lives on a paypal.com host.
  try {
    if (!/(^|\.)paypal\.com$/i.test(new URL(fields.cert_url).hostname)) return false;
  } catch {
    return false;
  }
  try {
    const data = await call('/v1/notifications/verify-webhook-signature', {
      method: 'POST', fetchImpl, body: { ...fields, webhook_id: webhookId, webhook_event: event }
    });
    return data?.verification_status === 'SUCCESS';
  } catch {
    return false;
  }
}

module.exports = {
  isConfigured, validateConfig, credentials, amountString, DATABASE_FEE_RATE,
  createOrder, getOrder, captureOrder, summarise,
  createPartnerReferral, findMerchantByTracking, merchantIntegration, sellerStatus,
  verifyWebhookSignature
};
