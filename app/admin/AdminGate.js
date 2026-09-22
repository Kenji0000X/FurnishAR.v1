'use client';

import { createContext, useCallback, useContext, useEffect, useState } from 'react';
import { initBackend, usingSupabase, supabase, backendReason } from '../portal/backend.js';
import PasswordField from '../PasswordField.js';
import AdminNav from './AdminNav.js';

/**
 * One door for the whole console, and one copy of its data.
 *
 * The console used to be a single 685-line component where six unrelated
 * tables — applications, stores, 3D files, usage, activity — were stacked down
 * one page. An operator looking for "how much storage is left" scrolled past
 * every applicant's email address to find it, and there was no URL for any of
 * it: you could not send a colleague a link to the review queue.
 *
 * It is six routes now. This gate lives in the layout, so moving between them
 * does NOT re-mount it: the role check runs once and the six queries run once,
 * rather than on every tab. That matters because `load()` is six round trips
 * plus one per pending application, and re-running them on each click would
 * make navigation feel broken on the connections this is built for.
 *
 * What protects the console is NOT this file. Every call it makes is refused
 * by row level security unless the signed-in account is in `platform_admins` —
 * see supabase/migrations/0003_platform_admin.sql and tests/admin.test.js.
 * This component decides what to *render*; the database decides what is
 * *allowed*.
 */

const AdminContext = createContext(null);

/**
 * Read the console's data from any of its pages.
 *
 * Throws rather than returning null outside the gate: a page that renders an
 * empty table because it was mounted in the wrong place looks exactly like a
 * platform with no stores, which is the single most misleading thing this
 * console could say.
 */
export function useAdmin() {
  const value = useContext(AdminContext);
  if (!value) throw new Error('useAdmin() must be used inside the /admin layout');
  return value;
}

export default function AdminGate({ children }) {
  const [state, setState] = useState('loading'); // loading | signin | denied | ready | offline
  const [reason, setReason] = useState('');
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
  const [email, setEmail] = useState('');

  /**
   * Every application, always — not just the pending ones.
   *
   * The old console refetched the queue whenever you switched between
   * "Awaiting review" and "All applications". That was a network round trip to
   * answer a question the browser already had the data for, and it meant the
   * Overview page's "N awaiting review" count could disagree with the
   * Applications page depending on which tab was last open. One fetch, filtered
   * where it is displayed.
   */
  const load = useCallback(async () => {
    const sb = supabase();
    const [queue, allStores, recent, uploads, missing, storageUsage] = await Promise.all([
      sb.listApplications(null).catch(() => []),
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
  }, []);

  /**
   * Ask the server who is asking, and act on the answer.
   *
   *   nobody signed in        -> ask for credentials ('signin')
   *   signed in, not an admin -> say so ('denied')
   *   signed in, an admin     -> the console ('ready')
   *
   * Showing a sign-in form gives nothing away that was not already public: the
   * portal links to this URL by name. What stays hidden is everything behind
   * it — the queue, the applicants, who the administrators are — because RLS
   * refuses all of it regardless of what this component renders.
   */
  const verify = useCallback(async () => {
    await initBackend();

    if (!usingSupabase()) {
      setReason(backendReason() || 'No database is connected.');
      setState('offline');
      return;
    }

    const sb = supabase();
    const current = await sb.getSession();
    if (!current) {
      setState('signin');
      return;
    }
    // Shown beside Sign out, so it is obvious WHICH account is about to be
    // signed out — the one thing a shared machine makes easy to get wrong.
    setEmail(current.user?.email || '');

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
    } catch (signInError) {
      setLoginError(signInError.message);
    } finally {
      setBusy(false);
    }
  }

  /**
   * Leave the console.
   *
   * Everything the console loaded is thrown away with the session, not just
   * hidden: the queue holds applicants' email addresses and phone numbers,
   * and leaving them in React state would put them back on screen if the
   * next person signed in, or if the page came back from the bfcache.
   */
  async function handleSignOut() {
    try { await supabase().signOut(); } catch { /* already gone */ }
    setApplications([]);
    setStores([]);
    setAccounts({});
    setAudit([]);
    setModels([]);
    setMissingModels([]);
    setUsage([]);
    setNotice('');
    setError('');
    setEmail('');
    setLoginError('');
    setState('signin');
  }

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
          <h1>The console needs the database.</h1>
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
          <h1>Platform console</h1>
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
          <p className="form-error" role="alert" aria-live="assertive">{loginError}</p>
        </form>
      </div>
    );
  }

  if (state === 'denied') {
    return (
      <div className="login-panel">
        <div className="login-copy">
          <span className="secure-mark" aria-hidden="true">⌑</span>
          <h1>This account is not an administrator.</h1>
          <p>
            You are signed in, but this account is not on the platform administrator
            list, so the review queue is not available to it.
          </p>
          <p className="demo-note">
            Signed in to manage a shop? That is the <a href="/portal">store portal</a>.
          </p>
        </div>
        <div className="login-form">
          <button className="button button-primary" type="button" onClick={handleSignOut}>
            Sign in as someone else
          </button>
          <a className="button" href="/portal">Go to the store portal</a>
        </div>
      </div>
    );
  }

  const value = {
    applications, stores, accounts, audit, models, missingModels, usage,
    busy, setBusy, notice, setNotice, error, setError, reload: load,
    onApprove: handleApprove, onReject: handleReject
  };

  return (
    <AdminContext.Provider value={value}>
      <div className="admin-console">
        <AdminNav
          pending={applications.filter(a => a.status === 'pending').length}
          email={email}
          onSignOut={handleSignOut}
        />
        {notice && <p className="form-error is-ok" role="status">{notice}</p>}
        {error && <p className="form-error" role="alert">{error}</p>}
        {children}
      </div>
    </AdminContext.Provider>
  );
}
