'use client';

import Link from 'next/link';
import { usePathname } from 'next/navigation';
import { useEffect, useRef, useState } from 'react';
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
  const [menuOpen, setMenuOpen] = useState(false);
  const toggleRef = useRef(null);

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

  // Navigating is the most common way the menu should close, and it is easy to
  // miss: Next does a client-side transition, so the component never unmounts
  // and an open menu would survive the route change and cover the new page.
  useEffect(() => { setMenuOpen(false); }, [pathname]);

  // Escape closes it, and focus goes back to the button that opened it —
  // otherwise focus is left on a panel that no longer exists and the next Tab
  // starts from the top of the document.
  useEffect(() => {
    if (!menuOpen) return;
    const onKey = event => {
      if (event.key === 'Escape') {
        setMenuOpen(false);
        toggleRef.current?.focus();
      }
    };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [menuOpen]);

  return (
    <header className={`site-header${menuOpen ? ' menu-open' : ''}`}>
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
        <button
          ref={toggleRef}
          className="nav-toggle"
          type="button"
          onClick={() => setMenuOpen(open => !open)}
          aria-expanded={menuOpen}
          aria-controls="main-nav"
          aria-label="Menu"
        >
          <span aria-hidden="true">{menuOpen ? '✕' : '☰'}</span>
        </button>
      </div>
    </header>
  );
}
