/**
 * PayMongo webhooks.                                   DFD: PayMongo → P10
 *
 *   1. The Paymongo-Signature header is verified against the RAW body with
 *      PAYMONGO_WEBHOOK_SECRET (HMAC-SHA256 of `${t}.${body}`), using the
 *      te (test) or li (live) signature that matches this server's mode, and
 *      a stale timestamp is refused. Nothing is read from an unverified body.
 *   2. The event is claimed once (payment_webhook_events, "paymongo:<id>"):
 *      PayMongo's retries never record, restock or email twice.
 *   3. Even a verified event is only a prompt: the checkout session is
 *      re-read from PayMongo with the secret key and compared with the
 *      attempt recorded before the buyer left (orders.settlePaymongo).
 *
 * Events handled (PayMongo's names):
 *   checkout_session.payment.paid          settle the checkout's attempt
 *   payment.paid, payment.failed            settle, when the payment names a
 *                                           FurnishAR reference in metadata
 *   payment.refunded, payment.refund.updated   record succeeded refunds
 *
 * 200 means "do not send it again": processed, a duplicate, or not ours.
 * 400 is an unverified or malformed delivery. 500 asks PayMongo to retry.
 */
const paymongo = require('./paymongo.js');
const providers = require('./providers/index.js');
const { serverRpc } = require('./server-db.js');
const orders = require('./orders.js');

const REFERENCE = /^[A-Za-z0-9-]{6,64}$/;
const SESSION_ID = /^cs_[A-Za-z0-9]{6,64}$/;

/** The attempt a checkout session or payment is about, or null. */
async function attemptFor(resource) {
  if (resource?.type === 'checkout_session' && SESSION_ID.test(String(resource.id || ''))) {
    return serverRpc('server_payment_attempt', { p_provider_order: resource.id });
  }
  const reference = resource?.attributes?.metadata?.reference || resource?.attributes?.reference_number;
  if (REFERENCE.test(String(reference || ''))) {
    return serverRpc('server_payment_attempt_by_reference', { p_provider: 'paymongo', p_reference: String(reference) });
  }
  return null;
}

/** Refunds carried by a refund or payment resource, reduced. */
function refundsIn(resource) {
  if (resource?.type === 'refund') return [paymongo.summariseRefund(resource)];
  const list = resource?.attributes?.refunds;
  return Array.isArray(list) ? list.map(paymongo.summariseRefund).filter(Boolean) : [];
}

async function handlePaymongoWebhook(headers, rawBody, site) {
  if (!providers.PROVIDERS.paymongo.ready()) return { status: 503, body: { error: 'PayMongo is not configured.' } };
  if (!paymongo.verifyWebhookSignature(rawBody, headers['paymongo-signature'])) {
    console.warn('[paymongo] webhook refused: signature not verified');
    return { status: 400, body: { error: 'Signature not verified.' } };
  }
  let json;
  try { json = JSON.parse(rawBody); } catch { return { status: 400, body: { error: 'Not JSON.' } }; }
  const event = paymongo.parseEvent(json);
  if (!event.id || !event.type) return { status: 400, body: { error: 'Not a PayMongo event.' } };
  // A live event never settles a test order, nor the reverse.
  if (event.livemode !== (paymongo.validateConfig().mode === 'live')) {
    return { status: 200, body: { ignored: 'other mode' } };
  }

  const eventId = `paymongo:${event.id}`.slice(0, 100);
  const claimed = await serverRpc('server_claim_webhook_event', {
    p_event_id: eventId, p_type: event.type.slice(0, 100),
    p_resource: String(event.resource?.id || '').slice(0, 100) || null, p_env: paymongo.validateConfig().env
  });
  if (!claimed) return { status: 200, body: { duplicate: true } };

  try {
    let outcome = 'ignored';
    if (['checkout_session.payment.paid', 'payment.paid', 'payment.failed'].includes(event.type)) {
      const attempt = await attemptFor(event.resource);
      if (!attempt || attempt.provider !== 'paymongo') outcome = 'not a FurnishAR payment';
      else {
        const result = await orders.settlePaymongo({ site }, attempt, { notifyFailure: event.type === 'payment.failed' });
        outcome = result.state === 'paid' || result.state === 'unapplied'
          ? `${result.duplicate ? 'already recorded' : 'recorded'} (${result.status})` : result.state;
      }
    } else if (['payment.refunded', 'payment.refund.updated'].includes(event.type)) {
      const done = [];
      for (const refund of refundsIn(event.resource)) {
        const recorded = await orders.recordPaymongoRefund({ site }, refund);
        done.push(recorded?.duplicate ? 'duplicate' : recorded?.skipped ? `refund ${refund.status}` : 'refund recorded');
      }
      outcome = done.join(', ') || 'no refund';
    }
    await serverRpc('server_finish_webhook_event', { p_event_id: eventId, p_outcome: outcome });
    return { status: 200, body: { ok: true, outcome } };
  } catch (error) {
    // Not finished: PayMongo retries, and the claim can be taken again later.
    console.error(`[paymongo] webhook ${event.type} failed: ${error.message}`);
    return { status: 500, body: { error: 'Processing failed; PayMongo will retry.' } };
  }
}

module.exports = { handlePaymongoWebhook };
