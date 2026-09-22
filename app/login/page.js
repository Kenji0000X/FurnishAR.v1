import { Suspense } from 'react';
import LoginChooser from './LoginChooser.js';

/**
 * The one sign-in door, for both kinds of account.
 *
 * Nothing is server-rendered into it: it decides what to show from who is
 * already signed in, and a statically generated page could be cached and
 * served to the wrong person.
 */
export const dynamic = 'force-dynamic';

export const metadata = {
  title: 'Sign in',
  description: 'Sign in to FurnishAR as a shopper, or head to the store portal.',
  robots: { index: false, follow: true }
};

export default function LoginPage() {
  return (
    <section className="view login-view active" aria-labelledby="login-title">
      {/* useSearchParams needs a boundary; without one the whole route opts
          out of static rendering with a build-time error rather than a
          readable page. */}
      <Suspense fallback={<p className="card-copy">One moment…</p>}>
        <LoginChooser />
      </Suspense>
    </section>
  );
}
