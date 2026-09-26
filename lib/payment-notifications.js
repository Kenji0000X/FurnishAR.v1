/**
 * "Payment received" emails for PayPal, sent exactly once.   DFD: P10 → D5 → P9
 *
 * The database writes one notification row per audience (buyer, store,
 * superadmin) in the same transaction that records a verified PayPal payment
 * (0017 payment_notifications). This module only SENDS them:
 *
 *   1. claim the rows that are due — atomically, so the buyer's return, a
 *      page refresh, a capture retry and PayPal's webhook racing each other
 *      hand each row to exactly one caller;
 *   2. build each email from the database (server_order_contacts,
 *      server_admin_emails) — never from the checkout request;
 *   3. send it through lib/notify.js (Gmail, or Resend);
 *   4. mark it sent, skipped (nobody to send to) or failed (retryable).
 *
 * An email is a notification, not the transaction: a failure here is logged
 * and left for a retry (the next capture/webhook touching the payment, or
 * the scheduled run in /api/cron/payment-reminders). It never undoes or
 * blocks the payment.
 */
const { serverRpc } = require('./server-db.js');
const notify = require('./notify.js');
const paypal = require('./paypal.js');

/** Is this error "the 0017 functions are not in this database yet"? */
function ledgerMissing(error) {
  return error?.dbCode === 'PGRST202' || error?.dbCode === '42883';
}

function buildMessage(row, contacts, admins, site) {
  if (row.event === 'unapplied') {
    return notify.messagesFor('unapplied', { ...contacts, provider: 'paypal' }, site)[0] || null;
  }
  const payment = (contacts.payments || []).find(p => p.capture_id === row.capture_id);
  if (!payment) return null;
  return notify.paymentReceivedMessage(row.audience,
    { ...contacts, payment, admin_emails: admins, sandbox: payment.environment === 'sandbox' || paypal.validateConfig().sandbox }, site);
}

/**
 * Sends the due notifications — of one payment (`captureId`) or, without it,
 * any (the scheduled retry). Returns { ledger, claimed, sent, failed, skipped };
 * `ledger: false` means 0017 is not applied and the caller must fall back.
 */
async function dispatchPaymentNotifications({ captureId = null, site = notify.siteUrl(), limit = 25 } = {}) {
  let rows;
  try {
    rows = await serverRpc('server_claim_payment_notifications', { p_capture: captureId, p_limit: limit });
  } catch (error) {
    if (ledgerMissing(error)) return { ledger: false, claimed: 0, sent: 0, failed: 0, skipped: 0 };
    console.error(`[notify] could not claim payment notifications: ${error.message}`);
    return { ledger: true, claimed: 0, sent: 0, failed: 0, skipped: 0, error: true };
  }
  const result = { ledger: true, claimed: rows?.length || 0, sent: 0, failed: 0, skipped: 0 };
  if (!rows?.length) return result;

  const contactsByOrder = new Map();
  let admins = null;
  for (const row of rows) {
    let status = 'failed';
    let reason = null;
    try {
      if (!contactsByOrder.has(row.order_id)) {
        contactsByOrder.set(row.order_id, await serverRpc('server_order_contacts', { p_order: row.order_id }));
      }
      const contacts = contactsByOrder.get(row.order_id);
      if (row.audience === 'admin' && admins === null) admins = await serverRpc('server_admin_emails', {}) || [];
      const message = contacts ? buildMessage(row, contacts, admins || [], site) : null;
      const sent = message ? await notify.sendEmail(message) : { sent: false, reason: 'no recipient' };
      if (sent.sent) status = 'sent';
      else if (sent.reason === 'no recipient') { status = 'skipped'; reason = 'no recipient'; }
      else reason = sent.reason || 'not sent';
    } catch (error) {
      reason = String(error?.message || 'error').slice(0, 200);
    }
    result[status] += 1;
    if (status === 'failed') console.error(`[notify] payment email ${row.event}/${row.audience} for ${row.capture_id} failed (${reason}); it will be retried`);
    await serverRpc('server_finish_payment_notification', { p_id: row.id, p_status: status, p_error: reason })
      .catch(error => console.error(`[notify] could not record notification ${row.id}: ${error.message}`));
  }
  return result;
}

module.exports = { dispatchPaymentNotifications, ledgerMissing };
