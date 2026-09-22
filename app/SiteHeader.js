'use client';

import Link from 'next/link';
import { usePathname } from 'next/navigation';
import { useState } from 'react';
import ThemeToggle from './ThemeToggle.js';
import NavDrawer from './NavDrawer.js';
import NotificationBell from './NotificationBell.js';
import HeaderSearch from './HeaderSearch.js';

export function BrandMark() {
  return (
    <span className="brand-mark" aria-hidden="true">
      <i /><i /><i />
    </span>
  );
}

/**
 * The header, on every route.
 *
 * The row of five text links is gone. It only ever worked on a wide desktop:
 * on a laptop it crowded the search field, and on a phone it was hidden
 * outright, so the bottom bar and the header disagreed about what the site
 * contained. Everything now lives behind one button, in NavDrawer, and the
 * same list appears at every width.
 *
 * On the store portal and the admin console the header carries the logo and
 * the burger and nothing else: a shop owner signing in has no use for the
 * public catalogue's search field, and "Measure my space" is not the action
 * they came for.
 */
export default function SiteHeader() {
  const pathname = usePathname();
  const [menuOpen, setMenuOpen] = useState(false);

  const isWorkspace = pathname.startsWith('/portal') || pathname.startsWith('/admin');

  return (
    <>
      <header className={`site-header${isWorkspace ? ' is-workspace' : ''}`}>
        <Link className="brand" href="/" aria-label="FurnishAR home">
          <BrandMark />
          <span>Furnish<span>AR</span></span>
        </Link>

        {isWorkspace && (
          <span className="header-context">
            {pathname.startsWith('/admin') ? 'Superadmin' : 'Store portal'}
          </span>
        )}

        <div className="header-spacer" />

        <div className="header-tools">
          {!isWorkspace && <HeaderSearch />}
          {!isWorkspace && (
            <Link className="header-action" href="/plan">
              <span aria-hidden="true">⌑</span> Measure my space
            </Link>
          )}

          {/*
              The bell is present everywhere, as asked, but it is fed by
              nothing yet — FurnishAR has no notifications table and no
              endpoint, and shoppers have no accounts at all, so there is
              literally nothing a public visitor could be notified about.

              Rather than draw a badge over an empty promise, it renders
              plain and says so when opened. Give it a `feed` once a real
              source exists and the dot, the count and the list all start
              working with no other change.
          */}
          <NotificationBell
            feed={null}
            label={pathname.startsWith('/admin') ? 'Platform activity' : 'Notifications'}
          />

          <ThemeToggle />

          {/*
              No burger on the portal or the console.

              The drawer is the shopper's map of the site — Collection, Measure
              my space, the questions. A store owner signing in to upload a
              model, or an operator reviewing applications, is not browsing the
              catalogue, and offering them a menu of shopper routes on top of
              their own navigation is two competing menus on one screen. Each
              workspace has its own: the console its sections, the portal its
              dashboard. The wordmark still goes home for anyone who wants the
              public site.
          */}
          {!isWorkspace && (
            <button
              type="button"
              className="icon-button nav-burger"
              aria-label={menuOpen ? 'Close menu' : 'Open menu'}
              aria-expanded={menuOpen}
              onClick={() => setMenuOpen(open => !open)}
            >
              <svg width="20" height="14" viewBox="0 0 20 14" fill="none" stroke="currentColor"
                strokeWidth="2" strokeLinecap="round" aria-hidden="true">
                <path d="M1 1h18M1 7h18M1 13h18" />
              </svg>
            </button>
          )}
        </div>
      </header>

      {!isWorkspace && <NavDrawer open={menuOpen} onClose={() => setMenuOpen(false)} />}
    </>
  );
}
