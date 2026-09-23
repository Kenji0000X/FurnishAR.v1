'use client';

import Link from 'next/link';
import { useRouter, useSearchParams } from 'next/navigation';
import { useCallback, useEffect, useState } from 'react';
import { initBackend, usingSupabase, supabase, backendReason } from '../portal/backend.js';
import { consumeAuthIntent, peekAuthIntent, saveAuthIntent } from '../../lib/auth-intent.js';
import PasswordField from '../PasswordField.js';

/**
 * One door, two kinds of person behind it.
 *
 * FurnishAR has always had exactly one sign-in, and it was the store owner's:
 * "sign in" anywhere on the site meant "sign in to sell something". Shoppers
 * had no accounts at all. Now that they do, the first thing this page has to
 * establish is which of the two is standing in front of it — because the two
 * go to completely different places and neither form makes sense to the
 * other. A shopper does not have a store name; an owner does not have a
 * municipality we need.
 *
 * The choice is in the URL (`?as=buyer`), not in component state, so it can be
 * linked to, the Back button undoes it, and "sign in" from the planner can
 * send a shopper straight past the question to the form they need.
 *
 * Store owners are sent to /portal rather than given a second copy of the
 * store form here. That form is three fields and an application record, and
 * two copies of it would drift.
 */

/** Where to go after a successful shopper sign-in. */
function safeNext(value) {
  /* Only a path on this site. An open redirect on a sign-in page is how a
     phishing link borrows your domain: ?next=https://evil.example would send
     someone who just typed their password to somebody else's copy of it. */
  if (typeof value !== 'string' || !value.startsWith('/') || value.startsWith('//')) return null;
  return value;
}

export default function LoginChooser() {
  const router = useRouter();
  const params = useSearchParams();
  const as = params.get('as');
  const nextFromQuery = safeNext(params.get('next'));
  const rememberedNext = safeNext(peekAuthIntent());
  const next = nextFromQuery || rememberedNext;

  const [ready, setReady] = useState(false);
  const [offline, setOffline] = useState('');
  const [mode, setMode] = useState('signin'); // signin | signup
  const [towns, setTowns] = useState([]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  const [sent, setSent] = useState('');

  useEffect(() => {
    let alive = true;
    (async () => {
      setNotice('Checking your account access…');
      await initBackend();
      if (!alive) return;
      if (!usingSupabase()) {
        setNotice('The database is unavailable. You can still browse the catalogue.');
        setOffline(backendReason() || 'No database is connected.');
        setReady(true);
        return;
      }
      /* Already signed in? Say so rather than showing a form that would
         quietly sign them in again as somebody else. */
      const role = await supabase().myRole().catch(() => 'guest');
      if (!alive) return;
      if (role === 'buyer') {
        const target = next || '/account';
        saveAuthIntent(target);
        setNotice('Welcome back. Redirecting to your account…');
        router.replace(target);
        return;
      }
      if (role === 'owner' || role === 'pending') { setNotice('Opening your store portal…'); router.replace('/portal'); return; }
      if (role === 'admin') { setNotice('Opening the platform console…'); router.replace('/admin'); return; }
      setTowns(await supabase().listMunicipalities().catch(() => []));
      if (alive) {
        setNotice('');
        setReady(true);
      }
    })();
    return () => { alive = false; };
  }, [router, next]);

  const choose = useCallback(value => {
    const query = new URLSearchParams();
    query.set('as', value);
    if (next) query.set('next', next);
    router.push(`/login?${query}`);
  }, [router, next]);

  async function handleSignIn(event) {
    event.preventDefault();
    const values = Object.fromEntries(new FormData(event.currentTarget));
    setError('');
    setNotice('Signing you in…');
    setBusy(true);
    try {
      await supabase().signIn({
        email: String(values.email), password: String(values.password)
      });
      /* Ask the server what this account actually is rather than assuming the
         button they pressed. Someone who runs a store and clicked "I'm
         shopping" should land in their portal, not in a shopper's account
         page that has nothing in it. */
      const role = await supabase().myRole();
      if (role === 'admin') router.push('/admin');
      else if (role === 'owner' || role === 'pending') router.push('/portal');
      else {
        const target = next || consumeAuthIntent() || '/account';
        saveAuthIntent(target);
        router.push(target);
      }
    } catch (signInError) {
      setNotice('Sign-in failed. Please check your email and password.');
      setError(signInError.message);
      setBusy(false);
    }
  }

  async function handleSignUp(event) {
    event.preventDefault();
    const values = Object.fromEntries(new FormData(event.currentTarget));
    setError('');
    setNotice('Creating your account…');
    setBusy(true);
    try {
      const result = await supabase().signUpBuyer({
        email: String(values.email),
        password: String(values.password),
        fullName: String(values.fullName).trim(),
        municipality: String(values.municipality)
      });
      if (result.needsEmailConfirmation) {
        setNotice('Account created. Check your email to confirm it.');
        setSent(String(values.email));
      } else {
        const target = next || consumeAuthIntent() || '/account';
        saveAuthIntent(target);
        setNotice('Account created. Redirecting to your planner…');
        router.push(target);
      }
    } catch (signUpError) {
      setNotice('Account creation was interrupted. Please try again.');
      setError(signUpError.message);
    } finally {
      setBusy(false);
    }
  }

  if (!ready) return <p className="card-copy">One moment…</p>;

  if (offline) {
    return (
      <div className="login-panel">
        <div className="login-copy">
          <span className="secure-mark" aria-hidden="true">⌑</span>
          <h1>Accounts need the database.</h1>
          <p>Signing in and signing up both live in Supabase; without it there is nothing to sign in to.</p>
          <p className="demo-note">{offline}</p>
          <p className="demo-note">
            You can still <Link href="/collection">browse the catalogue</Link>.
          </p>
        </div>
      </div>
    );
  }

  /* ---------------------------------------------------- the question ---- */
  if (as !== 'buyer') {
    return (
      <div className="role-choice">
        <div className="login-copy">
          <span className="secure-mark" aria-hidden="true">⌑</span>
          <h1 id="login-title">Who is signing in?</h1>
          <p>
            FurnishAR has two sides: shoppers who want to see furniture in their own
            room, and the Mamburao shops who list it.
          </p>
        </div>

        <div className="role-cards">
          <button type="button" className="role-card" onClick={() => choose('buyer')}>
            <span className="role-card-mark" aria-hidden="true">⌂</span>
            <b>I&rsquo;m shopping for furniture</b>
            <span>
              Measure your room and stand a real piece of furniture in it before you buy.
              Free, and you need an account to use the planner.
            </span>
            <span className="role-card-go" aria-hidden="true">Continue →</span>
          </button>

          {/* A link, not a second copy of the store form. The portal already
              signs owners in and takes applications from new shops; two
              copies of that would drift apart. */}
          <Link className="role-card" href="/portal">
            <span className="role-card-mark" aria-hidden="true">⌗</span>
            <b>I run a furniture store</b>
            <span>
              Sign in to your store portal to list furniture, upload 3D models and
              manage stock. New shops can apply from there.
            </span>
            <span className="role-card-go" aria-hidden="true">Store portal →</span>
          </Link>
        </div>

        <p className="role-foot">
          Just looking? <Link href="/collection">Browse the catalogue</Link> — no account needed.
        </p>
      </div>
    );
  }

  /* ------------------------------------------------- the shopper form ---- */
  if (sent) {
    return (
      <div className="login-panel">
        {notice && <div className="status-banner" role="status" aria-live="polite"><span className="loading-spinner" aria-hidden="true" />{notice}</div>}
        <div className="login-copy">
          <span className="secure-mark" aria-hidden="true">⌑</span>
          <h1>Check your email.</h1>
          <p>
            We sent a confirmation link to <b>{sent}</b>. Open it and your account is
            ready — then come back and sign in.
          </p>
          <p className="demo-note">
            Nothing arrived? It is worth checking the spam folder; the message comes
            from Supabase rather than from FurnishAR.
          </p>
        </div>
        <div className="panel-actions">
          <button className="button button-primary" type="button"
            onClick={() => { setSent(''); setMode('signin'); }}>
            Back to sign in
          </button>
        </div>
      </div>
    );
  }

  return (
    <div className="login-panel">
      {notice && <div className="status-banner" role="status" aria-live="polite"><span className="loading-spinner" aria-hidden="true" />{notice}</div>}
      <div className="login-copy">
        <span className="secure-mark" aria-hidden="true">⌑</span>
        <h1 id="login-title">{mode === 'signin' ? 'Welcome back' : 'Create your account'}</h1>
        <p>
          {mode === 'signin'
            ? 'Sign in to measure your space and place furniture in it.'
            : 'An account lets you measure your room and stand furniture in it. That is all it is for.'}
        </p>
        <p className="demo-note">
          Run a shop instead? That is the <Link href="/portal">store portal</Link>.{' '}
          <button type="button" className="text-button" onClick={() => choose('')} aria-label="Return to the shopper role chooser">
            Not a shopper?
          </button>
        </p>
      </div>

      <div className="mode-switch" role="tablist" aria-label="Sign in or create an account">
        <button type="button" role="tab" id="signin-tab" aria-controls="login-form" aria-selected={mode === 'signin'}
          className={`mode-option${mode === 'signin' ? ' is-active' : ''}`}
          onClick={() => { setMode('signin'); setError(''); }}>
          Sign in
        </button>
        <button type="button" role="tab" id="signup-tab" aria-controls="login-form" aria-selected={mode === 'signup'}
          className={`mode-option${mode === 'signup' ? ' is-active' : ''}`}
          onClick={() => { setMode('signup'); setError(''); }}>
          Create account
        </button>
      </div>

      {mode === 'signin' ? (
        <form id="login-form" className="login-form" onSubmit={handleSignIn}>
          <label>
            Email
            <input name="email" type="email" required autoComplete="email"
              aria-invalid={error ? 'true' : undefined} />
          </label>
          <PasswordField autoComplete="current-password" />
          <button className="button button-primary" type="submit" disabled={busy}>
            {busy ? 'Signing in…' : <>Sign in <span aria-hidden="true">→</span></>}
          </button>
          <p className="form-error" role="alert" aria-live="assertive">{error}</p>
        </form>
      ) : (
        <form id="login-form" className="login-form" onSubmit={handleSignUp}>
          <label>
            Your name
            <input name="fullName" type="text" required minLength={2} maxLength={80}
              autoComplete="name" />
          </label>
          <label>
            Email
            <input name="email" type="email" required autoComplete="email"
              aria-invalid={error ? 'true' : undefined} />
          </label>
          {/*
              Read from the database, not hard-coded here. The column has a
              foreign key to the same list, so a hard-coded copy that drifted
              would offer a town the database then refuses — an error at the
              last step of sign-up, about a field the person picked from a
              menu we gave them.
          */}
          <label>
            Municipality
            <select name="municipality" required defaultValue="">
              <option value="" disabled>Where in Occidental Mindoro?</option>
              {towns.map(town => <option key={town} value={town}>{town}</option>)}
            </select>
          </label>
          <PasswordField autoComplete="new-password" />
          <button className="button button-primary" type="submit" disabled={busy || !towns.length}>
            {busy ? 'Creating…' : <>Create account <span aria-hidden="true">→</span></>}
          </button>
          {!towns.length && (
            <p className="form-error" role="status">
              The municipality list did not load, so sign-up is held rather than
              creating an account with nowhere attached to it.
            </p>
          )}
          <p className="form-error" role="alert" aria-live="assertive">{error}</p>
        </form>
      )}
    </div>
  );
}
