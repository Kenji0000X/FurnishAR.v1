/**
 * The payment-provider boundary.                              DFD: P10
 *
 * One order system, one payments table, one fee rule; more than one way to
 * pay. Each provider module has the same shape:
 *
 *   id, label, capabilities   what it does (who it settles to, how its
 *                             webhooks are trusted, how a store is set up)
 *   ready()                   configured on this server (keys + recorder secret)
 *   env()                     'sandbox' | 'live', the database's names
 *   start(ctx, due)           creates the hosted checkout for what
 *                             begin_payment() says is due, and returns
 *                             { providerOrder, reference, redirectUrl, feeMode, payee }
 *
 * Nothing here decides money. Amounts, fees and payees come from the
 * database; whether a payment counts is decided by record_capture().
 */
const paypal = require('./paypal.js');
const paymongo = require('./paymongo.js');
const { post } = require('../server-db.js');

const PROVIDERS = { paypal, paymongo };
const IDS = Object.keys(PROVIDERS);
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function fail(status, message, code) {
  return Object.assign(new Error(message), { status, ...(code ? { code } : {}) });
}

/** A provider by id. PayPal when none is named (every caller before 0015). */
function get(id = 'paypal') {
  const key = String(id || 'paypal').toLowerCase();
  if (!Object.hasOwn(PROVIDERS, key)) throw fail(400, 'Unknown payment method.', 'unknown_provider');
  return PROVIDERS[key];
}

/** The providers this server can take payments through right now. */
function configured() {
  return IDS.filter(id => PROVIDERS[id].ready());
}

/** What the browser may know about each configured provider. No secrets. */
function summary() {
  return configured().map(id => {
    const provider = PROVIDERS[id];
    const config = provider.config();
    return {
      id, label: provider.label, sandbox: config.sandbox, environment: config.env,
      method: id === 'paymongo' ? 'gcash' : 'paypal',
      // PayMongo: whether stores can be paid by Split Payments — the copy says
      // who receives the money, so it must be true. Safe booleans only.
      ...(id === 'paymongo' ? { gcashEnabled: Boolean(config.gcashEnabled), splitEnabled: Boolean(config.splitEnabled) } : {})
    };
  });
}

/**
 * The providers a store can be paid through: what the database says the
 * store is set up for (in each provider's environment on this server),
 * intersected with what this server has configured. Public: a product page
 * asks it, and it answers only provider ids.
 */
async function forStore(storeId, call = post) {
  if (!UUID.test(String(storeId || ''))) throw fail(400, 'Unknown shop.');
  const ready = configured();
  if (!ready.length) return [];
  let accepted;
  try {
    accepted = await call('store_payment_providers', {
      p_store: storeId, p_paypal_env: paypal.env(), p_paymongo_env: paymongo.env()
    }, null);
  } catch {
    // A database without 0016 yet: there, only PayPal is certain (0011).
    accepted = ready.includes('paypal')
      && await call('store_accepts_payments', { p_store: storeId, p_env: paypal.env() }, null) === true
      ? ['paypal'] : [];
  }
  return (Array.isArray(accepted) ? accepted : []).filter(id => ready.includes(id));
}

module.exports = { PROVIDERS, IDS, get, configured, summary, forStore };
