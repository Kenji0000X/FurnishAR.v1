/**
 * /api/sb/account/<action> — onboarding after sign-in.          DFD: P1 → D1, D4
 *
 *   GET  state   the caller's role and what is missing (my_account_state)
 *   POST buyer   become a shopper: only the municipality is asked for
 *   POST apply   apply to sell: store name, contact number, what they list
 *
 * Authentication first (a real session, checked with Supabase Auth), then the
 * database decides (0011): an admin, an owner, an applicant or a buyer cannot
 * turn into something else here, and nothing here can create an admin.
 * Server-side so the welcome and application emails go out without trusting
 * the browser to ask for them.
 */
const { rpc, serverRpc, serverSecretReady } = require('./server-db.js');
const notify = require('./notify.js');
const orders = require('./orders.js');

const { fail } = orders;

async function send(event, data, site) {
  try {
    await Promise.all(notify.messagesFor(event, data, site).map(message => notify.sendEmail(message)));
  } catch (error) {
    console.error(`[account] could not send "${event}": ${error.message}`);
  }
}

const text = (value, max) => (value == null ? null : String(value).trim().slice(0, max) || null);

const ACTIONS = {
  async state(ctx) {
    return rpc(ctx, 'my_account_state', {});
  },

  async buyer(ctx, body) {
    const result = await rpc(ctx, 'complete_buyer_onboarding', {
      p_full_name: text(body.fullName, 80), p_municipality: text(body.municipality, 80)
    });
    if (result?.created) {
      await send('buyer_welcome', { email: result.email || ctx.user.email, full_name: result.full_name }, ctx.site);
    }
    return { role: 'buyer', created: Boolean(result?.created) };
  },

  async apply(ctx, body) {
    const filed = await rpc(ctx, 'submit_store_application', {
      p_store_name: text(body.storeName, 120), p_phone: text(body.phone, 32), p_message: text(body.message, 1000)
    });
    const details = { ...filed, contact_phone: text(body.phone, 32), message: text(body.message, 1000) };
    await send('store_application_received', details, ctx.site);
    if (serverSecretReady()) {
      const admins = await serverRpc('server_admin_emails', {}).catch(() => []);
      if (admins?.length) await send('store_application_admin_notice', { ...details, admin_emails: admins }, ctx.site);
    }
    return { role: 'pending', storeName: filed.store_name };
  }
};

async function handleAccount(req, action, body, site) {
  const allowed = (action === 'state' && req.method === 'GET') || (['buyer', 'apply'].includes(action) && req.method === 'POST');
  if (!allowed) return { status: 404, body: { error: 'Unknown endpoint.' } };
  const auth = await orders.authenticate(req);
  if (auth.error) return auth.error;
  try {
    return { status: 200, body: await ACTIONS[action]({ ...auth.ctx, site }, body || {}) };
  } catch (error) {
    if (error.upstream) throw error;
    return { status: error.status || 500, body: { error: error.message, ...(error.code ? { code: error.code } : {}) } };
  }
}

/**
 * After an admin's approve/reject call succeeds through the proxy, the
 * applicant is told. `result` is the database's own answer (0011 returns the
 * contact email and store name), so nothing here comes from the browser.
 */
async function announceDecision(fn, result, site) {
  if (!result || typeof result !== 'object') return;
  if (fn === 'approve_store_application' && result.contact_email) {
    await send('store_approved', result, site);
  } else if (fn === 'reject_store_application' && result.contact_email) {
    await send('store_rejected', result, site);
  }
}

module.exports = { handleAccount, announceDecision, ACTIONS, fail };
