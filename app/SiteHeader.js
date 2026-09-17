'use client';

import Link from 'next/link';
import { usePathname } from 'next/navigation';
import { useEffect, useRef, useState } from 'react';
import ThemeToggle from './ThemeToggle.js';

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
  const [menuOpen, setMenuOpen] = useState(false);
  const toggleRef = useRef(null);

  // A product page is part of Discover, so the tab stays lit while browsing.
  const isActive = href =>
    href === '/' ? pathname === '/' || pathname.startsWith('/furniture') : pathname.startsWith(href);

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
