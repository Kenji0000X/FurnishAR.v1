'use client';

import { useCallback, useEffect, useState } from 'react';
import { initBackend, usingSupabase, supabase, backendReason } from '../portal/backend.js';

/**
 * The superadmin console: vetting store owners before they get a shop.
 *
 * What protects this is NOT this file. Every call it makes is refused by row
 * level security unless the signed-in account is in `platform_admins` — see
 * supabase/migrations/0002_platform_admin.sql and tests/admin.test.js. This
 * component decides what to *render*; the database decides what is *allowed*.
 *
 * That distinction is the whole point. A reviewer who reached this page without
 * being an admin would see an empty queue and get an error on every action,
 * because the server never sends them anyone's email address in the first
 * place.
 */

function timeAgo(iso) {
  if (!iso) return '—';
  const then = new Date(iso).getTime();
  if (Number.isNaN(then)) return '—';
  const seconds = Math.round((then - Date.now()) / 1000);
  const units = [['day', 86400], ['hour', 3600], ['minute', 60]];
  const formatter = new Intl.RelativeTimeFormat('en', { numeric: 'auto' });
  for (const [unit, size] of units) {
    if (Math.abs(seconds) >= size) return formatter.format(Math.round(seconds / size), unit);
  }
  return formatter.format(seconds, 'second');
}

/** Turns a store name into the slug the shop will live at. */
const slugify = value =>
  String(value || '').toLowerCase().trim().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');

function ApplicationCard({ application, onApprove, onReject, busy }) {
  const [slug, setSlug] = useState(slugify(application.store_name));
  const [note, setNote] = useState('');
  const [confirming, setConfirming] = useState(null); // 'approve' | 'reject' | null

  return (
    <article className="review-card">
      <header className="review-head">
        <div>
          <h3>{application.store_name}</h3>
          <p className="review-meta">
            applied {timeAgo(application.created_at)}
          </p>
        </div>
        <span className={`review-status is-${application.status}`}>{application.status}</span>
      </header>

      {/* The details to check before letting someone list furniture publicly. */}
      <dl className="review-details">
        <div><dt>Contact email</dt><dd>{application.contact_email}</dd></div>
        <div><dt>Contact number</dt><dd>{application.contact_phone || '—'}</dd></div>
        <div><dt>What they will list</dt><dd>{application.message || '—'}</dd></div>
      </dl>

      {application.status === 'pending' && (
        <div className="review-actions">
          <label className="review-slug">
            Store address
            <span className="review-slug-row">
              <span aria-hidden="true">/furniture/…</span>
              <input
                value={slug}
                onChange={event => setSlug(slugify(event.target.value))}
                aria-label="Store slug"
              />
            </span>
          </label>

          <label>
            Note (kept on the record; required to reject)
            <input
              value={note}
              onChange={event => setNote(event.target.value)}
              placeholder="e.g. could not verify the business"
            />
          </label>

          {confirming === 'approve' ? (
            <div className="review-confirm">
              <p>
                Approve <b>{application.store_name}</b>? This creates the store at
                <code> /{slug}</code> and gives <b>{application.contact_email}</b> the ability to
                publish furniture publicly.
              </p>
              <button className="button button-primary" type="button" disabled={busy}
                onClick={() => onApprove(application, slug)}>
                {busy ? 'Approving…' : 'Yes, approve'}
              </button>
              <button className="text-button" type="button" onClick={() => setConfirming(null)}>
                Cancel
              </button>
            </div>
          ) : confirming === 'reject' ? (
            <div className="review-confirm">
              <p>Reject <b>{application.store_name}</b>? They will need to apply again.</p>
              <button className="button button-outline" type="button" disabled={busy || !note.trim()}
                onClick={() => onReject(application, note)}>
                {busy ? 'Rejecting…' : 'Yes, reject'}
              </button>
              <button className="text-button" type="button" onClick={() => setConfirming(null)}>
                Cancel
              </button>
            </div>
          ) : (
            <div className="review-buttons">
              {/* Approval is irreversible from here — it creates a store and
                  grants publishing rights — so it asks twice. */}
              <button className="button button-primary" type="button"
                disabled={busy || !slug}
                onClick={() => setConfirming('approve')}>
                Approve
              </button>
              <button className="button button-outline" type="button" disabled={busy}
                onClick={() => setConfirming('reject')}>
                Reject
              </button>
            </div>
          )}
        </div>
      )}

      {application.status !== 'pending' && application.review_note && (
        <p className="review-note">Note: {application.review_note}</p>
      )}
    </article>
  );
}

export default function AdminConsole() {
  const [state, setState] = useState('loading'); // loading | denied | ready | offline
  const [reason, setReason] = useState('');
  const [tab, setTab] = useState('pending');
  const [applications, setApplications] = useState([]);
  const [stores, setStores] = useState([]);
  const [audit, setAudit] = useState([]);
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState('');
  const [error, setError] = useState('');

  const load = useCallback(async () => {
    const sb = supabase();
    const [queue, allStores, recent] = await Promise.all([
      sb.listApplications(tab === 'pending' ? 'pending' : null).catch(() => []),
      sb.listAllStores().catch(() => []),
      sb.listAudit(25).catch(() => [])
    ]);
    setApplications(queue);
    setStores(allStores);
    setAudit(recent);
  }, [tab]);

  useEffect(() => {
    let active = true;
    (async () => {
      await initBackend();
      if (!active) return;

      if (!usingSupabase()) {
        setReason(backendReason() || 'No database is connected.');
        setState('offline');
        return;
      }

      // The server answers this, and answers "no" for anyone who is not in
      // platform_admins. It decides the view; RLS decides the data.
      const admin = await supabase().isPlatformAdmin();
      if (!active) return;
      if (!admin) {
        setState('denied');
        return;
      }
      await load();
      if (active) setState('ready');
    })();
    return () => { active = false; };
  }, [load]);

  useEffect(() => {
    if (state === 'ready') load().catch(() => {});
  }, [tab, state, load]);

  async function handleApprove(application, slug) {
    setBusy(true);
    setError('');
    try {
      await supabase().approveApplication(application.id, slug);
      setNotice(`${application.store_name} approved. They can sign in and publish now.`);
      await load();
    } catch (approveError) {
      setError(approveError.message);
    } finally {
      setBusy(false);
    }
  }

  async function handleReject(application, note) {
    setBusy(true);
    setError('');
    try {
      await supabase().rejectApplication(application.id, note);
      setNotice(`${application.store_name} rejected.`);
      await load();
    } catch (rejectError) {
      setError(rejectError.message);
    } finally {
      setBusy(false);
    }
  }

  if (state === 'loading') return <p className="card-copy">Checking your access…</p>;

  if (state === 'offline') {
    return (
      <div className="login-panel">
        <div className="login-copy">
          <span className="secure-mark" aria-hidden="true">⌑</span>
          <h2>The console needs the database.</h2>
          <p>Store applications live in Supabase; without it there is nothing to review.</p>
          <p className="demo-note">{reason}</p>
        </div>
      </div>
    );
  }

  if (state === 'denied') {
    // Deliberately says nothing about whether the queue has anything in it, or
    // who the administrators are.
    return (
      <div className="login-panel">
        <div className="login-copy">
          <span className="secure-mark" aria-hidden="true">⌑</span>
          <h2>Not available to this account.</h2>
          <p>
            The platform console is limited to platform administrators. If you run a store,
            your own dashboard is in the <a href="/portal">store portal</a>.
          </p>
        </div>
      </div>
    );
  }

  const pending = applications.filter(a => a.status === 'pending');

  return (
    <section className="admin-console">
      <div className="dashboard-top">
        <div>
          <p className="eyebrow">Platform administration</p>
          <h2>{pending.length} application{pending.length === 1 ? '' : 's'} awaiting review</h2>
        </div>
        <div>
          <a className="button button-outline" href="/portal">Store portal</a>
        </div>
      </div>

      {notice && <p className="form-error is-ok" role="status">{notice}</p>}
      {error && <p className="form-error" role="alert">{error}</p>}

      <div className="mode-switch" role="tablist" aria-label="Which applications to show">
        <button type="button" role="tab" aria-selected={tab === 'pending'}
          className={`mode-option${tab === 'pending' ? ' is-active' : ''}`}
          onClick={() => setTab('pending')}>
          Awaiting review
        </button>
        <button type="button" role="tab" aria-selected={tab === 'all'}
          className={`mode-option${tab === 'all' ? ' is-active' : ''}`}
          onClick={() => setTab('all')}>
          All applications
        </button>
      </div>

      <div className="review-list">
        {applications.length ? applications.map(application => (
          <ApplicationCard
            key={application.id}
            application={application}
            busy={busy}
            onApprove={handleApprove}
            onReject={handleReject}
          />
        )) : (
          <p className="card-copy">
            {tab === 'pending' ? 'Nothing waiting. New sign-ups appear here.' : 'No applications yet.'}
          </p>
        )}
      </div>

      <section className="plan-section" aria-labelledby="stores-title">
        <div className="section-heading">
          <div><p className="eyebrow">Registered</p><h2 id="stores-title">Stores</h2></div>
        </div>
        <div className="inventory-table-wrap">
          <table>
            <thead>
              <tr><th>Store</th><th>Address</th><th>Plan</th><th>Status</th></tr>
            </thead>
            <tbody>
              {stores.length ? stores.map(store => (
                <tr key={store.id}>
                  <td>{store.name}</td>
                  <td><code>/{store.slug}</code></td>
                  <td>{store.plan}</td>
                  <td>{store.status}</td>
                </tr>
              )) : <tr><td colSpan={4}>No stores yet.</td></tr>}
            </tbody>
          </table>
        </div>
      </section>

      <section className="plan-section" aria-labelledby="audit-title">
        <div className="section-heading">
          <div>
            <p className="eyebrow">Every decision, recorded</p>
            <h2 id="audit-title">Activity</h2>
          </div>
        </div>
        <div className="inventory-table-wrap">
          <table>
            <thead><tr><th>When</th><th>Who</th><th>What</th></tr></thead>
            <tbody>
              {audit.length ? audit.map(entry => (
                <tr key={entry.id}>
                  <td><small>{timeAgo(entry.at)}</small></td>
                  <td>{entry.actor_email || '—'}</td>
                  <td>
                    {entry.action.replace('application.', '')}
                    <small>{entry.detail?.store_name || ''}</small>
                  </td>
                </tr>
              )) : <tr><td colSpan={3}>No decisions recorded yet.</td></tr>}
            </tbody>
          </table>
        </div>
      </section>
    </section>
  );
}
