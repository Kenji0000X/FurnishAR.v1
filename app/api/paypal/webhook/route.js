/**
 * PayPal webhooks.                                        DFD: PayPal → P10
 *
 * Every delivery is verified with PayPal (verify-webhook-signature, against
 * PAYPAL_WEBHOOK_ID) before anything is read from it, then processed once
 * per event id (payment_webhook_events). The body is read raw so the event
 * PayPal signed is the event verified. See lib/payments.js.
 */
import payments from '../../../../lib/payments.js';

export const dynamic = 'force-dynamic';

export async function POST(request) {
  const raw = await request.text();
  const site = (process.env.SITE_URL || new URL(request.url).origin).replace(/\/$/, '');
  try {
    const result = await payments.handleWebhook(Object.fromEntries(request.headers), raw, site);
    return Response.json(result.body, { status: result.status, headers: { 'Cache-Control': 'no-store' } });
  } catch (error) {
    console.error('[paypal] webhook error:', error?.message);
    return Response.json({ error: 'Processing failed; PayPal will retry.' }, { status: 500 });
  }
}
