'use client';

/**
 * Which backend the portal is talking to, behind one interface.
 *
 * Supabase when the deployment is configured for it (real accounts, per-store
 * rows, model uploads); otherwise the bundled catalogue and the demo shop
 * sign-ins served by /api. Moved from public/client.js so the portal's React
 * code never has to branch on which one answered.
 *
 * public/supabase.js is imported from its original location rather than copied,
 * so there is one implementation of the Supabase calls while the vanilla site
 * still exists. It moves under lib/ when that site is retired.
 */

let sb = null;
let resolved = null;

/** Loads the Supabase module if this deployment has a backend. Idempotent. */
export async function initBackend() {
  if (resolved) return resolved;
  try {
    const module = await import('../../public/supabase.js');
    if (!module.isConfigured()) {
      resolved = { kind: 'local', reason: 'No database is configured for this deployment.' };
      return resolved;
    }
    await module.prepare();
    sb = module;
    resolved = { kind: 'supabase' };
  } catch (error) {
    // prepare() records why when the server has credentials but the project
    // did not answer; that reason is worth showing, since "sign-ups are
    // closed" and "the database is misconfigured" need different responses
    // from whoever runs the site.
    let reason = error?.message;
    let outage = false;
    let configured = false;
    try {
      const module = await import('../../public/supabase.js');
      /* An outage is a configured database that did not answer, or no
         network — not a deployment without one, and not a rejected key
         (a configuration problem a retry cannot fix). */
      outage = Boolean(module.isOutage?.());
      configured = Boolean(module.databaseConfigured?.());
      reason = module.unavailable?.() || reason;
    } catch { /* module itself failed to load */ }
    console.warn('[FurnishAR] database unavailable, using the bundled catalogue:', reason);
    sb = null;
    resolved = { kind: 'local', reason, outage, configured };
  }
  return resolved;
}

export const usingSupabase = () => resolved?.kind === 'supabase' && Boolean(sb);
export const supabase = () => sb;
/**
 * True when a database is configured but could not be reached. Different from
 * "no database": that deployment has no accounts, so nothing is gated; this
 * one does, and must not open what it cannot check.
 */
export const backendOutage = () => Boolean(resolved?.outage);
/**
 * True when this deployment has a database — in use, down, or misconfigured.
 * Only a deployment WITHOUT one serves the bundled demo model.
 */
export const backendConfigured = () => resolved?.kind === 'supabase' || Boolean(resolved?.configured);
/** Why the database is not in use, when it is not. */
export const backendReason = () => resolved?.reason || null;

/** The demo API, with the session token attached when there is one. */
export async function api(path, { token, ...options } = {}) {
  const headers = {
    ...(options.body ? { 'Content-Type': 'application/json' } : {}),
    ...(options.headers || {})
  };
  if (token) headers.Authorization = `Bearer ${token}`;
  const response = await fetch(path, { ...options, headers });
  const data = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(data.error || 'The request could not be completed.');
  return data;
}

/** Demo sessions live in sessionStorage; Supabase keeps its own. */
export const demoSession = {
  read() {
    try {
      return {
        token: sessionStorage.getItem('furnishar-token') || '',
        user: JSON.parse(sessionStorage.getItem('furnishar-user') || 'null')
      };
    } catch {
      return { token: '', user: null };
    }
  },
  write(token, user) {
    try {
      sessionStorage.setItem('furnishar-token', token);
      sessionStorage.setItem('furnishar-user', JSON.stringify(user));
    } catch { /* private mode */ }
  },
  clear() {
    try {
      sessionStorage.removeItem('furnishar-token');
      sessionStorage.removeItem('furnishar-user');
    } catch { /* private mode */ }
  }
};
