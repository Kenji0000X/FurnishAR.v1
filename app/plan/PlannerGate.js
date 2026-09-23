'use client';

import Link from 'next/link';
import { useEffect, useState } from 'react';
import { initBackend, usingSupabase, supabase, backendReason } from '../portal/backend.js';
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
 *   - Lose where you were going. The sign-in link carries ?next=/plan, so
 *     signing in lands back here rather than on an account page.
 *
 * A store owner is let through. They are signed in, they are a real account,
 * and a shop standing its own model in a room to check the scale is a use of
 * the planner, not an abuse of it.
 */
export default function PlannerGate({ children }) {
  const [state, setState] = useState('checking'); // checking | open | locked

  useEffect(() => {
    if (state !== 'locked') return;
    saveAuthIntent('/plan');
  }, [state]);

  useEffect(() => {
    let alive = true;
    (async () => {
      await initBackend();
      if (!alive) return;
      if (!usingSupabase()) {
        /* No accounts exist in this deployment at all. See above. */
        console.info('[FurnishAR] no database configured, the planner is open:',
          backendReason() || 'no reason given');
        setState('open');
        return;
      }
      const role = await supabase().myRole().catch(() => 'guest');
      if (alive) setState(role === 'guest' ? 'locked' : 'open');
    })();
    return () => { alive = false; };
  }, []);

  if (state === 'checking') return <p className="card-copy">One moment…</p>;

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
          <Link className="button button-primary" href="/login?as=buyer&next=/plan">
            Sign in or create an account <span aria-hidden="true">→</span>
          </Link>
          <Link className="button" href="/collection">Browse the catalogue</Link>
        </div>
      </div>
    );
  }

  return children;
}
