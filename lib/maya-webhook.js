/**
 * Maya webhooks.                                          DFD: Maya → P10
 *
 * Maya's webhooks are NOT signed, so the body is never believed. It is used
 * for one thing only: the requestReferenceNumber, FurnishAR's own reference
 * for a checkout. Then:
 *
 *   1. the source address is checked against MAYA_WEBHOOK_ALLOWED_IPS when
 *      that is set (Maya publishes its webhook addresses);
 *   2. the reference must be an attempt FurnishAR recorded (provider maya);
 *   3. the payment is RE-READ from Maya with the secret key, and only what
 *      Maya says there is acted on (orders.settleMaya);
 *   4. each (payment, status) is processed once (payment_webhook_events), so
 *      Maya's retries never send a second email; recording the payment is
 *      idempotent on its own as well (payments.capture_id is unique).
 *
 * 200 means "do not send it again": processed, a duplicate, or not ours.
 * 403 is a refused source. 500 asks Maya to retry.
 */
const maya = require('./maya.js');
const providers = require('./providers/index.js');
const { serverRpc } = require('./server-db.js');
const orders = require('./orders.js');

const REFERENCE = /^[A-Za-z0-9-]{6,64}$/;

/** The address the request came from, as Vercel reports it. */
function sourceIp(headers = {}) {
  const forwarded = String(headers['x-forwarded-for'] || '').split(',')[0].trim();
  return forwarded || String(headers['x-real-ip'] || '').trim() || null;
}

/** FurnishAR's reference from either Maya body shape (payment or checkout). */
function referenceOf(event) {
  const ref = event?.requestReferenceNumber ?? event?.data?.requestReferenceNumber ?? null;
  return ref != null && REFERENCE.test(String(ref)) ? String(ref) : null;
}

async function handleMayaWebhook(headers, rawBody, site) {
  if (!providers.PROVIDERS.maya.ready()) return { status: 503, body: { error: 'Maya is not configured.' } };
  if (!maya.webhookSourceAllowed(sourceIp(headers))) {
    console.warn('[maya] webhook refused: source address not in MAYA_WEBHOOK_ALLOWED_IPS');
    return { status: 403, body: { error: 'Source not allowed.' } };
  }
  let event;
  try { event = JSON.parse(rawBody); } catch { return { status: 400, body: { error: 'Not JSON.' } }; }
  const reference = referenceOf(event);
  if (!reference) return { status: 200, body: { ignored: 'no FurnishAR reference' } };

  const attempt = await serverRpc('server_payment_attempt_by_reference', { p_provider: 'maya', p_reference: reference });
  if (!attempt) return { status: 200, body: { ignored: 'not a FurnishAR payment' } };

  // What Maya says NOW, read with the secret key. The body's status is not used.
  let payments;
  try {
    payments = await maya.paymentsForReference(reference);
  } catch (error) {
    if (error.status !== 404) {
      console.error(`[maya] webhook could not re-read ${reference}: ${error.message}`);
      return { status: 500, body: { error: 'Could not confirm with Maya; retry.' } };
    }
    payments = [];
  }
  const verdict = providers.PROVIDERS.maya.judgePayments(attempt, payments);
  // One event per (payment, status); a reference with no payment yet has its own.
  const eventId = verdict.payment?.paymentId
    ? `maya:${verdict.payment.paymentId}:${verdict.payment.status}`.slice(0, 100)
    : `maya:${reference}:${verdict.state}`.slice(0, 100);
  const claimed = await serverRpc('server_claim_webhook_event', {
    p_event_id: eventId, p_type: `MAYA.${String(verdict.payment?.status || verdict.state).toUpperCase()}`.slice(0, 100),
    p_resource: reference, p_env: attempt.environment
  });
  if (!claimed) return { status: 200, body: { duplicate: true } };

  try {
    // A payment with no result yet is left for a later webhook or the buyer's return.
    const result = verdict.state === 'none' ? { state: 'none' }
      : await orders.settleMaya({ site }, attempt, { notifyFailure: true });
    const outcome = result.state === 'paid' || result.state === 'unapplied'
      ? `${result.duplicate ? 'already recorded' : 'recorded'} (${result.status})` : result.state;
    await serverRpc('server_finish_webhook_event', { p_event_id: eventId, p_outcome: outcome });
    return { status: 200, body: { ok: true, outcome } };
  } catch (error) {
    // Not finished: Maya retries, and the claim can be taken again later.
    console.error(`[maya] webhook for ${reference} failed: ${error.message}`);
    return { status: 500, body: { error: 'Processing failed; Maya will retry.' } };
  }
}

module.exports = { handleMayaWebhook, sourceIp, referenceOf };
