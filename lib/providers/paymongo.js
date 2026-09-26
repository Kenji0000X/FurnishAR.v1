/**
 * PayMongo behind the payment-provider boundary; GCash is its payment method.
 *                                                     DFD: P10 → PayMongo
 *
 * WHO RECEIVES THE MONEY (per store, set by an admin — migration 0016):
 *   platform (default)  the PayMongo account that owns the keys — FurnishAR's —
 *       receives the payment, less PayMongo's processing fee. The 10% is
 *       recorded as accrued and HELD (fee_mode platform_held), never as
 *       "collected by a split"; the store's share is owed to the store and
 *       paid out by FurnishAR (store_remittances).
 *   split  only when PAYMONGO_SPLIT_MODE=split (Split Payments activated for
 *       FurnishAR) and the store has a child-merchant id. The store's product
 *       share goes to the child merchant; FurnishAR's portion is EXPECTED
 *       (fee_mode provider_split) until reconciled against PayMongo's records.
 *
 * A browser redirect is not proof of payment. The buyer's return and every
 * webhook are only prompts: the checkout session is re-read from PayMongo with
 * the secret key and compared with the attempt recorded before the buyer left.
 */
const crypto = require('node:crypto');
const paymongo = require('../paymongo.js');
const { phpToCentavos, centavosToPhp } = require('../money.js');
const { serverSecretReady } = require('../server-db.js');

const PLATFORM_PAYEE = 'furnishar-paymongo';   // public.paymongo_platform_payee()
const STAGE_CODE = { full: 'F', deposit: 'D', balance: 'B' };
const STAGE_NAME = { full: '', deposit: ' — deposit', balance: ' — balance' };

function fail(status, message, code) {
  return Object.assign(new Error(message), { status, ...(code ? { code } : {}) });
}

/** FurnishAR's reference for ONE checkout: the order, the stage, a nonce. */
function referenceFor(due) {
  return `${String(due.reference).slice(0, 40)}-${STAGE_CODE[due.stage] || 'X'}${crypto.randomBytes(4).toString('hex')}`;
}

/** Payee and fee mode for this store's PayMongo setup, or why it cannot pay. */
function settlementFor(due, config = paymongo.validateConfig()) {
  if (due.settlement_mode === 'platform') return { feeMode: 'platform_held', payee: PLATFORM_PAYEE };
  if (due.settlement_mode === 'split' && due.provider_account_ref) {
    if (!config.splitEnabled) {
      throw fail(409, 'This shop cannot take GCash payments yet. Choose another payment method.', 'provider_unavailable');
    }
    return { feeMode: 'provider_split', payee: due.provider_account_ref };
  }
  throw fail(409, 'This shop cannot take GCash payments yet. Choose another payment method.', 'provider_unavailable');
}

/**
 * What the buyer sees on PayMongo's page: the piece and FurnishAR's fee, as
 * two lines that add up to exactly what begin_payment says is due.
 */
function checkoutLines(due) {
  const total = phpToCentavos(due.amount);
  const fee = phpToCentavos(due.platform_fee);
  return [
    { name: `${due.product_name}${STAGE_NAME[due.stage] || ''}`, amount: centavosToPhp(total - fee) },
    { name: 'FurnishAR service fee (10%)', amount: centavosToPhp(fee) }
  ];
}

/**
 * Split Payments: the store's child merchant receives the product share as a
 * fixed amount; what remains (FurnishAR's fee, less PayMongo's processing
 * fee) stays with FurnishAR. Built only in split mode; the value's unit
 * (centavos) is listed under "verify before live".
 */
function splitFor(due, payee) {
  const productShare = phpToCentavos(due.amount) - phpToCentavos(due.platform_fee);
  return { recipients: [{ merchant_id: payee, split_type: 'fixed', value: productShare }] };
}

/**
 * Which of a session's payments settles the attempt. Pure.
 *   paid      a paid GCash payment for exactly the attempt's amount and currency
 *   mismatch  PayMongo took money that does not match the attempt
 *   pending | failed | none (session expired or never paid)
 */
function judgeSession(attempt, session) {
  const s = paymongo.summariseSession(session);
  if (!s || s.id !== attempt.provider_order_id || (s.reference && s.reference !== attempt.provider_reference)) {
    return { state: 'none', payment: null, foreign: true };
  }
  const paid = s.payments.find(p => p.paid);
  if (paid) {
    const exact = paid.amount != null && phpToCentavos(paid.amount) === phpToCentavos(attempt.amount)
      && paid.currency === attempt.currency;
    return { state: exact ? 'paid' : 'mismatch', payment: paid };
  }
  const failed = s.payments.find(p => p.failed);
  if (failed) return { state: 'failed', payment: failed };
  if (s.payments.length) return { state: 'pending', payment: s.payments[0] };
  return { state: s.status === 'expired' ? 'none' : 'pending', payment: null };
}

module.exports = {
  id: 'paymongo',
  label: 'GCash',            // what the buyer chooses; PayMongo processes it
  method: 'gcash',
  capabilities: {
    hostedCheckout: true,
    capture: 'provider',               // PayMongo captures when the buyer authorises in GCash
    settlesTo: 'platform',             // FurnishAR's PayMongo account (split: the child merchant)
    feeCollection: ['platform_held', 'provider_split'],
    webhooks: 'signed',                // Paymongo-Signature, HMAC-SHA256
    refunds: 'api',                    // POST /v1/refunds, admin-initiated
    storeOnboarding: 'admin',          // child merchants are arranged with PayMongo
    currencies: ['PHP'],
    methods: ['gcash']
  },
  PLATFORM_PAYEE,
  referenceFor,
  settlementFor,
  checkoutLines,
  judgeSession,
  ready: () => paymongo.isReady() && serverSecretReady(),
  config: () => paymongo.validateConfig(),
  env: () => paymongo.validateConfig().env,

  /** Creates the hosted GCash checkout for what begin_payment says is due. */
  async start(ctx, due) {
    const config = paymongo.validateConfig();
    const { feeMode, payee } = settlementFor(due, config);
    const reference = referenceFor(due);
    const back = result => `${ctx.site}/account/payment/return?provider=paymongo&ref=${encodeURIComponent(reference)}&result=${result}`;
    const created = await paymongo.createCheckoutSession({
      reference,
      lines: checkoutLines(due),
      description: `${due.product_name} — ${due.store_name} (order ${due.reference}, ${due.stage})`,
      successUrl: back('success'),
      cancelUrl: back('cancel'),
      metadata: { order_id: due.order_id, stage: due.stage, reference },
      split: feeMode === 'provider_split' ? splitFor(due, payee) : null
    }).catch(error => {
      throw fail(502, error.code === 'payments_unavailable'
        ? 'Online payments are unavailable right now. Please try again later.'
        : "GCash couldn't start the payment. Please try again.");
    });
    return { providerOrder: created.id, reference, redirectUrl: created.checkoutUrl, feeMode, payee, method: 'gcash' };
  }
};
