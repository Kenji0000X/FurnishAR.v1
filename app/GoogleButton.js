'use client';

import { useEffect, useState } from 'react';

/* One question per page load: does this deployment have the database that
   Google sign-in needs? Without one, /api/sb/auth/google answers 503 and the
   button would be a dead end, so it steps aside. Shown by default so a real
   deployment never waits on this, and never shifts when the answer arrives. */
let configured = null;
function databaseConfigured() {
  if (!configured) {
    configured = fetch('/api/sb/status', { headers: { Accept: 'application/json' } })
      .then(response => response.json())
      .then(status => status.configured !== false)
      .catch(() => true);
  }
  return configured;
}
import { saveAuthIntent } from '../lib/auth-intent.js';

/**
 * "Continue with Google". A plain navigation to this app's own server
 * (/api/sb/auth/google), which keeps the PKCE verifier in an httpOnly cookie
 * and hands the browser to Google. Nothing secret is on this page.
 *
 * `intent` is only a hint for the first sign-in ("buyer" skips the
 * question on /onboarding). It is never a role: the role comes from the
 * database after sign-in.
 */
export default function GoogleButton({ next = null, intent = null, label = 'Continue with Google' }) {
  const [leaving, setLeaving] = useState(false);
  const [available, setAvailable] = useState(true);
  useEffect(() => {
    let live = true;
    databaseConfigured().then(yes => { if (live) setAvailable(yes); });
    return () => { live = false; };
  }, []);
  const query = new URLSearchParams();
  if (next) query.set('next', next);
  if (intent) query.set('intent', intent);
  const href = `/api/sb/auth/google${query.size ? `?${query}` : ''}`;
  if (!available) return null;

  return (
    <a
      className="button button-google"
      href={href}
      aria-busy={leaving || undefined}
      onClick={() => {
        // Also remember it in this tab, the same as the password path.
        if (next) saveAuthIntent(next);
        setLeaving(true);
      }}
    >
      {leaving
        ? <span className="loading-spinner" aria-hidden="true" />
        : (
          <svg className="google-mark" viewBox="0 0 18 18" width="18" height="18" aria-hidden="true">
            <path fill="#4285F4" d="M17.64 9.2c0-.64-.06-1.25-.16-1.84H9v3.48h4.84a4.14 4.14 0 0 1-1.8 2.72v2.26h2.92c1.7-1.57 2.68-3.88 2.68-6.62z" />
            <path fill="#34A853" d="M9 18c2.43 0 4.47-.8 5.96-2.18l-2.92-2.26c-.8.54-1.84.86-3.04.86-2.34 0-4.32-1.58-5.03-3.7H.96v2.33A9 9 0 0 0 9 18z" />
            <path fill="#FBBC05" d="M3.97 10.72A5.4 5.4 0 0 1 3.68 9c0-.6.1-1.18.29-1.72V4.95H.96A9 9 0 0 0 0 9c0 1.45.35 2.83.96 4.05l3.01-2.33z" />
            <path fill="#EA4335" d="M9 3.58c1.32 0 2.5.45 3.44 1.35l2.58-2.58A9 9 0 0 0 .96 4.95l3.01 2.33C4.68 5.16 6.66 3.58 9 3.58z" />
          </svg>
        )}
      <span>{leaving ? 'Opening Google…' : label}</span>
    </a>
  );
}
