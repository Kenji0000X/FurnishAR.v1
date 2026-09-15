'use client';

import Link from 'next/link';
import { usePathname } from 'next/navigation';

// The three "views" used to be one page with a JS class toggle, which meant
// none of them had a URL. They are real routes now, so a shopper can send
// someone the planner or bookmark the portal.
const NAV = [
  { href: '/', label: 'Discover' },
  { href: '/plan', label: 'Space planner' },
  { href: '/portal', label: 'Store portal' }
];

export function BrandMark() {
  return (
    <span className="brand-mark" aria-hidden="true">
      <i /><i /><i />
    </span>
  );
}

export default function SiteHeader() {
  const pathname = usePathname();
  // A product page is part of Discover, so the tab stays lit while browsing.
  const isActive = href =>
    href === '/' ? pathname === '/' || pathname.startsWith('/furniture') : pathname.startsWith(href);

  return (
    <header className="site-header">
      <Link className="brand" href="/" aria-label="FurnishAR home">
        <BrandMark />
        <span>Furnish<span>AR</span></span>
      </Link>
      <nav className="main-nav" aria-label="Main navigation">
        {NAV.map(({ href, label }) => (
          <Link
            key={href}
            href={href}
            className={`nav-link${isActive(href) ? ' active' : ''}`}
            aria-current={isActive(href) ? 'page' : 'false'}
          >
            {label}
          </Link>
        ))}
      </nav>
      <Link className="header-action" href="/plan">
        <span aria-hidden="true">⌑</span> Measure my space
      </Link>
    </header>
  );
}
