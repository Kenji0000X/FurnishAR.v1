/**
 * Payment-setup reminders, on a schedule.                 DFD: P10 → Email
 *
 * Called by the scheduler (vercel.json "crons"), which sends
 * `Authorization: Bearer $CRON_SECRET`. Without that secret the route
 * refuses, so a visitor — or a page loading — can never send a reminder.
 * The cooldown and the cap live in the database (0011) and in
 * PAYPAL_REMINDER_COOLDOWN_HOURS / PAYPAL_REMINDER_MAX.
 */
import { timingSafeEqual } from 'node:crypto';
import payments from '../../../../lib/payments.js';

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
    return Response.json(await payments.sendPaymentReminders(site), { headers: { 'Cache-Control': 'no-store' } });
  } catch (error) {
    console.error('[reminders] failed:', error?.message);
    return Response.json({ error: 'Reminders failed.' }, { status: 500 });
  }
}
