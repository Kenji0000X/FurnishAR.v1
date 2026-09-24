'use client';

import { useEffect } from 'react';
import { usePathname } from 'next/navigation';
import {
  SquaresFour, Tray, Storefront, Cube, HardDrives, Receipt, ClockCounterClockwise
} from '@phosphor-icons/react/dist/ssr';
import ConsoleShell from '../console/ConsoleShell.js';

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
  ['/admin', 'Overview', SquaresFour],
  ['/admin/applications', 'Applications', Tray],
  ['/admin/stores', 'Stores', Storefront],
  ['/admin/models', '3D Files', Cube],
  ['/admin/usage', 'Usage', HardDrives],
  ['/admin/billing', 'Billing', Receipt],
  ['/admin/activity', 'Activity', ClockCounterClockwise]
];

export default function AdminNav({ pending = 0, email, onSignOut, children }) {
  const pathname = usePathname() || '/admin';

  /* Exact match for the index, prefix for the rest — otherwise
     /admin/stores would light up Overview as well as itself. */
  const isActive = href => (href === '/admin' ? pathname === '/admin' : pathname.startsWith(href));
  const current = SECTIONS.find(([href]) => isActive(href));

  /* Every section is its own page, so every tab, history entry and bookmark
     says which one it is. */
  useEffect(() => {
    if (current) document.title = `${current[1]} · Platform Console · FurnishAR`;
  }, [current]);

  const items = SECTIONS.map(([href, label, icon]) => ({
    href, label, icon,
    current: isActive(href),
    count: href === '/admin/applications' ? pending : 0,
    countLabel: 'awaiting review'
  }));

  return (
    <ConsoleShell kicker="Platform Console" org="FurnishAR" items={items} email={email} onSignOut={onSignOut}>
      {children}
    </ConsoleShell>
  );
}
