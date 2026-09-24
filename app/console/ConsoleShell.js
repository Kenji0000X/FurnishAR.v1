'use client';

import Link from 'next/link';
import { useEffect, useState } from 'react';
import { SignOut } from '@phosphor-icons/react/dist/ssr';
import './console.css';

/**
 * The frame both back offices share: the store portal and the platform
 * console. A rail of real links on the left (a scrolling pill bar on phones),
 * the signed-in account at its foot, and the page on the right.
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
                {items.map(item => {
                  const current = spy ? active === item.href : item.current;
                  const Icon = item.icon;
                  return (
                    <li key={item.href}>
                      <Link
                        href={item.href}
                        className="console-link"
                        aria-current={current ? (spy ? 'location' : 'page') : undefined}
                        scroll={spy ? undefined : true}
                      >
                        <Icon className="console-link-icon" size={20} weight="light" aria-hidden="true" />
                        <span className="console-link-label">{item.label}</span>
                        {item.count > 0 && (
                          <span className="console-count">
                            {item.count}
                            <span className="sr-only"> {item.countLabel || 'waiting'}</span>
                          </span>
                        )}
                      </Link>
                    </li>
                  );
                })}
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
    </div>
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
