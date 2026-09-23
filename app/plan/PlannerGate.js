'use client';

import Link from 'next/link';
import { usePathname, useSearchParams } from 'next/navigation';
import { useEffect, useState } from 'react';
import { initBackend, usingSupabase, supabase, backendReason, backendOutage } from '../portal/backend.js';
import { noticeExpiredSession } from '../alerts/sessionExpiry.js';
import { saveAuthIntent } from '../../lib/auth-intent.js';

/**
 * The planner asks who you are before it opens the camera.
 *
 * The catalogue stays open to anyone — a shopper can browse every piece of
 * furniture on FurnishAR without an account, and should, because a site you
 * cannot look at is a site nobody shares. The planner is where the line is:
 * it is the thing the account exists for.
 *
 * Three things this must not do, all of which are easy to do by accident:
 *
 *   - Flash the planner and then take it away. The gate renders nothing until
 *     the server has answered, so nobody sees the camera prompt and then a
 *     sign-in wall.
 *   - Lock out a deployment with no database. FurnishAR runs on the bundled
 *     catalogue when Supabase is not configured, and in that state there are
 *     no accounts to require — gating on an account nobody can create would
 *     make the planner permanently unreachable. It opens.
 *   - Lose where you were going. The sign-in link carries the WHOLE address
 *     — path and query — as ?next=. It used to carry a hard-coded "/plan",
 *     which dropped the ?product= a shopper arrived with from a product page:
 *     they asked to see the cane armchair in their room, signed in, and were
 *     returned to an empty planner with nothing chosen. Now they come back to
 *     the same piece, already selected.
 *
 * A store owner is let through. They are signed in, they are a real account,
 * and a shop standing its own model in a room to check the scale is a use of
 * the planner, not an abuse of it.
 *
 * And one it must tell apart: a server that did not ANSWER is not a server
 * that said "guest". An outage gets its own screen and a retry, keeps the
 * sign-in, and never reads as an expired session.
 */
export default function PlannerGate({ children }) {
  const [state, setState] = useState('checking'); // checking | open | locked | unreachable
  const [attempt, setAttempt] = useState(0);
  const pathname = usePathname();
  const params = useSearchParams();
  const query = params.toString();
  const here = `${pathname}${query ? `?${query}` : ''}`;
  const signIn = `/login?as=buyer&next=${encodeURIComponent(here)}`;
  /* Cancel goes back to the piece they came from when there is one — the
     product page, not a generic catalogue — and to the catalogue otherwise. */
  const product = params.get('product');
  const cancel = product ? `/furniture/${encodeURIComponent(product)}` : '/collection';

  /* Remembered for this tab as well as carried in ?next=, so a sign-in
     reached some other way (the header's Sign in, say) still comes back
     here. The whole address, not "/plan": the piece is the point. */
  useEffect(() => {
    if (state !== 'locked') return;
    saveAuthIntent(here);
  }, [state, here]);

  useEffect(() => {
    let alive = true;
    (async () => {
      await initBackend();
      if (!alive) return;
      if (!usingSupabase()) {
        /* A database that is configured and not answering is an outage, and
           this deployment has accounts: nothing opens that cannot be checked. */
        if (backendOutage()) { setState('unreachable'); return; }
        /* No accounts exist in this deployment at all. See above. */
        console.info('[FurnishAR] no database configured, the planner is open:',
          backendReason() || 'no reason given');
        setState('open');
        return;
      }
      let role;
      try {
        role = await supabase().myRole();
      } catch {
        if (alive) setState('unreachable');
        return;
      }
      /* A dead session is not a first visit: say it expired, with a way back
         to this exact piece, before showing the sign-in gate. */
      if (role === 'guest') await noticeExpiredSession(supabase(), here);
      if (alive) setState(role === 'guest' ? 'locked' : 'open');
    })();
    return () => { alive = false; };
  }, [here, attempt]);

  if (state === 'checking') return <p className="card-copy">One moment…</p>;

  if (state === 'unreachable') {
    return (
      <div className="login-panel">
        <div className="login-copy" role="alert">
          <span className="secure-mark" aria-hidden="true">⌑</span>
          <h1 id="planner-title">The planner can&rsquo;t reach the server.</h1>
          <p>Connection failed. Check your internet connection and try again.</p>
        </div>
        <div className="panel-actions">
          <button
            className="button button-primary"
            type="button"
            onClick={() => {
              /* An outage found while the page was starting is remembered by
                 initBackend(); only a fresh load asks again. */
              if (backendOutage()) { window.location.reload(); return; }
              setState('checking');
              setAttempt(n => n + 1);
            }}
          >
            Try again
          </button>
          <Link className="button button-outline" href={cancel}>Back to furniture</Link>
        </div>
      </div>
    );
  }

  if (state === 'locked') {
    return (
      <div className="login-panel">
        <div className="login-copy">
          <span className="secure-mark" aria-hidden="true">⌑</span>
          <h1 id="planner-title">Sign in to measure your space.</h1>
          <p>
            The planner uses your phone&rsquo;s camera to measure a room and stand a real
            piece of furniture in it, at its real size. It needs an account —
            a name, a town and a password.
          </p>
          <p className="demo-note">
            Browsing is open to everyone: the whole{' '}
            <Link href="/collection">catalogue</Link> is there without an account.
          </p>
        </div>
        <div className="panel-actions">
          <Link className="button button-primary" href={signIn}>
            Sign in <span aria-hidden="true">→</span>
          </Link>
          <Link className="button" href={`${signIn}&mode=signup`}>Create account</Link>
          <Link className="button button-outline" href={cancel}>Cancel</Link>
        </div>
      </div>
    );
  }

  return children;
}
