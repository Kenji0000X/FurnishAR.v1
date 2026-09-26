/**
 * Maya Checkout behind the payment-provider boundary.       DFD: P10 → Maya
 *
 * WHO RECEIVES THE MONEY. Maya Checkout pays the Maya merchant that owns the
 * API keys, and that merchant is FurnishAR. So, unlike PayPal:
 *
 *   platform_collect (default)  FurnishAR's Maya account receives the whole
 *       payment. The fee is FurnishAR's; the shop's share is OWED to the shop
 *       and paid out by FurnishAR (store_remittances, 0015).
 *   payfac  only when Maya has enabled Payment Facilitator for FurnishAR
 *       (MAYA_PAYFAC_ENABLED) AND an admin recorded the shop's sub-merchant.
 *       Maya settles to the sub-merchant; the fee accrues, or is expected
 *       via Maya's settlement (MAYA_FEE_MODE) — never recorded as collected.
 *
 * Maya webhooks are not signed. A webhook, like the buyer's return, is only
 * a prompt: the payment is always re-read from Maya with the secret key and
 * compared with the attempt recorded before the buyer left.
 */
const crypto = require('node:crypto');
const maya = require('../maya.js');
const { serverSecretReady } = require('../server-db.js');

const PLATFORM_PAYEE = 'furnishar-platform';   // public.maya_platform_payee()
const STAGE_CODE = { full: 'F', deposit: 'D', balance: 'B' };

function fail(status, message, code) {
  return Object.assign(new Error(message), { status, ...(code ? { code } : {}) });
}

const money2 = value => Number(value).toFixed(2);

/** FurnishAR's reference for ONE checkout: the order, the stage, a nonce. */
function referenceFor(due) {
  return `${String(due.reference).slice(0, 40)}-${STAGE_CODE[due.stage] || 'X'}${crypto.randomBytes(4).toString('hex')}`;
}

/** Payee and fee mode for this store's Maya setup, or why it cannot pay. */
function settlementFor(due, config = maya.validateConfig()) {
  if (due.settlement_mode === 'payfac') {
    if (!config.payfac) {
      throw fail(409, 'This shop cannot take Maya payments yet. Choose another payment method.', 'provider_unavailable');
    }
    return { feeMode: config.payfacFeeMode, payee: due.provider_account_ref };
  }
  if (due.settlement_mode === 'platform_collect') return { feeMode: 'platform_collect', payee: PLATFORM_PAYEE };
  throw fail(409, 'This shop cannot take Maya payments yet. Choose another payment method.', 'provider_unavailable');
}

/**
 * Which of Maya's payments for a reference settles the attempt. Pure.
 *   paid      PAYMENT_SUCCESS for exactly the attempt's amount and currency
 *   mismatch  Maya took money that does not match the attempt
 *   pending | failed | none
 */
function judgePayments(attempt, payments) {
  const list = (payments || []).map(maya.summarise).filter(Boolean)
    .filter(p => p.reference === attempt.provider_reference);
  const paid = list.find(p => p.paid);
  if (paid) {
    const exact = paid.amount != null && money2(paid.amount) === money2(attempt.amount) && paid.currency === attempt.currency;
    return { state: exact ? 'paid' : 'mismatch', payment: paid };
  }
  const pending = list.find(p => p.pending);
  if (pending) return { state: 'pending', payment: pending };
  const failed = list.find(p => p.failed);
  if (failed) return { state: 'failed', payment: failed };
  return { state: 'none', payment: null };
}

module.exports = {
  id: 'maya',
  label: 'Maya',
  capabilities: {
    hostedCheckout: true,
    capture: 'provider',               // Maya captures when the buyer pays
    settlesTo: 'platform',             // FurnishAR's Maya account (PayFac: the sub-merchant)
    feeCollection: ['platform_collect', 'accrual', 'provider_settlement'],
    webhooks: 'unsigned-refetch',      // re-read from Maya with the secret key
    refunds: 'manual',                 // made in Maya Manager; not automated here
    storeOnboarding: 'admin',          // no self-service Maya onboarding into a platform
    currencies: ['PHP']
  },
  PLATFORM_PAYEE,
  referenceFor,
  settlementFor,
  judgePayments,
  ready: () => maya.isConfigured() && serverSecretReady(),
  config: () => maya.validateConfig(),
  env: () => maya.validateConfig().env,

  /** Creates the hosted Maya checkout for what begin_payment says is due. */
  async start(ctx, due) {
    const config = maya.validateConfig();
    const { feeMode, payee } = settlementFor(due, config);
    const reference = referenceFor(due);
    const back = result => `${ctx.site}/account/payment/return?provider=maya&ref=${encodeURIComponent(reference)}&result=${result}`;
    const profile = due.provider_profile || {};
    const created = await maya.createCheckout({
      reference,
      amount: due.amount,
      platformFee: due.platform_fee,
      currency: due.currency,
      description: `${due.product_name} — ${due.store_name} (${due.stage})`,
      buyer: { email: ctx.user?.email },
      returnUrls: { success: back('success'), failure: back('failure'), cancel: back('cancel') },
      payfac: due.settlement_mode === 'payfac'
        ? { submerchantId: payee, name: due.store_name, city: profile.city, postal: profile.postal, country: profile.country }
        : null
    }).catch(error => {
      throw fail(502, error.code === 'payments_unavailable'
        ? 'Online payments are unavailable right now. Please try again later.'
        : "Maya couldn't start the payment. Please try again.");
    });
    return { providerOrder: created.checkoutId, reference, redirectUrl: created.redirectUrl, feeMode, payee };
  }
};
