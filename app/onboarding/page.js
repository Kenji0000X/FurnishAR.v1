import { Suspense } from 'react';
import Onboarding from './Onboarding.js';

/**
 * First sign-in with no role yet: "What will you use FurnishAR for?"
 * Per-person, so never prerendered or cached.
 */
export const dynamic = 'force-dynamic';

export const metadata = {
  title: 'Set up your account',
  robots: { index: false, follow: false, nocache: true }
};

export default function OnboardingPage() {
  return (
    <section className="view login-view active" aria-labelledby="onboarding-title">
      <Suspense fallback={<p className="card-copy">One moment…</p>}>
        <Onboarding />
      </Suspense>
    </section>
  );
}
