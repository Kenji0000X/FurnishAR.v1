'use client';

import Link from 'next/link';
import { useRouter, useSearchParams } from 'next/navigation';
import { useCallback, useEffect, useState } from 'react';
import { initBackend, usingSupabase, supabase } from '../portal/backend.js';
import { destinationFor } from '../../lib/role-routes.mjs';
import { safeLocalPath } from '../../lib/safe-path.mjs';
import useAlert from '../alerts/useAlert.js';

/**
 * A signed-in account with no role yet (typically a first Google sign-in).
 *                                                   DFD: P1 → D1 (buyer) / D4 (application)
 *
 * Asks ONE question, then only for what is missing:
 *   shopping  → the municipality (the name came from Google; no password —
 *               the account already has a way to sign in)
 *   store     → the application fields; an admin reviews it, and only
 *               approval makes the account a store owner.
 * The database refuses anything else (0011): an admin, an owner or an
 * applicant cannot re-onboard, and nothing here can make an admin.
 */
export default function Onboarding() {
  const router = useRouter();
  const params = useSearchParams();
  const alert = useAlert();
  const as = params.get('as');
  const next = safeLocalPath(params.get('next'));

  const [state, setState] = useState(null);       // my_account_state()
  const [towns, setTowns] = useState([]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [filed, setFiled] = useState(null);

  const load = useCallback(async () => {
    await initBackend();
    if (!usingSupabase()) { setState({ role: 'offline' }); return; }
    const sb = supabase();
    const role = await sb.myRole().catch(() => 'unreachable');
    if (role === 'guest') { router.replace(`/login${next ? `?next=${encodeURIComponent(next)}` : ''}`); return; }
    if (role !== 'onboarding') { router.replace(destinationFor(role, { next })); return; }
    const [current, list] = await Promise.all([sb.accountState().catch(() => ({ role })), sb.listMunicipalities().catch(() => [])]);
    setState(current);
    setTowns(list);
  }, [router, next]);

  useEffect(() => { load(); }, [load]);

  const choose = value => {
    const query = new URLSearchParams();
    if (value) query.set('as', value);
    if (next) query.set('next', next);
    router.push(`/onboarding${query.size ? `?${query}` : ''}`);
  };

  async function becomeBuyer(event) {
    event.preventDefault();
    const values = Object.fromEntries(new FormData(event.currentTarget));
    setBusy(true);
    setError('');
    try {
      await supabase().accountAction('buyer', {
        municipality: String(values.municipality || ''),
        ...(values.fullName ? { fullName: String(values.fullName) } : {})
      });
      alert.raise('auth.signed-up');
      router.replace(destinationFor('buyer', { next }));
    } catch (failure) {
      setError(failure.message);
      setBusy(false);
    }
  }

  async function apply(event) {
    event.preventDefault();
    const values = Object.fromEntries(new FormData(event.currentTarget));
    setBusy(true);
    setError('');
    try {
      const result = await supabase().accountAction('apply', {
        storeName: String(values.storeName || ''), phone: String(values.phone || ''), message: String(values.message || '')
      });
      setFiled(result.storeName || String(values.storeName));
    } catch (failure) {
      setError(failure.message);
    }
    setBusy(false);
  }

  if (!state) return <p className="card-copy">One moment…</p>;
  if (state.role === 'offline' || state.role === 'unreachable') {
    return (
      <div className="login-panel"><div className="login-copy">
        <h1 id="onboarding-title">We can&rsquo;t set up your account right now.</h1>
        <p>The server did not answer. Check your connection and reload this page.</p>
      </div></div>
    );
  }

  if (filed) {
    return (
      <div className="login-panel">
        <div className="login-copy">
          <span className="secure-mark" aria-hidden="true">⌑</span>
          <h1 id="onboarding-title">Application received.</h1>
          <p><b>{filed}</b> is in our review queue. A person checks every shop by hand, and we email <b>{state.email}</b> when it is decided.</p>
          <p className="demo-note">After approval you connect a PayPal seller account under Billing, so buyers can pay you.</p>
        </div>
        <div className="panel-actions">
          <Link className="button button-primary" href="/portal">Open the store portal</Link>
        </div>
      </div>
    );
  }

  const greeting = state.name ? `Welcome, ${state.name.split(' ')[0]}.` : 'Welcome to FurnishAR.';
  const rejected = state.application?.status === 'rejected' ? state.application : null;

  if (as !== 'buyer' && as !== 'store') {
    return (
      <div className="role-choice">
        <div className="login-copy">
          <span className="secure-mark" aria-hidden="true">⌑</span>
          <h1 id="onboarding-title">{greeting} What will you use FurnishAR for?</h1>
          <p>You are signed in as <b>{state.email}</b>. Choose once; you can&rsquo;t use the same account for both.</p>
        </div>
        <div className="role-cards">
          <button type="button" className="role-card" onClick={() => choose('buyer')}>
            <span className="role-card-mark" aria-hidden="true">⌂</span>
            <b>I&rsquo;m shopping for furniture</b>
            <span>Measure your room, stand furniture in it at true size, and buy from local shops.</span>
            <span className="role-card-go" aria-hidden="true">Continue →</span>
          </button>
          <button type="button" className="role-card" onClick={() => choose('store')}>
            <span className="role-card-mark" aria-hidden="true">⌗</span>
            <b>I run a furniture store</b>
            <span>Apply to list your furniture. We review every shop, then you connect PayPal to take payments.</span>
            <span className="role-card-go" aria-hidden="true">Apply →</span>
          </button>
        </div>
      </div>
    );
  }

  if (as === 'buyer') {
    return (
      <div className="login-panel">
        <div className="login-copy">
          <span className="secure-mark" aria-hidden="true">⌑</span>
          <h1 id="onboarding-title">{greeting}</h1>
          <p>One detail and your shopper account is ready. No password needed — you sign in with Google.</p>
        </div>
        <form className="login-form" onSubmit={becomeBuyer}>
          {state.name ? (
            <p className="form-note">Name: <b>{state.name}</b> (from your Google account)</p>
          ) : (
            <label>Your name<input name="fullName" required minLength={2} maxLength={80} autoComplete="name" /></label>
          )}
          <label>
            Municipality
            <select name="municipality" required defaultValue="">
              <option value="" disabled>Where in Occidental Mindoro?</option>
              {towns.map(town => <option key={town} value={town}>{town}</option>)}
            </select>
          </label>
          <button className="button button-primary" type="submit" disabled={busy || !towns.length} aria-busy={busy || undefined}>
            {busy ? <><span className="loading-spinner" aria-hidden="true" />Setting up…</> : <>Start shopping <span aria-hidden="true">→</span></>}
          </button>
          {!towns.length && <p className="form-error" role="status">The municipality list did not load. Reload the page to try again.</p>}
          <p className="form-error" role="alert" aria-live="assertive">{error}</p>
          <button type="button" className="text-button" onClick={() => choose('')}>Back</button>
        </form>
      </div>
    );
  }

  return (
    <div className="login-panel">
      <div className="login-copy">
        <span className="secure-mark" aria-hidden="true">⌑</span>
        <h1 id="onboarding-title">List your store on FurnishAR.</h1>
        <p>We check every application by hand. Replies go to <b>{state.email}</b>.</p>
        {rejected && (
          <p className="demo-note" role="status">
            Your earlier application for <b>{rejected.store_name}</b> was not approved
            {rejected.review_note ? `: ${rejected.review_note}` : '.'} You can apply again.
          </p>
        )}
      </div>
      <form className="login-form" onSubmit={apply}>
        <label>Store name<input name="storeName" required minLength={2} maxLength={120} autoComplete="organization" /></label>
        <label>Contact number<input name="phone" type="tel" required inputMode="tel" autoComplete="tel" pattern="[0-9+() \-]{7,20}" placeholder="0917 123 4567…" /></label>
        <label>
          What will you list?
          <textarea name="message" rows={2} maxLength={1000} placeholder="e.g. 40 pieces, mostly cabinets and dining sets…" />
        </label>
        <button className="button button-primary" type="submit" disabled={busy} aria-busy={busy || undefined}>
          {busy ? <><span className="loading-spinner" aria-hidden="true" />Sending…</> : <>Send application <span aria-hidden="true">→</span></>}
        </button>
        <p className="form-error" role="alert" aria-live="assertive">{error}</p>
        <button type="button" className="text-button" onClick={() => choose('')}>Back</button>
      </form>
    </div>
  );
}
