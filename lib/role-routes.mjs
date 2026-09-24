/**
 * Where an account goes once it is signed in, decided by its ROLE from
 * my_role() (the database) — never by the button someone pressed, the
 * provider they used, or anything in the URL.              DFD: P1 → P6/P7/P8
 *
 *   admin       /admin       (platform_admins only; Google never makes one)
 *   owner       /portal
 *   pending     /portal      (the "in review" panel)
 *   buyer       `next` when it is a safe path, else /account
 *   onboarding  /onboarding  (choose buyer or store), carrying next/intent
 */
import { safeLocalPath } from './safe-path.mjs';

export function destinationFor(role, { next = null, intent = null } = {}) {
  const safe = safeLocalPath(next);
  switch (role) {
    case 'admin': return '/admin';
    case 'owner':
    case 'pending': return '/portal';
    case 'buyer': return safe || '/account';
    case 'onboarding': {
      const query = new URLSearchParams();
      if (intent === 'buyer' || intent === 'store') query.set('as', intent);
      if (safe) query.set('next', safe);
      const tail = query.toString();
      return `/onboarding${tail ? `?${tail}` : ''}`;
    }
    default: return '/login';
  }
}

/** oauth_error / exchange codes → the alert that explains them. */
export const OAUTH_ALERTS = Object.freeze({
  access_denied: 'auth.google-cancelled',
  cancelled: 'auth.google-cancelled',
  provider_unavailable: 'auth.google-unavailable',
  unavailable: 'auth.google-unavailable',
  expired: 'auth.google-expired',
  already_used: 'auth.google-used',
  state_missing: 'auth.google-used',
  missing_code: 'auth.google-failed',
  network: 'auth.network',
  rate_limited: 'auth.rate-limited',
  failed: 'auth.google-failed'
});

export function oauthAlert(code) {
  return OAUTH_ALERTS[String(code || '')] || 'auth.google-failed';
}
