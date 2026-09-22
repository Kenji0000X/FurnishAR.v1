'use client';

import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { useCallback, useEffect, useState } from 'react';
import { initBackend, usingSupabase, supabase, backendReason } from '../portal/backend.js';

/**
 * The shopper's own page — the buyer half of what /portal is for an owner.
 *
 * Deliberately small, and honest about being small. A shopper account exists
 * to unlock the planner and to hold a name and a town; it does not hold
 * orders, because FurnishAR does not take orders, and it does not hold saved
 * rooms yet, because nothing saves them. Inventing an "Order history (0)"
 * panel would make this page look finished while telling a shopper the site
 * does something it does not.
 *
 * What it does have is real: the name and municipality the account was
 * created with, editable, read back from the database rather than from
 * whatever the sign-up form remembered.
 */
const MUNICIPALITY_HINT = 'Used to show you the shops nearest you as more join.';

export default function BuyerAccount() {
  const router = useRouter();
  const [state, setState] = useState('loading'); // loading | offline | guest | wrong-door | ready
  const [reason, setReason] = useState('');
  const [profile, setProfile] = useState(null);
  const [towns, setTowns] = useState([]);
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState('');
  const [error, setError] = useState('');

  const verify = useCallback(async () => {
    await initBackend();
    if (!usingSupabase()) {
      setReason(backendReason() || 'No database is connected.');
      setState('offline');
      return;
    }
    const sb = supabase();
    const role = await sb.myRole();
    if (role === 'guest') { setState('guest'); return; }
    if (role !== 'buyer') { setState('wrong-door'); return; }

    const [row, list] = await Promise.all([
      sb.buyerProfile(),
      sb.listMunicipalities().catch(() => [])
    ]);
    setProfile(row);
    setTowns(list);
    setState('ready');
  }, []);

  useEffect(() => {
    let alive = true;
    verify().catch(() => { if (alive) setState('guest'); });
    return () => { alive = false; };
  }, [verify]);

  /* Same reasoning as the console: a page restored from the back-forward
     cache comes back exactly as it was, so an account signed out in another
     tab must not keep its details on screen. */
  useEffect(() => {
    const onShow = event => { if (event.persisted) verify().catch(() => {}); };
    window.addEventListener('pageshow', onShow);
    return () => window.removeEventListener('pageshow', onShow);
  }, [verify]);

  async function handleSave(event) {
    event.preventDefault();
    const values = Object.fromEntries(new FormData(event.currentTarget));
    setBusy(true);
    setError('');
    setNotice('');
    try {
      await supabase().updateBuyerProfile({
        fullName: String(values.fullName).trim(),
        municipality: String(values.municipality)
      });
      setProfile(await supabase().buyerProfile());
      setNotice('Saved.');
    } catch (saveError) {
      setError(saveError.message);
    } finally {
      setBusy(false);
    }
  }

  async function handleSignOut() {
    try { await supabase().signOut(); } catch { /* already gone */ }
    /* Thrown away rather than hidden — the same rule as the console. */
    setProfile(null);
    router.push('/');
  }

  if (state === 'loading') return <p className="card-copy">One moment…</p>;

  if (state === 'offline') {
    return (
      <div className="login-panel">
        <div className="login-copy">
          <span className="secure-mark" aria-hidden="true">⌑</span>
          <h1>Accounts need the database.</h1>
          <p className="demo-note">{reason}</p>
          <p className="demo-note"><Link href="/collection">Browse the catalogue</Link> instead.</p>
        </div>
      </div>
    );
  }

  if (state === 'guest') {
    return (
      <div className="login-panel">
        <div className="login-copy">
          <span className="secure-mark" aria-hidden="true">⌑</span>
          <h1 id="account-title">You are not signed in.</h1>
          <p>Sign in to see your account, or create one — it takes a name and a town.</p>
        </div>
        <div className="panel-actions">
          <Link className="button button-primary" href="/login?as=buyer">
            Sign in <span aria-hidden="true">→</span>
          </Link>
          <Link className="button" href="/collection">Browse the catalogue</Link>
        </div>
      </div>
    );
  }

  if (state === 'wrong-door') {
    /* Said plainly rather than redirected. A store owner who lands here has
       not done anything wrong, and a silent bounce back to the portal reads
       exactly like being logged into the wrong account. */
    return (
      <div className="login-panel">
        <div className="login-copy">
          <span className="secure-mark" aria-hidden="true">⌑</span>
          <h1 id="account-title">This account sells on FurnishAR.</h1>
          <p>
            Shopper accounts and store accounts are separate, so this page has nothing
            in it for you. Your shop lives in the store portal.
          </p>
        </div>
        <div className="panel-actions">
          <Link className="button button-primary" href="/portal">
            Go to the store portal <span aria-hidden="true">→</span>
          </Link>
        </div>
      </div>
    );
  }

  return (
    <>
      <section className="admin-intro">
        <p className="eyebrow">Your account</p>
        <h1 id="account-title">{profile?.full_name || 'Shopper'}</h1>
        <p>
          Signed in to FurnishAR. Your account unlocks the space planner and holds
          your name and town — nothing else is kept.
        </p>
      </section>

      {notice && <p className="form-error is-ok" role="status">{notice}</p>}

      <div className="account-grid">
        <section className="plan-section" aria-labelledby="details-title">
          <div className="section-heading">
            <div>
              <p className="eyebrow">Your details</p>
              <h2 id="details-title">Name and town</h2>
            </div>
          </div>
          <form className="login-form" onSubmit={handleSave}>
            <label>
              Your name
              <input name="fullName" type="text" required minLength={2} maxLength={80}
                defaultValue={profile?.full_name || ''} autoComplete="name" />
            </label>
            <label>
              Municipality
              <select name="municipality" required defaultValue={profile?.municipality || ''}>
                <option value="" disabled>Where in Occidental Mindoro?</option>
                {towns.map(town => <option key={town} value={town}>{town}</option>)}
              </select>
              <small className="field-hint">{MUNICIPALITY_HINT}</small>
            </label>
            <button className="button button-primary" type="submit" disabled={busy}>
              {busy ? 'Saving…' : 'Save changes'}
            </button>
            <p className="form-error" role="alert" aria-live="assertive">{error}</p>
          </form>
        </section>

        <section className="plan-section" aria-labelledby="next-title">
          <div className="section-heading">
            <div>
              <p className="eyebrow">What your account is for</p>
              <h2 id="next-title">Measure your space</h2>
            </div>
          </div>
          <p className="card-copy">
            The planner measures a room with your phone camera and stands a real piece
            of furniture in it, at its real size.
          </p>
          <div className="panel-actions">
            <Link className="button button-primary" href="/plan">
              Open the planner <span aria-hidden="true">→</span>
            </Link>
            <Link className="button" href="/collection">Browse the catalogue</Link>
            <button className="button button-outline" type="button" onClick={handleSignOut}>
              Sign out
            </button>
          </div>
          {/* Said rather than implied by an empty panel. */}
          <p className="card-copy demo-note">
            FurnishAR does not take orders or payments, and rooms you measure are not
            saved to your account yet — they live on your device only.
          </p>
        </section>
      </div>
    </>
  );
}
