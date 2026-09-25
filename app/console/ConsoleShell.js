'use client';

import Link from 'next/link';
import { useEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { SignOut, DotsThree, X } from '@phosphor-icons/react/dist/ssr';
import './console.css';

/**
 * The frame both back offices share: the store portal and the platform
 * console.
 *
 * DESKTOP (≥64rem): a rail of real links on the left, the signed-in account
 * at its foot, the page on the right.
 *
 * PHONE / TABLET (<64rem): the rail is replaced, not squeezed. A fixed
 * workspace tab bar at the bottom holds the destinations marked `tab` (at
 * most four) and More; More opens a sheet with the rest, the account and
 * Sign Out. Every destination stays visible without sideways discovery —
 * the old phone layout was a horizontally scrolling pill row whose last half
 * sat off-screen. The shopper's bottom bar is never shown here (ChromeGate),
 * so there is only ever one bar at the bottom.
 *
 * Links are links. The admin rail points at routes; the portal rail points at
 * sections of one page (#inventory, #orders…), so every view is a URL that
 * survives refresh, Back and sharing. On the portal the current section is
 * followed as you scroll and marked aria-current="location".
 */
export default function ConsoleShell({ kicker, org, items, email, onSignOut, children, spy = false }) {
  const active = useScrollSpy(spy ? items.map(item => item.href) : []);
  const [leaving, setLeaving] = useState(false);
  const initials = (email || '?').replace(/@.*/, '').split(/[.\-_+]/).filter(Boolean)
    .slice(0, 2).map(part => part[0]).join('').toUpperCase() || '?';

  async function signOut() {
    setLeaving(true);
    try { await onSignOut(); } finally { setLeaving(false); }
  }

  const tabs = items.filter(item => item.tab).slice(0, 4);
  const more = items.filter(item => !tabs.includes(item));
  const isCurrent = item => (spy ? active === item.href : item.current);
  const moreCurrent = more.some(isCurrent);

  return (
    <div className="console">
      <aside className="console-rail" aria-label={`${kicker} navigation`}>
        <div className="bezel console-rail-shell">
          <div className="bezel-core console-rail-core">
            <div className="console-brand">
              <p className="console-kicker">{kicker}</p>
              <p className="console-org" translate="no">{org}</p>
            </div>

            <nav aria-label={kicker}>
              <ul className="console-nav">
                {items.map(item => (
                  <li key={item.href}>
                    <NavLink item={item} current={isCurrent(item)} spy={spy} className="console-link" />
                  </li>
                ))}
              </ul>
            </nav>

            <div className="console-account">
              <span className="console-avatar" aria-hidden="true">{initials}</span>
              <span className="console-email" title={email} translate="no">{email || 'Signed in'}</span>
              <button className="console-signout" type="button" onClick={signOut} disabled={leaving}
                aria-busy={leaving || undefined}>
                {leaving
                  ? <span className="loading-spinner" aria-hidden="true" />
                  : <SignOut size={18} weight="light" aria-hidden="true" />}
                <span>Sign Out</span>
              </button>
            </div>
          </div>
        </div>
      </aside>

      <div className="console-main">{children}</div>

      <WorkspaceTabBar
        label={kicker} tabs={tabs} more={more} spy={spy} isCurrent={isCurrent} moreCurrent={moreCurrent}
        org={org} email={email} initials={initials} leaving={leaving} onSignOut={signOut}
      />
    </div>
  );
}

/** One destination, as a rail link or a tab. */
function NavLink({ item, current, spy, className, onNavigate, short = false }) {
  const Icon = item.icon;
  return (
    <Link
      href={item.href}
      className={className}
      aria-current={current ? (spy ? 'location' : 'page') : undefined}
      scroll={spy ? undefined : true}
      onClick={onNavigate}
    >
      <Icon className={`${className}-icon`} size={20} weight={current ? 'fill' : 'light'} aria-hidden="true" />
      <span className={`${className}-label`}>{short && item.short ? item.short : item.label}</span>
      {item.count > 0 && (
        <span className="console-count">
          {item.count}
          <span className="sr-only"> {item.countLabel || 'waiting'}</span>
        </span>
      )}
    </Link>
  );
}

/**
 * The phone workspace navigation: up to four tabs and More, under the thumb.
 * More is a real <dialog> (focus moves in, Escape closes, focus returns) with
 * the remaining destinations, who is signed in, and Sign Out — which no
 * longer competes with Inventory or Orders for the first tap.
 */
function WorkspaceTabBar({ label, tabs, more, spy, isCurrent, moreCurrent, org, email, initials, leaving, onSignOut }) {
  const sheet = useRef(null);
  const opener = useRef(null);
  const [open, setOpen] = useState(false);
  const [host, setHost] = useState(null);

  // Rendered into <body>: the portal and admin views animate in with a
  // transform that stays applied, and a transformed ancestor turns
  // position:fixed into "fixed to that section" — the bar ended up at the
  // bottom of a 10,000px page instead of the bottom of the screen.
  useEffect(() => { setHost(document.body); }, []);

  useEffect(() => {
    const dialog = sheet.current;
    if (!dialog) return undefined;
    const onClose = () => { setOpen(false); opener.current?.focus(); };
    dialog.addEventListener('close', onClose);
    return () => dialog.removeEventListener('close', onClose);
  }, [host]);

  function show() {
    setOpen(true);
    sheet.current?.showModal();
  }
  const close = () => sheet.current?.close();
  const moreCount = more.reduce((sum, item) => sum + (item.count || 0), 0);

  if (!host) return null;
  return createPortal(
    <>
      <nav className="workspace-tabbar" aria-label={`${label} sections`}>
        <ul>
          {tabs.map(item => (
            <li key={item.href}>
              <NavLink item={item} current={isCurrent(item)} spy={spy} className="workspace-tab" short />
            </li>
          ))}
          <li>
            <button ref={opener} type="button" className="workspace-tab" onClick={show}
              aria-haspopup="dialog" aria-expanded={open} data-current={moreCurrent || undefined}>
              <DotsThree className="workspace-tab-icon" size={20} weight="bold" aria-hidden="true" />
              <span className="workspace-tab-label">More</span>
              {moreCount > 0 && <span className="console-count">{moreCount}<span className="sr-only"> waiting</span></span>}
            </button>
          </li>
        </ul>
      </nav>

      <dialog ref={sheet} className="workspace-sheet" aria-labelledby="workspace-sheet-title"
        onClick={event => { if (event.target === sheet.current) close(); }}>
        <div className="workspace-sheet-body">
          <div className="workspace-sheet-head">
            <div>
              <p className="console-kicker" id="workspace-sheet-title">{label}</p>
              <p className="console-org" translate="no">{org}</p>
            </div>
            <button type="button" className="workspace-sheet-close" onClick={close} aria-label="Close">
              <X size={20} aria-hidden="true" />
            </button>
          </div>
          {more.length > 0 && (
            <ul className="workspace-sheet-nav">
              {more.map(item => (
                <li key={item.href}>
                  <NavLink item={item} current={isCurrent(item)} spy={spy} className="console-link" onNavigate={close} />
                </li>
              ))}
            </ul>
          )}
          <div className="console-account workspace-sheet-account">
            <span className="console-avatar" aria-hidden="true">{initials}</span>
            <span className="console-email" title={email} translate="no">{email || 'Signed in'}</span>
            <button className="console-signout" type="button" onClick={onSignOut} disabled={leaving}
              aria-busy={leaving || undefined}>
              {leaving
                ? <span className="loading-spinner" aria-hidden="true" />
                : <SignOut size={18} weight="light" aria-hidden="true" />}
              <span>Sign Out</span>
            </button>
          </div>
        </div>
      </dialog>
    </>,
    host
  );
}

/**
 * A page's opening: a small label, the title, one line of context, and the
 * page's main actions. The h1 carries id="console-title" for the landmark
 * that labels the whole view.
 */
export function ConsoleHeader({ eyebrow, title, children, actions, id = 'console-title' }) {
  return (
    <header className="console-head">
      <div className="console-head-copy">
        {eyebrow && <p className="console-eyebrow"><span translate="no">{eyebrow}</span></p>}
        <h1 id={id}>{title}</h1>
        {children && <div className="console-lede">{children}</div>}
      </div>
      {actions && <div className="console-head-actions">{actions}</div>}
    </header>
  );
}

/** A section of a console page, with an anchored heading and optional action. */
export function ConsoleSection({ id, title, note, action, children }) {
  return (
    <section className="console-section" id={id} aria-labelledby={`${id}-title`}>
      <div className="console-section-head">
        <div>
          <h2 id={`${id}-title`}>{title}</h2>
          {note && <p className="console-section-note">{note}</p>}
        </div>
        {action}
      </div>
      {children}
    </section>
  );
}

/** The primary pill, with its icon in a circle of its own. */
export function ConsoleCta({ icon: Icon, children, className = '', ...props }) {
  const Tag = props.href ? Link : 'button';
  return (
    <Tag className={`console-cta ${className}`} {...(Tag === 'button' ? { type: 'button' } : {})} {...props}>
      <span>{children}</span>
      {Icon && (
        <span className="console-cta-icon" aria-hidden="true">
          <Icon size={16} weight="bold" />
        </span>
      )}
    </Tag>
  );
}

/**
 * Which section is on screen. One IntersectionObserver over the sections the
 * rail links to; the topmost visible one wins. Never a scroll listener.
 */
function useScrollSpy(hrefs) {
  const [active, setActive] = useState(hrefs[0] || null);
  const key = hrefs.join('|');
  useEffect(() => {
    if (!hrefs.length || typeof IntersectionObserver === 'undefined') return undefined;
    const targets = hrefs.map(href => document.getElementById(href.replace(/^#/, ''))).filter(Boolean);
    const visible = new Map();
    const observer = new IntersectionObserver(entries => {
      for (const entry of entries) visible.set(entry.target.id, entry.isIntersecting ? entry.boundingClientRect.top : null);
      const top = targets.filter(t => visible.get(t.id) != null)
        .sort((a, b) => visible.get(a.id) - visible.get(b.id))[0];
      if (top) setActive(`#${top.id}`);
    }, { rootMargin: '-20% 0px -55% 0px' });
    targets.forEach(t => observer.observe(t));
    return () => observer.disconnect();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key]);
  return active;
}
