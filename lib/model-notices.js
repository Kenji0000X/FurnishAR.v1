/**
 * Model expiry notices, on a schedule.                    DFD: P11 → Email
 *
 * 0013: a model becomes deletable only after its shop was emailed about it
 * and had 30 days to answer. This is the job that sends that email: once a
 * day, every model idle for 335 days that its owners have not yet been told
 * about (for this idle spell) is gathered by shop, one email goes to each
 * shop, and each model is marked as noticed — only if the email actually
 * went. A failed or unconfigured email leaves the model un-noticed, and so
 * NOT deletable: a notice that was never delivered does not start the clock.
 *
 * The due list, the dates and the marking are the database's
 * (server_models_due_notice / server_mark_model_notice, behind the server's
 * secret). Nothing here decides who is due.
 */
const { serverRpc, serverSecretReady } = require('./server-db.js');
const notify = require('./notify.js');

async function sendModelExpiryNotices(site, deps = { serverRpc, notify }) {
  if (!serverSecretReady()) return { due: 0, sent: 0, skipped: 'unconfigured' };
  const due = await deps.serverRpc('server_models_due_notice', {}) || [];

  const byStore = new Map();
  for (const model of due) {
    if (!byStore.has(model.store_id)) byStore.set(model.store_id, []);
    byStore.get(model.store_id).push(model);
  }

  let stores = 0;
  let marked = 0;
  for (const [storeId, models] of byStore) {
    const contacts = await deps.serverRpc('server_store_contacts', { p_store: storeId });
    const results = await Promise.all(deps.notify.accountMessages('model_expiry_notice',
      { ...contacts, models }, site).map(message => deps.notify.sendEmail(message)));
    if (!results.some(result => result.sent)) continue;
    stores += 1;
    for (const model of models) {
      if (await deps.serverRpc('server_mark_model_notice', { p_asset: model.asset_id })) marked += 1;
    }
  }
  return { due: due.length, stores: byStore.size, emailed: stores, marked };
}

module.exports = { sendModelExpiryNotices };
