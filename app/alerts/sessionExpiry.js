'use client';

import { alerts } from './useAlert.js';

/**
 * "You are not signed in" and "your session expired" are different sentences.
 *
 * A protected page asks the server who is looking, and a dead session and a
 * visitor who never signed in both come back as `guest`. Without this, the
 * shopper whose session ran out mid-afternoon was shown the same generic
 * "Sign in to measure your space" as a first-time visitor — which reads as
 * the site having forgotten them for no reason.
 *
 * The difference is on the client, and it takes one of two shapes:
 *
 *   held     the tab still holds a session the server no longer honours
 *            (it answered "guest" for it);
 *   lapsed   the tab tried to renew its session and GoTrue refused, so the
 *            client has already dropped it (public/supabase.js).
 *
 * A first-time visitor is neither. When it is one of them, say so — once, as
 * a critical alert that stays until read — with a sign-in that returns to
 * `next`, and drop the dead session so the next request does not present it
 * again.
 *
 * Only call this with a server's answer of "guest". A question the server
 * could not answer (myRole() throws `unreachable`) is an outage, not an
 * expiry, and must not sign anybody out.
 *
 * Returns true when it was an expiry (and it said so).
 */
export async function noticeExpiredSession(sb, next) {
  let held = null;
  try { held = await sb.getSession(); } catch { held = null; }
  const lapsed = Boolean(sb.sessionLapsed?.());
  if (!held && !lapsed) return false;

  alerts.raise('auth.expired', {
    actions: [{ label: 'Sign in again', href: `/login?as=buyer&next=${encodeURIComponent(next)}` }]
  });
  sb.forgetLapsedSession?.();
  if (held) {
    try { await sb.signOut(); } catch { /* it is already dead; this only tidies */ }
  }
  return true;
}
