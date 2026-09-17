/**
 * The data access layer: who is calling, and may they.
 *
 * WHY THIS EXISTS
 * The Next.js authentication guide is blunt about the pattern this app uses —
 * a Proxy (what middleware is called in Next 16) "should not be your only line
 * of defense", and "the majority of security checks should be performed as
 * close as possible to your data source". Row level security is that check for
 * us and it is the one that actually protects the rows: every policy in
 * supabase/migrations/0003_platform_admin.sql is proved in tests/admin.test.js
 * by connecting as the wrong person and being refused.
 *
 * This module is the layer in front of it, on the server, so that an
 * unauthenticated or non-admin request for the sign-up queue is answered here
 * rather than being handed to Postgres to refuse. Two reasons that is worth
 * having:
 *
 *   1. Defence in depth. If a policy is ever dropped by a bad migration, the
 *      applicants' email addresses and phone numbers do not become world
 *      readable the same afternoon.
 *   2. Honest answers. RLS expresses "not permitted" as an empty result, which
 *      is indistinguishable from "nothing waiting". A caller who is not an
 *      admin should be told 403, not handed an empty list.
 *
 * WHAT IT REFUSES TO TRUST
 * Only the bearer token. Not a header, not a field in the body, not a cookie
 * the browser set itself — every claim of identity is re-checked against
 * Supabase on the request that uses it. There is deliberately no cache: an
 * admin removed from `platform_admins` loses the console on their next call,
 * not thirty seconds later.
 */

/** Resources only a platform administrator may reach through the proxy. */
const ADMIN_ONLY_TABLES = new Set(['store_applications', 'platform_admins', 'admin_audit']);

/**
 * The one way in that is not for admins.
 *
 * `store_applications` is the sign-up form: anybody may file one, and only an
 * admin may read the pile — that asymmetry is the table's whole design (see
 * 0001's store_applications_public_insert, and 0003's read policy). Gating the
 * insert would lock every prospective store owner out of applying, which is
 * exactly what it did for one run of `npm run check:auth` before this existed.
 */
const PUBLIC_METHODS = new Map([['store_applications', new Set(['POST'])]]);

/**
 * Functions only a platform administrator may call.
 *
 * `is_platform_admin` is intentionally absent: anyone signed in may ask
 * whether *they* are one, and must be able to — it is how the portal decides
 * whether to show the console link. It reports on the caller and nobody else.
 */
const ADMIN_ONLY_FUNCTIONS = new Set([
  'approve_store_application',
  'reject_store_application',
  'applicant_account',
  'storage_usage'
]);

/** Does this PostgREST request need an administrator? */
function needsAdmin(path, method = 'GET') {
  const [first, second] = String(path || '').split(/[?/]/);
  if (first === 'rpc') return ADMIN_ONLY_FUNCTIONS.has(second);
  if (!ADMIN_ONLY_TABLES.has(first)) return false;
  return !PUBLIC_METHODS.get(first)?.has(String(method).toUpperCase());
}

async function readJson(response) {
  const text = await response.text();
  try { return text ? JSON.parse(text) : null; } catch { return text; }
}

/**
 * Who is this token? Asks Supabase, which is the only party that can answer.
 *
 * A token is a signed JWT and we could verify it locally against the JWKS, but
 * that would only prove it was issued — not that the account still exists, is
 * still confirmed, or has not been signed out. Asking GoTrue answers the
 * question that matters.
 */
async function verifySession({ url, key, token, call }) {
  if (!token) return null;
  const response = await call(`${url}/auth/v1/user`, {
    headers: { apikey: key, Authorization: `Bearer ${token}` }
  });
  if (!response.ok) return null;
  const user = await readJson(response);
  return user && user.id ? { id: user.id, email: user.email || null } : null;
}

/**
 * Is this token's owner a platform administrator?
 *
 * Asked of the database as that user, so the answer comes from the same
 * `platform_admins` table the policies read — there is no second list to fall
 * out of step with, and no way to be an admin here but not there.
 */
async function isPlatformAdmin({ url, key, token, call }) {
  const response = await call(`${url}/rest/v1/rpc/is_platform_admin`, {
    method: 'POST',
    headers: { apikey: key, Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
    body: '{}'
  });
  if (!response.ok) return false;
  return (await readJson(response)) === true;
}

/**
 * The gate. Returns null to let the request through, or the response to send
 * instead.
 *
 * Fails closed: anything unexpected — a token GoTrue will not confirm, an RPC
 * that errors — is a refusal, never a pass.
 */
async function guardAdminRequest({ url, key, token, path, method, call }) {
  if (!needsAdmin(path, method)) return null;

  if (!token) {
    return { status: 401, body: { error: 'Sign in to use the platform console.' } };
  }

  const session = await verifySession({ url, key, token, call });
  if (!session) {
    // Expired, revoked, or never real. Distinct from 403 on purpose: the fix
    // is to sign in again, not to ask someone for access.
    return { status: 401, body: { error: 'Your session has expired. Sign in again.' } };
  }

  if (!await isPlatformAdmin({ url, key, token: token, call })) {
    // Says nothing about what is behind the wall — not how many applications
    // are waiting, not who the administrators are.
    return { status: 403, body: { error: 'This is limited to platform administrators.' } };
  }

  return null;
}

module.exports = {
  ADMIN_ONLY_TABLES,
  ADMIN_ONLY_FUNCTIONS,
  PUBLIC_METHODS,
  needsAdmin,
  verifySession,
  isPlatformAdmin,
  guardAdminRequest
};
