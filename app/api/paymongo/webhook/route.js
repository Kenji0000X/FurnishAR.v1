/**
 * PayMongo webhooks (GCash).                          DFD: PayMongo → P10
 *
 * Every delivery's Paymongo-Signature is verified against the raw body
 * before anything is read, each event is processed once, and the checkout is
 * re-read from PayMongo with the secret key. See lib/paymongo-webhook.js.
 */
import paymongoWebhook from '../../../../lib/paymongo-webhook.js';

export const dynamic = 'force-dynamic';

export async function POST(request) {
  const raw = await request.text();
  const site = (process.env.SITE_URL || new URL(request.url).origin).replace(/\/$/, '');
  try {
    const result = await paymongoWebhook.handlePaymongoWebhook(Object.fromEntries(request.headers), raw, site);
    return Response.json(result.body, { status: result.status, headers: { 'Cache-Control': 'no-store' } });
  } catch (error) {
    console.error('[paymongo] webhook error:', error?.message);
    return Response.json({ error: 'Processing failed; PayMongo will retry.' }, { status: 500 });
  }
}
