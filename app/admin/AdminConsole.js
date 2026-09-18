'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import { initBackend, usingSupabase, supabase, backendReason } from '../portal/backend.js';
import PasswordField from '../PasswordField.js';

/**
 * The superadmin console: vetting store owners before they get a shop.
 *
 * What protects this is NOT this file. Every call it makes is refused by row
 * level security unless the signed-in account is in `platform_admins` — see
 * supabase/migrations/0003_platform_admin.sql and tests/admin.test.js. This
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

/**
 * The bucket's own limit is 100 MB (0005_raise_model_limit.sql), but a model
 * that big will take minutes on the 3G-ish connections this is built for, so
 * the console flags well before the hard ceiling — this is a "worth a second
 * look" line, not the actual limit.
 */
const OVERSIZED_BYTES = 40 * 1024 * 1024;
const isOversized = bytes => Number(bytes) > OVERSIZED_BYTES;

function formatBytes(bytes) {
  const size = Number(bytes);
  if (!Number.isFinite(size) || size <= 0) return '—';
  const units = ['B', 'KB', 'MB', 'GB'];
  const power = Math.min(Math.floor(Math.log(size) / Math.log(1024)), units.length - 1);
  const value = size / 1024 ** power;
  return `${value < 10 && power > 0 ? value.toFixed(1) : Math.round(value)} ${units[power]}`;
}

/** Turns a store name into the slug the shop will live at. */
const slugify = value =>
  String(value || '').toLowerCase().trim().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');

/**
 * What the database will say about the applicant's account when asked.
 *
 * Shown so the reviewer knows before pressing anything; `approve_store_application`
 * re-checks the same facts in its own transaction, so this is a convenience,
 * never the check itself.
 */
/**
 * "Email not confirmed" used to be a dead end — the applicant's account
 * exists, but Supabase only ever sent that one confirmation email at
 * sign-up, and if it landed in spam or was never seen, there was nothing an
 * admin (or the applicant) could do except wait indefinitely. Approve stayed
 * disabled with no path forward. This button asks Supabase to send it again.
 */
function ResendConfirmation({ email }) {
  const [state, setState] = useState('idle'); // idle | sending | sent | error

  async function resend() {
    setState('sending');
    try {
      await supabase().resendConfirmation(email);
      setState('sent');
    } catch {
      setState('error');
    }
  }

  if (state === 'sent') return <span className="verification-note">Sent — ask them to check spam too.</span>;
  return (
    <>
      <button className="text-button" type="button" onClick={resend} disabled={state === 'sending'}>
        {state === 'sending' ? 'Sending…' : 'Resend confirmation email'}
      </button>
      {state === 'error' && <span className="verification-note">Could not send it — try again shortly.</span>}
    </>
  );
}

function AccountState({ account, email }) {
  if (!account) return <dd>checking…</dd>;
  if (!account.found) return <dd className="verification-warning">no account with this address yet</dd>;
  if (account.disabled) return <dd className="verification-warning">the account is disabled</dd>;
  if (!account.confirmed) {
    return (
      <dd className="verification-warning">
        email not confirmed — cannot be approved yet
        <br />
        <ResendConfirmation email={email} />
      </dd>
    );
  }
  return (
    <dd className="verification-ok">
      email confirmed {timeAgo(account.confirmed_at)}
      {account.last_sign_in_at ? `, last signed in ${timeAgo(account.last_sign_in_at)}` : ', never signed in'}
    </dd>
  );
}

function ApplicationCard({ application, account, onApprove, onReject, busy }) {
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
        <div><dt>Their account</dt><AccountState account={account} email={application.contact_email} /></div>
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
              {/* The database refuses an unconfirmed account anyway; greying
                  the button out says so before the reviewer commits to it. */}
              <button className="button button-primary" type="button"
                disabled={busy || !slug || !(account?.found && account.confirmed && !account.disabled)}
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
  const [state, setState] = useState('loading'); // loading | signin | denied | ready | offline
  const [reason, setReason] = useState('');
  const [tab, setTab] = useState('pending');
  const [applications, setApplications] = useState([]);
  const [stores, setStores] = useState([]);
  const [accounts, setAccounts] = useState({});
  const [audit, setAudit] = useState([]);
  const [models, setModels] = useState([]);
  const [missingModels, setMissingModels] = useState([]);
  const [usage, setUsage] = useState([]);
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState('');
  const [error, setError] = useState('');
  const [loginError, setLoginError] = useState('');

  const load = useCallback(async () => {
    const sb = supabase();
    const [queue, allStores, recent, uploads, missing, storageUsage] = await Promise.all([
      sb.listApplications(tab === 'pending' ? 'pending' : null).catch(() => []),
      sb.listAllStores().catch(() => []),
      sb.listAudit(25).catch(() => []),
      sb.listUploadedModels(200).catch(() => []),
      sb.listMissingModels(200).catch(() => []),
      sb.listStorageUsage().catch(() => [])
    ]);
    setApplications(queue);
    setStores(allStores);
    setAudit(recent);
    setModels(uploads);
    setMissingModels(missing);
    setUsage(storageUsage);

    // One lookup per pending application. They are separate calls because each
    // is a separate security-definer check; there are only ever a handful.
    const pending = queue.filter(application => application.status === 'pending');
    const looked = await Promise.all(pending.map(application =>
      sb.applicantAccount(application.id)
        .then(account => [application.id, account])
        .catch(() => [application.id, { found: false, confirmed: false, disabled: false }])));
    setAccounts(Object.fromEntries(looked));
  }, [tab]);

  /**
   * Ask the server who is asking, and act on the answer.
   *
   * Three outcomes, and telling them apart is the whole fix here:
   *
   *   nobody signed in        -> ask for credentials ('signin')
   *   signed in, not an admin -> say so ('denied')
   *   signed in, an admin     -> the console ('ready')
   *
   * It used to collapse the first two into `router.replace('/portal')`. The
   * portal links here as "Superadmin sign-in →", but this page never asked
   * anyone to sign in — it only inspected the session it happened to find. So
   * a store owner who followed that link was bounced straight back to their
   * own dashboard with no message at all, which reads exactly like the link
   * logging you into the wrong account. There was, in fact, no way to sign in
   * as the superadmin from here.
   *
   * Showing a sign-in form gives nothing away that was not already public: the
   * portal links to this URL by name. What stays hidden is everything behind
   * it — the queue, the applicants, who the administrators are — because RLS
   * refuses all of it regardless of what this component renders.
   *
   * Written as its own function because it has to run again later — after a
   * sign-in, and on a page restored from the back-forward cache where React
   * does not re-mount and an effect would never fire twice.
   */
  const verify = useCallback(async () => {
    await initBackend();

    if (!usingSupabase()) {
      setReason(backendReason() || 'No database is connected.');
      setState('offline');
      return;
    }

    const sb = supabase();
    // Nobody signed in at all is a different answer from "signed in and not
    // allowed", and the two need different screens.
    if (!(await sb.getSession())) {
      setState('signin');
      return;
    }

    // The server answers this, and answers "no" for anyone who is not in
    // platform_admins. It decides the view; RLS decides the data.
    if (!(await sb.isPlatformAdmin())) {
      setState('denied');
      return;
    }

    await load();
    setState('ready');
  }, [load]);

  useEffect(() => {
    let active = true;
    verify().catch(() => { if (active) setState('denied'); });
    return () => { active = false; };
  }, [verify]);

  /** Sign in from this page, then re-check the role against the server. */
  async function handleAdminLogin(event) {
    event.preventDefault();
    const form = event.currentTarget;
    const values = Object.fromEntries(new FormData(form));
    setLoginError('');
    setBusy(true);
    try {
      await supabase().signIn({ email: String(values.email), password: String(values.password) });
      setState('loading');
      await verify();
    } catch (error) {
      setLoginError(error.message);
    } finally {
      setBusy(false);
    }
  }

  /** Leave the account that is not an admin, so another can be used. */
  async function handleSwitchAccount() {
    try { await supabase().signOut(); } catch { /* already gone */ }
    setLoginError('');
    setState('signin');
  }

  /**
   * A page restored from the back-forward cache comes back exactly as it was —
   * same DOM, same React state, no effects re-run. Next serves this route
   * no-store, which disqualifies it from that cache in Chrome and Firefox, but
   * Safari has historically restored no-store pages anyway. So the restore is
   * caught and the check redone: an account signed out in another tab, or an
   * admin whose access was revoked, does not get to keep the queue on screen.
   */
  useEffect(() => {
    const onShow = event => { if (event.persisted) verify().catch(() => {}); };
    window.addEventListener('pageshow', onShow);
    return () => window.removeEventListener('pageshow', onShow);
  }, [verify]);

  /**
   * Reloads when the reviewer switches tabs, without re-fetching the moment
   * `state` becomes 'ready' — verify() already loaded that data one line
   * above, so without this guard the very first render of the console fired
   * every query in `load()` twice. `isFirstReady` distinguishes "we just
   * arrived at ready" from "we were already ready and the tab changed".
   */
  const isFirstReady = useRef(true);
  useEffect(() => {
    if (state !== 'ready') { isFirstReady.current = true; return; }
    if (isFirstReady.current) { isFirstReady.current = false; return; }
    load().catch(() => {});
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

  if (state === 'signin') {
    return (
      <div className="login-panel">
        <div className="login-copy">
          <span className="secure-mark" aria-hidden="true">⌑</span>
          <h2>Platform console</h2>
          <p>Sign in with an administrator account.</p>
          <p className="demo-note">
            This is not the store portal. Store owners sign in at{' '}
            <a href="/portal">/portal</a>.
          </p>
        </div>
        <form className="login-form" onSubmit={handleAdminLogin}>
          <label>
            Email
            <input
              name="email"
              type="email"
              required
              autoComplete="email"
              aria-invalid={loginError ? 'true' : undefined}
            />
          </label>
          <PasswordField autoComplete="current-password" />
          <button className="button button-primary" type="submit" disabled={busy}>
            {busy ? 'Signing in…' : <>Sign in <span aria-hidden="true">→</span></>}
          </button>
          {/* The refusal is identical whether the address is unknown, the
              password is wrong, or the account simply is not an administrator.
              Saying which would turn this form into a way to find out who the
              administrators are. */}
          <p className="form-error" role="alert" aria-live="assertive">{loginError}</p>
        </form>
      </div>
    );
  }

  if (state === 'denied') {
    // Said plainly, instead of a silent router.replace('/portal').
    //
    // The redirect was meant to avoid showing a locked door. What it actually
    // did was drop a signed-in store owner back into their own dashboard with
    // no explanation — so following the portal's own "Superadmin sign-in →"
    // link looked like it had logged you into the wrong account. Telling
    // someone their account is not an administrator reveals nothing they could
    // not learn by reading this page's URL in the portal footer, and it is the
    // difference between a refusal and a bug.
    return (
      <div className="login-panel">
        <div className="login-copy">
          <span className="secure-mark" aria-hidden="true">⌑</span>
          <h2>This account is not an administrator.</h2>
          <p>
            You are signed in, but this account is not on the platform administrator
            list, so the review queue is not available to it.
          </p>
          <p className="demo-note">
            Signed in to manage a shop? That is the <a href="/portal">store portal</a>.
          </p>
        </div>
        <div className="login-form">
          <button className="button button-primary" type="button" onClick={handleSwitchAccount}>
            Sign in as someone else
          </button>
          <a className="button" href="/portal">Go to the store portal</a>
        </div>
      </div>
    );
  }

  const pending = applications.filter(a => a.status === 'pending');
  const totalBytes = models.reduce((sum, asset) => sum + (Number(asset.byte_size) || 0), 0);

  return (
    <section className="admin-console">
      {/* Only rendered once the server has confirmed an admin is asking. It
          used to sit in page.js, where it greeted everybody who typed the URL. */}
      <section className="admin-intro">
        <p className="eyebrow">Platform administration</p>
        <h1 id="console-title">Store applications</h1>
        <p>
          Check each applicant before approving. Approving creates their store and lets
          them publish furniture that shoppers will see.
        </p>
      </section>

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
            account={accounts[application.id]}
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

      <section className="plan-section" aria-labelledby="models-title">
        <div className="section-heading">
          <div>
            <p className="eyebrow">Uploaded across every store</p>
            <h2 id="models-title">3D files</h2>
          </div>
          <p className="card-copy">
            {models.length} file{models.length === 1 ? '' : 's'}, {formatBytes(totalBytes)} in total
          </p>
        </div>

        {/* Read-only on purpose. Removing or replacing a model is the owning
            shop's job — this is here so an oversized or missing file can be
            noticed, not so one shop's inventory can be edited from another. */}
        <div className="inventory-table-wrap">
          <table>
            <thead>
              <tr><th>Store</th><th>Product</th><th>Kind</th><th>Size</th><th>Uploaded</th></tr>
            </thead>
            <tbody>
              {models.length ? models.map(asset => (
                <tr key={asset.id}>
                  <td>{asset.product?.store?.name || '—'}</td>
                  <td>
                    {asset.product?.name || '—'}
                    {asset.product?.status !== 'published' && (
                      <small> ({asset.product?.status})</small>
                    )}
                  </td>
                  <td><code>{asset.kind}</code></td>
                  <td className={isOversized(asset.byte_size) ? 'verification-warning' : undefined}>
                    {formatBytes(asset.byte_size)}
                  </td>
                  <td><small>{timeAgo(asset.created_at)}</small></td>
                </tr>
              )) : <tr><td colSpan={5}>Nothing uploaded yet.</td></tr>}
            </tbody>
          </table>
        </div>

        {missingModels.length > 0 && (
          <>
            <p className="card-copy verification-warning">
              {missingModels.length} listing{missingModels.length === 1 ? '' : 's'} with no 3D model
              attached — these cannot be placed in AR.
            </p>
            <div className="inventory-table-wrap">
              <table>
                <thead><tr><th>Store</th><th>Product</th><th>Status</th></tr></thead>
                <tbody>
                  {missingModels.map(product => (
                    <tr key={product.id}>
                      <td>{product.store?.name || '—'}</td>
                      <td>{product.name}</td>
                      <td>{product.status}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </>
        )}

        {/* Bytes, not files: a per-file cap says nothing about the total the
            project's storage plan actually bills or caps. Raising the per-file
            limit without anywhere to watch the total would be the same mistake
            with worse timing — a quota hit discovered by an owner's upload
            failing, not by anyone looking. */}
        <div className="section-heading">
          <div>
            <p className="eyebrow">Against your storage plan</p>
            <h2>Usage by store</h2>
          </div>
        </div>
        <div className="inventory-table-wrap">
          <table>
            <thead><tr><th>Store</th><th>Files</th><th>Storage used</th></tr></thead>
            <tbody>
              {usage.length ? usage.map(row => (
                <tr key={row.store_id}>
                  <td>{row.store_name}</td>
                  <td>{row.file_count}</td>
                  <td>{formatBytes(row.total_bytes)}</td>
                </tr>
              )) : <tr><td colSpan={3}>No files uploaded yet.</td></tr>}
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
