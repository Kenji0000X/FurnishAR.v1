import { Suspense } from 'react';
import GoogleCallback from './GoogleCallback.js';

/**
 * Where Google (through Supabase Auth) sends someone back after they
 * choose their account. Nothing is rendered on the server: the page only
 * trades the one-time code for a session and moves on.
 */
export const dynamic = 'force-dynamic';

export const metadata = {
  title: 'Signing you in',
  robots: { index: false, follow: false, nocache: true },
  referrer: 'no-referrer'
};

export default function CallbackPage() {
  return (
    <section className="view login-view active" aria-labelledby="callback-title">
      <Suspense fallback={<p className="card-copy">Signing you in…</p>}>
        <GoogleCallback />
      </Suspense>
    </section>
  );
}
