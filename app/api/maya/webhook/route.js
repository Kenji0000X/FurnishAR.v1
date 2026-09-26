/**
 * Maya webhooks.                                          DFD: Maya → P10
 *
 * Maya does not sign its webhooks, so a delivery is only a prompt: the
 * payment it names is re-read from Maya with the secret key before anything
 * is recorded, and each (payment, status) is processed once. See
 * lib/maya-webhook.js.
 */
import mayaWebhook from '../../../../lib/maya-webhook.js';

export const dynamic = 'force-dynamic';

export async function POST(request) {
  const raw = await request.text();
  const site = (process.env.SITE_URL || new URL(request.url).origin).replace(/\/$/, '');
  try {
    const result = await mayaWebhook.handleMayaWebhook(Object.fromEntries(request.headers), raw, site);
    return Response.json(result.body, { status: result.status, headers: { 'Cache-Control': 'no-store' } });
  } catch (error) {
    console.error('[maya] webhook error:', error?.message);
    return Response.json({ error: 'Processing failed; Maya will retry.' }, { status: 500 });
  }
}
