/**
 * Model expiry notices, on a schedule.                   DFD: P11 → Email
 *
 * Called daily by the scheduler (vercel.json "crons") with
 * `Authorization: Bearer $CRON_SECRET`; refused without it, so a visitor can
 * never send a shop an email. What is due, and marking it sent, is the
 * database's (0013) — see lib/model-notices.js.
 */
import { timingSafeEqual } from 'node:crypto';
import notices from '../../../../lib/model-notices.js';

export const dynamic = 'force-dynamic';

function authorised(request) {
  const secret = String(process.env.CRON_SECRET || '').trim();
  if (secret.length < 16) return false;
  const given = Buffer.from(request.headers.get('authorization') || '');
  const expected = Buffer.from(`Bearer ${secret}`);
  return given.length === expected.length && timingSafeEqual(given, expected);
}

export async function GET(request) {
  if (!authorised(request)) return Response.json({ error: 'Not allowed.' }, { status: 401 });
  const site = (process.env.SITE_URL || new URL(request.url).origin).replace(/\/$/, '');
  try {
    return Response.json(await notices.sendModelExpiryNotices(site), { headers: { 'Cache-Control': 'no-store' } });
  } catch (error) {
    console.error('[model-notices] failed:', error?.message);
    return Response.json({ error: 'Model notices failed.' }, { status: 500 });
  }
}
