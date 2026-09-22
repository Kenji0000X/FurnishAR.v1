'use client';

import { usePathname } from 'next/navigation';

/**
 * Hides the public chrome on the workspace routes.
 *
 * The store portal and the admin console are places somebody works, not pages
 * somebody browses: a full site footer under a table of products is a column
 * of links back out of the thing they just signed in to do. Marked for removal
 * on both screens, and removed.
 *
 * The same now goes for the shopper navigation. The burger is gone from the
 * header on these routes, and the bottom bar is the phone's version of that
 * exact menu — leaving it would have made the removal a desktop-only fix,
 * with a store owner on a phone still staring at Discover / Collection / Scan
 * across the bottom of their own dashboard.
 *
 * A client wrapper rather than a client footer, so SiteFooter stays a server
 * component and can keep reading the build stamp out of the environment.
 */
export default function ChromeGate({ children }) {
  const pathname = usePathname();
  if (pathname.startsWith('/portal') || pathname.startsWith('/admin')) return null;
  return children;
}
