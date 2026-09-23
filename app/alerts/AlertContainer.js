'use client';

import Link from 'next/link';
import { useEffect, useRef, useState, useSyncExternalStore } from 'react';
import {
  subscribe, getSnapshot, getServerSnapshot, dismiss, pause, resume
} from '../../lib/alerts/store.mjs';

/**
 * Where every notification on the site is drawn. Rendered once, in the root
 * layout, so no page ever has to render its own.
 *
 * TWO LIVE REGIONS, BOTH ALWAYS PRESENT
 * A screen reader announces content *inserted into* a live region it already
 * knows about; a region that appears at the same moment as its content is
 * frequently not announced at all. So both regions are rendered from the
 * first paint, empty, and alerts are inserted into them. Errors and anything
 * critical go in the assertive one (role="alert"), which interrupts;
 * confirmations and information go in the polite one (role="status"), which
 * waits its turn. That split is also the visual order: what interrupts is on
 * top.
 *
 * FOCUS IS NEVER TAKEN
 * An alert does not steal focus and cannot trap it. Someone typing into a
 * form when "Saved." appears keeps typing. The alert is reachable by Tab like
 * anything else, and Escape dismisses the one that has focus.
 */

const LEAVE_MS = 180;

function Icon({ type }) {
  const common = {
    width: 18, height: 18, viewBox: '0 0 24 24', fill: 'none', stroke: 'currentColor',
    strokeWidth: 2, strokeLinecap: 'round', strokeLinejoin: 'round', 'aria-hidden': true
  };
  if (type === 'success') {
    return <svg {...common}><circle cx="12" cy="12" r="9" /><path d="m8.5 12.3 2.4 2.4 4.8-5" /></svg>;
  }
  if (type === 'error') {
    return <svg {...common}><circle cx="12" cy="12" r="9" /><path d="M12 7.5v5.2M12 16.3h.01" /></svg>;
  }
  if (type === 'warning') {
    return <svg {...common}><path d="M10.3 4.2 2.9 17.1A2 2 0 0 0 4.6 20h14.8a2 2 0 0 0 1.7-2.9L13.7 4.2a2 2 0 0 0-3.4 0Z" /><path d="M12 9.5v4M12 16.8h.01" /></svg>;
  }
  return <svg {...common}><circle cx="12" cy="12" r="9" /><path d="M12 11v5.2M12 7.7h.01" /></svg>;
}

function AlertCard({ alert, leaving }) {
  const close = () => dismiss(alert.id);

  return (
    <div
      className={`alert is-${alert.type}${leaving ? ' is-leaving' : ''}`}
      data-priority={alert.priority}
      data-alert-key={alert.key}
      onMouseEnter={() => pause(alert.id)}
      onMouseLeave={() => resume(alert.id)}
      onFocus={() => pause(alert.id)}
      onBlur={event => {
        if (!event.currentTarget.contains(event.relatedTarget)) resume(alert.id);
      }}
      onKeyDown={event => {
        if (event.key === 'Escape' && alert.dismissible) { event.stopPropagation(); close(); }
      }}
    >
      <span className="alert-icon"><Icon type={alert.type} /></span>
      <div className="alert-body">
        <b className="alert-title">{alert.title}</b>
        <p className="alert-message">{alert.message}</p>
        {alert.actions.length > 0 && (
          <div className="alert-actions">
            {alert.actions.map(action => (action.href ? (
              <Link key={action.label} className="alert-action" href={action.href} onClick={close}>
                {action.label}
              </Link>
            ) : (
              <button
                key={action.label}
                type="button"
                className="alert-action"
                onClick={() => { close(); action.onAction(); }}
              >
                {action.label}
              </button>
            )))}
          </div>
        )}
      </div>
      {alert.dismissible && (
        <button type="button" className="alert-close" onClick={close}
          aria-label={`Dismiss: ${alert.title}`}>
          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor"
            strokeWidth="2.2" strokeLinecap="round" aria-hidden="true">
            <path d="M6 6l12 12M18 6 6 18" />
          </svg>
        </button>
      )}
    </div>
  );
}

export default function AlertContainer() {
  const live = useSyncExternalStore(subscribe, getSnapshot, getServerSnapshot);

  /* Alerts that have just been dismissed stay for one short fade, so they
     leave rather than vanish. They are already inside a live region, so
     keeping them a moment longer does not announce them twice. */
  const [leaving, setLeaving] = useState([]);
  const previous = useRef([]);

  useEffect(() => {
    const gone = previous.current.filter(old => !live.some(alert => alert.id === old.id));
    previous.current = live;
    if (!gone.length) return undefined;
    setLeaving(current => [...current, ...gone]);
    const timer = setTimeout(() => {
      setLeaving(current => current.filter(item => !gone.some(g => g.id === item.id)));
    }, LEAVE_MS);
    return () => clearTimeout(timer);
  }, [live]);

  const isUrgent = alert => alert.type === 'error' || alert.priority === 'critical';
  const shown = [
    ...live.map(alert => ({ alert, leaving: false })),
    ...leaving.filter(old => !live.some(alert => alert.id === old.id))
      .map(alert => ({ alert, leaving: true }))
  ];

  return (
    <div className="alert-region" aria-label="Notifications">
      <div className="alert-stack" role="alert" aria-live="assertive" aria-atomic="false">
        {shown.filter(({ alert }) => isUrgent(alert)).map(({ alert, leaving: out }) => (
          <AlertCard key={alert.id} alert={alert} leaving={out} />
        ))}
      </div>
      <div className="alert-stack" role="status" aria-live="polite" aria-atomic="false">
        {shown.filter(({ alert }) => !isUrgent(alert)).map(({ alert, leaving: out }) => (
          <AlertCard key={alert.id} alert={alert} leaving={out} />
        ))}
      </div>
    </div>
  );
}
