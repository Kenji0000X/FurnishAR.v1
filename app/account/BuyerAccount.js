'use client';

import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { useCallback, useEffect, useState } from 'react';
import { initBackend, usingSupabase, supabase, backendReason, backendOutage } from '../portal/backend.js';
import useAlert from '../alerts/useAlert.js';
import { noticeExpiredSession } from '../alerts/sessionExpiry.js';
import BuyerOrders from '../billing/BuyerOrders.js';

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
  const [state, setState] = useState('loading'); // loading | offline | unreachable | guest | wrong-door | ready
  const [reason, setReason] = useState('');
  const [profile, setProfile] = useState(null);
  const [email, setEmail] = useState('');
  const [towns, setTowns] = useState([]);
  const [busy, setBusy] = useState(false);
  const alert = useAlert();

  const verify = useCallback(async () => {
    await initBackend();
    if (!usingSupabase()) {
      /* Configured but not answering is an outage, not a site without
         accounts — and not a reason to show the sign-in form. */
      if (backendOutage()) { setState('unreachable'); return; }
      setReason(backendReason() || 'No database is connected.');
      setState('offline');
      return;
    }
    const sb = supabase();
    const role = await sb.myRole();
    if (role === 'guest') {
      await noticeExpiredSession(sb, '/account');
      setState('guest');
      return;
    }
    if (role !== 'buyer') { setState('wrong-door'); return; }

    const [row, list] = await Promise.all([
      sb.buyerProfile(),
      sb.listMunicipalities().catch(() => [])
    ]);
    setProfile(row);
    setEmail((await sb.getSession().catch(() => null))?.user?.email || '');
    setTowns(list);
    setState('ready');
  }, []);

  useEffect(() => {
    let alive = true;
    /* A question the server did not answer is not "you are signed out". */
    verify().catch(() => { if (alive) setState('unreachable'); });
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
    try {
      await supabase().updateBuyerProfile({
        fullName: String(values.fullName).trim(),
        municipality: String(values.municipality)
      });
      setProfile(await supabase().buyerProfile());
      /* Only after the server said yes — never optimistically. */
      alert.raise('profile.saved');
    } catch (saveError) {
      /* The whole save failed, so it is a global alert; the fields
         themselves are checked natively (required, minLength) before this
         ever runs. The server's own wording goes to the console, not the
         screen — a constraint name is not a sentence. */
      console.warn('[FurnishAR] profile save failed:', saveError?.message);
      if (saveError instanceof TypeError) alert.fromError(saveError);   // the network, not the save
      else alert.raise('profile.save-failed');
    } finally {
      setBusy(false);
    }
  }

  async function handleSignOut() {
    let revoked = true;
    try { await supabase().signOut(); } catch { revoked = false; }
    /* Thrown away rather than hidden — the same rule as the console. */
    setProfile(null);
    alert.raise(revoked ? 'auth.signed-out' : 'auth.sign-out-failed');
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

  if (state === 'unreachable') {
    return (
      <div className="login-panel">
        <div className="login-copy" role="alert">
          <span className="secure-mark" aria-hidden="true">⌑</span>
          <h1 id="account-title">Your account can&rsquo;t be reached right now.</h1>
          <p>Connection failed. Check your internet connection and try again.</p>
        </div>
        <div className="panel-actions">
          <button className="button button-primary" type="button" onClick={() => window.location.reload()}>
            Try again
          </button>
          <Link className="button" href="/collection">Browse the catalogue</Link>
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

  const name = profile?.full_name || 'Shopper';
  /* Up to two initials, from the name the shopper gave. */
  const initials = name.split(/\s+/).filter(Boolean).slice(0, 2).map(part => part[0]).join('').toUpperCase() || 'S';

  return (
    <div className="account-stack">
      <section className="account-profile" aria-labelledby="account-title">
        <span className="account-avatar" aria-hidden="true">{initials}</span>
        <h1 id="account-title" translate="no">{name}</h1>
        <p className="account-meta">
          {email && <span translate="no">{email}</span>}
          {profile?.municipality && <span>{profile.municipality}, Occidental Mindoro</span>}
        </p>
      </section>

      <BuyerOrders />

      <section className="account-card" aria-labelledby="settings-title">
        <h2 id="settings-title">Profile settings</h2>
        <p className="card-copy">Your name and town. Nothing else is kept.</p>
        <form className="login-form" onSubmit={handleSave}>
          <label>
            Your name
            <input name="fullName" type="text" required minLength={2} maxLength={80}
              defaultValue={profile?.full_name || ''} autoComplete="name" placeholder="Ana Reyes…" />
          </label>
          <label>
            Email
            <input type="email" value={email} readOnly aria-describedby="email-hint"
              autoComplete="email" spellCheck={false} />
            <small className="field-hint" id="email-hint">Used to sign in. It cannot be changed here.</small>
          </label>
          <label>
            Municipality
            <select name="municipality" required defaultValue={profile?.municipality || ''}>
              <option value="" disabled>Where in Occidental Mindoro?</option>
              {towns.map(town => <option key={town} value={town}>{town}</option>)}
            </select>
            <small className="field-hint">{MUNICIPALITY_HINT}</small>
          </label>
          <button className="button button-primary" type="submit" disabled={busy} aria-busy={busy || undefined}>
            {busy && <span className="loading-spinner" aria-hidden="true" />}
            {busy ? 'Saving…' : 'Save changes'}
          </button>
        </form>
      </section>

      <section className="account-card" aria-labelledby="next-title">
        <h2 id="next-title">Measure your space</h2>
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
        <p className="card-copy demo-note">
          Rooms you measure stay on your device; they are not saved to your account yet.
        </p>
      </section>
    </div>
  );
}
