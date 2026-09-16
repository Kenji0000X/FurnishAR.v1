'use client';

/**
 * The portal's backend.
 *
 * The Supabase integration was removed, so there is one backend: this app's own
 * /api routes, backed by data/catalog.json and the demo shop sign-ins in
 * lib/handler.js. Nothing here talks to a third party.
 *
 * Catalogue writes work locally but not on Vercel, where the function
 * filesystem is read-only — the API answers those with a clear 503 rather than
 * pretending to save. Restoring a database is what lifts that.
 */

/** Calls the app's own API, with the session token attached when there is one. */
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

/** Sessions live in sessionStorage: they last for the tab, and no longer. */
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
