'use client';

import Link from 'next/link';
import { usePathname } from 'next/navigation';

/**
 * The bottom navigation bar, on phones.
 *
 * A hamburger hides every destination behind a tap and a guess. On a phone —
 * which is the device this product is actually used on, in a room, one-handed,
 * while holding the phone up — the destinations belong under the thumb and
 * visible without opening anything.
 *
 * ---------------------------------------------------------------------------
 * The destinations are the ones that exist
 * ---------------------------------------------------------------------------
 *
 * The reference design has five slots: Home, Search, Add, Reels, Profile.
 * Those are a social app's, and three of them have no counterpart here — there
 * is no site-wide search, no posting, and shoppers have no accounts at all
 * (only store owners do). The rule has always been that a slot has to lead
 * somewhere real.
 *
 * It is five now because a fifth real destination exists: the device check.
 * "Will the scanner work on my phone" is the question that decides whether
 * anybody gets to use this product at all, and on a phone it is asked in the
 * moment — standing in a room, scanner refusing to start. A footer link is
 * the wrong place for that; the bar is the right one.
 *
 * Scan keeps the centre slot, raised, because it is the thing this product is
 * for. That is the one place the reference's shape genuinely fits.
 */

/* Each icon is drawn inline rather than pulled from a font: they have to sit
   on the baseline with the label, change weight when active, and inherit
   currentColor. `filled` is the active state — a solid form reads as
   "you are here" without relying on the tint. */
function Icon({ name, filled }) {
  const stroke = { fill: 'none', stroke: 'currentColor', strokeWidth: 1.6, strokeLinecap: 'round', strokeLinejoin: 'round' };
  const solid = { fill: 'currentColor', stroke: 'none' };
  const style = filled ? solid : stroke;

  if (name === 'discover') {
    return (
      <svg viewBox="0 0 24 24" aria-hidden="true" {...style}>
        <path d="M3 10.5 12 3l9 7.5V20a1 1 0 0 1-1 1h-5v-6H9v6H4a1 1 0 0 1-1-1z" />
      </svg>
    );
  }
  if (name === 'collection') {
    return (
      <svg viewBox="0 0 24 24" aria-hidden="true" {...style}>
        <rect x="3" y="3" width="8" height="8" rx="1" />
        <rect x="13" y="3" width="8" height="8" rx="1" />
        <rect x="3" y="13" width="8" height="8" rx="1" />
        <rect x="13" y="13" width="8" height="8" rx="1" />
      </svg>
    );
  }
  if (name === 'scan') {
    // A viewfinder: four corners and the point in the middle you aim at.
    return (
      <svg viewBox="0 0 24 24" aria-hidden="true"
        fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
        <path d="M4 9V5a1 1 0 0 1 1-1h4M15 4h4a1 1 0 0 1 1 1v4M20 15v4a1 1 0 0 1-1 1h-4M9 20H5a1 1 0 0 1-1-1v-4" />
        <circle cx="12" cy="12" r="2.5" fill={filled ? 'currentColor' : 'none'} />
      </svg>
    );
  }
  if (name === 'device') {
    // A handset with a tick: "this phone, checked". Not a wrench or a gear —
    // both read as settings, and this changes nothing.
    return (
      <svg viewBox="0 0 24 24" aria-hidden="true" {...style}>
        <rect x="6" y="2.5" width="12" height="19" rx="2.5" />
        <path d="M9.2 12.4 11.2 14.4 15 10.6"
          fill="none" stroke={filled ? 'var(--paper)' : 'currentColor'}
          strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" />
      </svg>
    );
  }
  if (name === 'stores') {
    return (
      <svg viewBox="0 0 24 24" aria-hidden="true" {...style}>
        <path d="M4 9h16v11a1 1 0 0 1-1 1H5a1 1 0 0 1-1-1z" />
        <path d="M3 9 5 4h14l2 5" {...(filled ? { fill: 'currentColor' } : {})} />
      </svg>
    );
  }
  return null;
}

const ITEMS = [
  { href: '/', label: 'Discover', icon: 'discover' },
  { href: '/collection', label: 'Collection', icon: 'collection' },
  { href: '/plan', label: 'Scan', icon: 'scan', primary: true },
  /* "Device", not "Diagnostics" or "Device check": five labels have to fit
     across 320px, which leaves about 64px a slot. */
  { href: '/diagnose', label: 'Device', icon: 'device' },
  { href: '/portal', label: 'Stores', icon: 'stores' }
];

export default function BottomNav() {
  const pathname = usePathname();

  /* Same rule as the header's: a product page belongs to Discover, and
     "Collection" is never marked current because it points at a section of a
     page you may already be on. */
  const isActive = href => {
    if (href.includes('#')) return false;
    if (href === '/') return pathname === '/' || pathname.startsWith('/furniture');
    return pathname.startsWith(href);
  };

  return (
    <nav className="bottom-nav" aria-label="Main">
      <ul>
        {ITEMS.map(item => {
          const active = isActive(item.href);
          return (
            <li key={item.href}>
              <Link
                href={item.href}
                className={`bottom-nav-item${active ? ' is-active' : ''}${item.primary ? ' is-primary' : ''}`}
                aria-current={active ? 'page' : undefined}
              >
                {/* The pill sits behind the icon and is what carries the
                    active state visually; the label carries it in words and
                    aria-current carries it for a screen reader. Three ways,
                    none of them colour alone. */}
                <span className="bottom-nav-pill">
                  <Icon name={item.icon} filled={active} />
                </span>
                <span className="bottom-nav-label">{item.label}</span>
              </Link>
            </li>
          );
        })}
      </ul>
    </nav>
  );
}
