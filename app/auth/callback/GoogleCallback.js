'use client';

import Link from 'next/link';
import { useRouter, useSearchParams } from 'next/navigation';
import { useEffect, useRef, useState } from 'react';
import { initBackend, usingSupabase, supabase } from '../../portal/backend.js';
import { consumeAuthIntent } from '../../../lib/auth-intent.js';
import { destinationFor, oauthAlert } from '../../../lib/role-routes.mjs';
import { CATALOG } from '../../../lib/alerts/messages.mjs';
import useAlert from '../../alerts/useAlert.js';

/**
 * The end of "Continue with Google".                           DFD: P1
 *
 * 1. Supabase put either ?code= or ?error= on this URL.
 * 2. The code goes to POST /api/sb/auth/exchange with the httpOnly flow
 *    cookie; the server returns a session (never Google's own tokens) and
 *    the safe destination the flow started with.
 * 3. The ROLE comes from my_role(), and decides where to go
 *    (lib/role-routes.mjs). A brand-new account goes to /onboarding.
 *
 * The code is removed from the address bar at once, and exchanged at most
 * once per page load (React may run effects twice in development; a code
 * is good once, and a second try would read as "already used").
 */
let exchanging = null;

export default function GoogleCallback() {
  const router = useRouter();
  const params = useSearchParams();
  const alert = useAlert();
  const [problem, setProblem] = useState(null);
  const done = useRef(false);

  useEffect(() => {
    if (done.current) return;
    done.current = true;
    const code = params.get('code');
    const error = params.get('error');
    const errorCode = params.get('error_code');
    // Keep neither the code nor the error in history or in a shared link.
    window.history.replaceState(null, '', '/auth/callback');

    (async () => {
      await initBackend();
      if (!usingSupabase()) { setProblem('provider_unavailable'); return; }
      const sb = supabase();

      let flow = { next: null, intent: null };
      if (error) {
        const reason = error === 'access_denied' ? 'cancelled'
          : /expired/.test(errorCode || '') ? 'expired' : 'failed';
        // Signed in already (a second tab finished first)? Then nothing failed.
        if (await sb.myRole().catch(() => 'guest') === 'guest') { setProblem(reason); return; }
      } else if (!code) {
        if (await sb.myRole().catch(() => 'guest') === 'guest') { setProblem('missing_code'); return; }
      } else {
        try {
          exchanging ||= sb.completeGoogleSignIn(code);
          flow = await exchanging;
        } catch (failure) {
          // A duplicate callback after a successful one: carry on signed in.
          if (await sb.myRole().catch(() => 'guest') === 'guest') {
            setProblem(failure.code || 'failed');
            return;
          }
        }
      }

      let role;
      try {
        role = await sb.myRole();
      } catch {
        setProblem('network');
        return;
      }
      // The tab's remembered destination (lib/auth-intent.js) is the fallback.
      const remembered = consumeAuthIntent();
      const next = flow.next || remembered;
      if (role !== 'onboarding') alert.raise('auth.signed-in');
      router.replace(destinationFor(role, { next, intent: flow.intent }));
    })();
  }, [params, router, alert]);

  if (!problem) {
    return (
      <div className="login-panel" aria-busy="true">
        <div className="login-copy">
          <span className="secure-mark" aria-hidden="true">⌑</span>
          <h1 id="callback-title">Signing you in…</h1>
          <p><span className="loading-spinner" aria-hidden="true" /> Checking your Google sign-in with FurnishAR.</p>
        </div>
      </div>
    );
  }

  const message = CATALOG[oauthAlert(problem)];
  return (
    <div className="login-panel">
      <div className="login-copy">
        <span className="secure-mark" aria-hidden="true">⌑</span>
        <h1 id="callback-title">{message.title}</h1>
        <p role="alert">{message.message}</p>
      </div>
      <div className="panel-actions">
        <Link className="button button-primary" href="/login">Back to sign in</Link>
        <Link className="button button-outline" href="/collection">Browse furniture</Link>
      </div>
    </div>
  );
}
