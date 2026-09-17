'use client';

import { useEffect, useState } from 'react';

/**
 * A one-time notice about local storage.
 *
 * Deliberately NOT a consent gate with an "accept" that unlocks tracking,
 * because there is nothing here to consent to. Verified against the code, not
 * assumed: there is no analytics dependency, no gtag or tag-manager snippet,
 * and `document.cookie` is never written anywhere in the project. What is kept
 * is the sign-in (sessionStorage, so it goes when the tab closes), the chosen
 * theme, and the planner's measurement preference — all strictly necessary or
 * user-requested, which under the GDPR and the Philippines' Data Privacy Act
 * needs disclosure, not permission.
 *
 * If analytics are ever added, this copy stops being true and must change with
 * them.
 *
 * So this says what is stored and goes away. Building a fake "reject" button
 * that does nothing would be worse than not asking: it implies a choice the
 * site is not actually offering.
 *
 * Rendered only after mount. The dismissal lives in localStorage, which the
 * server cannot read, so rendering it during SSR would flash the banner at
 * people who dismissed it months ago.
 */
const STORAGE_KEY = 'furnishar-storage-notice';

export default function CookieNotice() {
  const [visible, setVisible] = useState(false);

  useEffect(() => {
    try {
      if (!localStorage.getItem(STORAGE_KEY)) setVisible(true);
    } catch {
      // Storage blocked entirely. Showing a dismissable notice that cannot be
      // dismissed would nag on every page view, so stay quiet.
    }
  }, []);

  function dismiss() {
    setVisible(false);
    try {
      localStorage.setItem(STORAGE_KEY, 'seen');
    } catch { /* see above */ }
  }

  if (!visible) return null;

  return (
    <div className="cookie-notice" role="region" aria-label="Storage notice">
      <p>
        FurnishAR keeps your theme and planner settings on this device, and your
        sign-in until you close the tab. No advertising or analytics cookies,
        and nothing is shared.
      </p>
      <button className="button button-primary" type="button" onClick={dismiss}>
        Got it
      </button>
    </div>
  );
}
