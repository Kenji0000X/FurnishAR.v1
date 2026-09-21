'use client';

import Link from 'next/link';
import { usePathname } from 'next/navigation';
import ThemeToggle from './ThemeToggle.js';

/*
 * The four places this site actually has.
 *
 * The redesign brief also asked for Search, Saved and Account in the header.
 * None of the three exists: there is no site-wide search (the catalogue has
 * its own filter, which is a different thing), there is no favourites feature
 * anywhere in the codebase, and shoppers have no accounts at all — only store
 * owners do, through the portal. A magnifying glass, a heart and a person
 * icon that lead nowhere are precisely the "buttons that do nothing" the same
 * brief bans two sections earlier, so they are left out until the features
 * behind them are real.
 *
 * "Collection" is an anchor rather than a route because the catalogue is a
 * section of the home page. It is listed anyway: a shopper looking for the
 * furniture should not have to know that.
 */
const NAV = [
  { href: '/', label: 'Discover' },
  { href: '/#catalog', label: 'Collection' },
  { href: '/plan', label: 'Space planner' },
  /* The device check. It sits next to the planner rather than off with the
     store links, because it answers a question about the planner: whether
     this phone can run it at all. */
  { href: '/diagnose', label: 'Device check' },
  { href: '/portal', label: 'For stores' }
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

  /*
   * A product page is part of Discover, so that tab stays lit while browsing.
   *
   * "Collection" is deliberately never marked current: it points at a section
   * of the page you may already be on, and aria-current="page" on a link that
   * scrolls you somewhere else on the same page tells a screen-reader user
   * something untrue about where they are.
   */
  const isActive = href => {
    if (href.includes('#')) return false;
    if (href === '/') return pathname === '/' || pathname.startsWith('/furniture');
    return pathname.startsWith(href);
  };

  /*
     There is no menu button here any more, and so no open/closed state, no
     Escape handler and no close-on-navigate effect.

     The hamburger and its drawer were replaced by the bottom bar (BottomNav).
     Leaving the button in the markup as `display: none` would have been
     cheaper, but it is a control nothing can reach, wired to state nothing
     reads — the next person to touch this file would have had to work out
     which of the two navigations was live.
  */
  return (
    <header className="site-header">
      <Link className="brand" href="/" aria-label="FurnishAR home">
        <BrandMark />
        <span>Furnish<span>AR</span></span>
      </Link>

      <nav className="main-nav" id="main-nav" aria-label="Main navigation">
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
        <Link className="header-action" href="/plan">
          <span aria-hidden="true">⌑</span> Measure my space
        </Link>
      </nav>

      <div className="header-tools">
        <ThemeToggle />
      </div>
    </header>
  );
}
