'use client';

import { usePathname } from 'next/navigation';

/**
 * Hides the public footer on the workspace routes.
 *
 * The store portal and the admin console are places somebody works, not pages
 * somebody browses: a full site footer under a table of products is a column
 * of links back out of the thing they just signed in to do. Marked for removal
 * on both screens, and removed.
 *
 * A client wrapper rather than a client footer, so SiteFooter stays a server
 * component and can keep reading the build stamp out of the environment.
 */
export default function ChromeGate({ children }) {
  const pathname = usePathname();
  if (pathname.startsWith('/portal') || pathname.startsWith('/admin')) return null;
  return children;
}
