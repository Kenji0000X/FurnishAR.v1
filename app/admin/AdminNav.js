'use client';

import Link from 'next/link';
import { usePathname } from 'next/navigation';

/**
 * Six destinations, each a real URL.
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
  ['/admin/activity', 'Activity']
];

export default function AdminNav({ pending = 0 }) {
  const pathname = usePathname();

  return (
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
  );
}
