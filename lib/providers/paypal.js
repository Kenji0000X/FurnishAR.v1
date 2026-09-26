/**
 * PayPal behind the payment-provider boundary.            DFD: P10 → PayPal
 *
 * The same PayPal Orders v2 flow as before (lib/paypal.js), unchanged: the
 * buyer approves on PayPal, the server captures, and the money lands in the
 * SHOP'S OWN PayPal account (merchant id from begin_payment). FurnishAR's
 * fee is split by PayPal only when the deployment and the seller both allow
 * it; otherwise it accrues and the shop owes it.
 */
const paypal = require('../paypal.js');
const { serverSecretReady } = require('../server-db.js');

function fail(status, message, code) {
  return Object.assign(new Error(message), { status, ...(code ? { code } : {}) });
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

module.exports = {
  id: 'paypal',
  label: 'PayPal',
  capabilities: {
    hostedCheckout: true,
    capture: 'server',                 // the buyer approves; FurnishAR's server captures
    settlesTo: 'store',                // the shop's own PayPal account
    feeCollection: ['accrual', 'platform_split'],
    webhooks: 'signed',                // verify-webhook-signature against PAYPAL_WEBHOOK_ID
    refunds: 'provider-webhook',       // refunds made in PayPal are recorded from its events
    storeOnboarding: 'self-service',   // Partner Referrals from the store portal
    currencies: ['PHP']
  },
  feeModeFor,
  ready: () => paypal.isConfigured() && serverSecretReady(),
  config: () => paypal.validateConfig(),
  env: () => paypal.validateConfig().env,

  /** Creates the PayPal order for what begin_payment says is due. */
  async start(ctx, due) {
    if (!due.merchant_id) {
      throw fail(409, 'This shop is finishing its PayPal setup and cannot take online payments yet.', 'seller_not_connected');
    }
    const config = paypal.validateConfig();
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
      // Unchanged since 0011, so a payment started before this release still
      // comes back to a page that finishes it.
      returnUrl: `${ctx.site}/account?paypal=return`,
      cancelUrl: `${ctx.site}/account?paypal=cancel`
    }).catch(error => {
      throw fail(502, error.code === 'payments_unavailable'
        ? 'Online payments are unavailable right now. Please try again later.'
        : "PayPal couldn't start the payment. Please try again.");
    });
    return { providerOrder: created.id, reference: null, redirectUrl: created.approveUrl, feeMode, payee: due.merchant_id };
  }
};
