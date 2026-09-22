'use client';

import { useEffect, useRef, useState } from 'react';

/**
 * The bell, and what it is honestly allowed to claim.
 *
 * A notification bell is the easiest thing in an interface to fake: draw one,
 * put a red dot on it, and it looks like a live product. This one only shows a
 * dot when the server has actually said there is something to see.
 *
 * It polls rather than holding a socket open. That is a deliberate choice, not
 * a shortcut waiting to be upgraded: the events this surfaces — a store
 * applying to list, a model finishing upload, a plan changing — happen a few
 * times a day, and a thirty-second poll costs one small request while a
 * websocket costs a persistent connection per open tab on a serverless host
 * that charges for exactly that. If FurnishAR ever grows events that matter
 * within a second, the transport changes here and nothing else moves.
 *
 * When the endpoint is missing or fails, the bell renders with no dot and says
 * nothing. It never invents a count.
 */
const POLL_MS = 30000;

/**
 * @param feed  the endpoint to poll, or null when this surface has no
 *              notification source yet. NULL MEANS DO NOT FETCH — not "fetch
 *              the default and see". The first version defaulted to
 *              /api/notifications, which does not exist: the catch-all API
 *              route answered 401 and every page logged a failed request to
 *              the console every thirty seconds. A bell that cannot be fed
 *              should be silent, not noisy.
 */
export default function NotificationBell({ feed = null, label = 'Notifications' }) {
  const [unread, setUnread] = useState(null);
  const [open, setOpen] = useState(false);
  const [items, setItems] = useState([]);
  const timer = useRef(null);

  useEffect(() => {
    if (!feed) return undefined;
    let dead = false;

    async function poll() {
      try {
        const response = await fetch(feed, { cache: 'no-store' });
        if (!response.ok) throw new Error(String(response.status));
        const data = await response.json();
        if (dead) return;
        setUnread(Number.isFinite(data?.unread) ? data.unread : 0);
        setItems(Array.isArray(data?.items) ? data.items : []);
      } catch {
        /* No feed yet, or it failed. Show a plain bell: an unknown count is
           not zero, and it is certainly not a red dot. */
        if (!dead) setUnread(null);
      }
    }

    poll();
    timer.current = setInterval(poll, POLL_MS);
    return () => { dead = true; clearInterval(timer.current); };
  }, [feed]);

  useEffect(() => {
    if (!open) return undefined;
    const onKey = event => { if (event.key === 'Escape') setOpen(false); };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [open]);

  const has = typeof unread === 'number' && unread > 0;

  return (
    <div className="bell-wrap">
      <button
        type="button"
        className="icon-button bell-button"
        aria-label={has ? `${label}, ${unread} unread` : label}
        aria-expanded={open}
        onClick={() => setOpen(value => !value)}
      >
        <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor"
          strokeWidth="1.9" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
          <path d="M18 8.5a6 6 0 1 0-12 0c0 6-2 7.5-2 7.5h16s-2-1.5-2-7.5" />
          <path d="M10.3 20a2 2 0 0 0 3.4 0" />
        </svg>
        {has && <span className="bell-dot" aria-hidden="true" />}
      </button>

      {open && (
        <div className="bell-panel" role="dialog" aria-label={label}>
          <div className="bell-panel-head">
            <span className="bell-live" aria-hidden="true" />
            <b>{label}</b>
            <span>{has ? `${unread} new` : 'Nothing new'}</span>
          </div>

          {items.length === 0 ? (
            <p className="bell-empty">
              {unread === null
                ? 'Notifications are not switched on for this account yet.'
                : 'You are up to date.'}
            </p>
          ) : (
            <ul className="bell-list">
              {items.slice(0, 6).map(item => (
                <li key={item.id} className={item.read ? '' : 'is-unread'}>
                  <p>{item.text}</p>
                  <small>{item.when}</small>
                </li>
              ))}
            </ul>
          )}
        </div>
      )}
    </div>
  );
}
