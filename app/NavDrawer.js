'use client';

import Link from 'next/link';
import { usePathname } from 'next/navigation';
import { useEffect, useRef } from 'react';

/**
 * The navigation, behind one button.
 *
 * The header used to carry five text links in a row. That worked on a wide
 * desktop and nowhere else: on a laptop they crowded the search field, and on
 * a phone they were hidden entirely, so the bottom bar and the header
 * disagreed about what the site contained.
 *
 * One burger, one drawer, the same list on every screen. The route is printed
 * beside each destination — partly so the design and the router cannot drift
 * apart, and partly because somebody reading this on a phone should be able to
 * tell "Collection" is a page rather than a scroll.
 */
const GROUPS = [
  {
    title: 'Browse',
    items: [
      { href: '/', label: 'Discover', path: '/' },
      { href: '/collection', label: 'Collection', path: '/collection' },
      { href: '/plan', label: 'Space planner', path: '/plan' },
      { href: '/diagnose', label: 'Device check', path: '/diagnose' }
    ]
  },
  {
    title: 'For stores',
    small: true,
    items: [
      { href: '/portal', label: 'Store portal', path: '/portal' },
      { href: '/portal#apply', label: 'Apply to list', path: '/portal/apply' }
    ]
  },
  {
    title: 'Help',
    small: true,
    items: [
      { href: '/faq', label: 'Common questions', path: '/faq' },
      {
        href: 'mailto:hello@furnishar.ph?subject=FurnishAR%20enquiry',
        label: 'hello@furnishar.ph',
        external: true
      }
    ]
  }
];

export default function NavDrawer({ open, onClose }) {
  const panelRef = useRef(null);
  const pathname = usePathname();

  /* Escape closes it, and the page behind does not scroll while it is over
     the top — a drawer you can scroll the page behind is a drawer that loses
     your place the moment you dismiss it. */
  useEffect(() => {
    if (!open) return undefined;
    const onKey = event => { if (event.key === 'Escape') onClose(); };
    const previous = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
    window.addEventListener('keydown', onKey);
    /* Focus moves into the panel, so the next Tab is inside the drawer rather
       than somewhere behind it. */
    panelRef.current?.focus();
    return () => {
      window.removeEventListener('keydown', onKey);
      document.body.style.overflow = previous;
    };
  }, [open, onClose]);

  if (!open) return null;

  const isCurrent = href => {
    if (href.startsWith('mailto:') || href.includes('#')) return false;
    if (href === '/') return pathname === '/' || pathname.startsWith('/furniture');
    return pathname.startsWith(href);
  };

  return (
    <div className="drawer-root">
      {/* A real button, so it is reachable by keyboard rather than being a div
          that only a mouse can dismiss. */}
      <button type="button" className="drawer-scrim" onClick={onClose} aria-label="Close menu" />

      <div
        className="drawer-panel"
        role="dialog"
        aria-modal="true"
        aria-label="Site menu"
        tabIndex={-1}
        ref={panelRef}
      >
        <div className="drawer-head">
          <span className="brand">
            <span className="brand-mark" aria-hidden="true"><i /><i /><i /></span>
            <span>Furnish<span>AR</span></span>
          </span>
          <button type="button" className="drawer-close" onClick={onClose} aria-label="Close menu">
            <svg width="17" height="17" viewBox="0 0 24 24" fill="none" stroke="currentColor"
              strokeWidth="2.2" strokeLinecap="round" aria-hidden="true">
              <path d="M5 5l14 14M19 5L5 19" />
            </svg>
          </button>
        </div>

        <nav className="drawer-nav" aria-label="Main">
          {GROUPS.map(group => (
            <div className={`drawer-group${group.small ? ' is-small' : ''}`} key={group.title}>
              <h2>{group.title}</h2>
              {group.items.map(item => (
                item.external ? (
                  <a key={item.href} href={item.href} className="drawer-link" onClick={onClose}>
                    <span>{item.label}</span>
                  </a>
                ) : (
                  <Link
                    key={item.href}
                    href={item.href}
                    className={`drawer-link${isCurrent(item.href) ? ' is-current' : ''}`}
                    aria-current={isCurrent(item.href) ? 'page' : undefined}
                    onClick={onClose}
                  >
                    <span>{item.label}</span>
                    {item.path && <code>{item.path}</code>}
                  </Link>
                )
              ))}
            </div>
          ))}
        </nav>

        <div className="drawer-foot">
          <Link className="capsule capsule-solid" href="/plan" onClick={onClose}>
            Measure my space <span aria-hidden="true">→</span>
          </Link>
        </div>
      </div>
    </div>
  );
}
