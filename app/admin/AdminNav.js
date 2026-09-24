'use client';

import Link from 'next/link';
import { usePathname } from 'next/navigation';

/**
 * Seven destinations, each a real URL.
 *
 * The console's sections used to be stacked down one page with two tabs
 * switching only the application list. That meant there was no way to link
 * anyone to the review queue, the browser's Back button did nothing useful,
 * and an operator checking storage scrolled past every applicant's email
 * address to reach it.
 *
 * The pending count rides on the Applications entry because it is the one
 * number that means "someone is waiting on you". It is the real count of
 * applications with status 'pending', not a decoration.
 */
const SECTIONS = [
  ['/admin', 'Overview'],
  ['/admin/applications', 'Applications'],
  ['/admin/stores', 'Stores'],
  ['/admin/models', '3D files'],
  ['/admin/usage', 'Usage'],
  ['/admin/billing', 'Billing'],
  ['/admin/activity', 'Activity']
];

export default function AdminNav({ pending = 0, email, onSignOut }) {
  const pathname = usePathname();

  return (
    <div className="admin-bar">
      <nav className="admin-nav" aria-label="Console sections">
        <ul>
        {SECTIONS.map(([href, label]) => {
          /* Exact match for the index, prefix for the rest — otherwise
             /admin/stores would light up Overview as well as itself. */
          const active = href === '/admin' ? pathname === '/admin' : pathname.startsWith(href);
          return (
            <li key={href}>
              <Link
                href={href}
                className={`admin-nav-link${active ? ' is-active' : ''}`}
                aria-current={active ? 'page' : undefined}
              >
                {label}
                {href === '/admin/applications' && pending > 0 && (
                  <span className="admin-nav-count" aria-label={`${pending} awaiting review`}>
                    {pending}
                  </span>
                )}
              </Link>
            </li>
          );
        })}
        </ul>
      </nav>

      {/*
          Signing out of the console.

          There was no way to do it from here at all. The portal has had a
          Sign out button since it was built, but an admin who finished
          reviewing applications had to navigate to /portal to leave — on a
          shared or borrowed machine that is the difference between closing
          the queue and leaving every applicant's email address open on it.
      */}
      <div className="admin-who">
        {email && <span className="admin-who-email" title={email}>{email}</span>}
        <button className="button button-outline admin-signout" type="button" onClick={onSignOut}>
          Sign out
        </button>
      </div>
    </div>
  );
}
