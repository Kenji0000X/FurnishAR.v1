'use client';

import { useCallback, useEffect, useState } from 'react';
import { initBackend, usingSupabase, supabase, backendReason, api, demoSession } from './backend.js';
import Link from 'next/link';
import ProductFormDialog from './ProductFormDialog.js';
import { peso } from '../format.js';

const FREEMIUM_LIMIT = 8;

const PLANS = [
  {
    id: 'freemium',
    name: 'Freemium',
    price: 'Free',
    cadence: 'no card, no expiry',
    features: [
      'Up to 8 published products',
      'AR placement and room measurement',
      '3D model upload, 50 MB per file',
      'Store profile in every listing'
    ]
  },
  {
    id: 'premium',
    name: 'Premium',
    price: '₱499',
    cadence: 'per store, per month',
    features: [
      'Unlimited products',
      'Featured placement at the top of the catalog',
      'Everything in Freemium'
    ]
  }
];

function relativeTime(isoString) {
  if (!isoString) return '—';
  const then = new Date(isoString).getTime();
  if (Number.isNaN(then)) return '—';
  const seconds = Math.round((then - Date.now()) / 1000);
  const units = [
    ['year', 31536000], ['month', 2592000], ['day', 86400],
    ['hour', 3600], ['minute', 60]
  ];
  const formatter = new Intl.RelativeTimeFormat('en', { numeric: 'auto' });
  for (const [unit, size] of units) {
    if (Math.abs(seconds) >= size) return formatter.format(Math.round(seconds / size), unit);
  }
  return formatter.format(seconds, 'second');
}

/* ------------------------------------------------------------------ panels -- */

function PlanPanel({ plan, used }) {
  return (
    <div className="plan-panel">
      {PLANS.map(entry => {
        const isCurrent = entry.id === plan;
        return (
          <article key={entry.id} className={`plan-card${isCurrent ? ' is-current' : ''}`}>
            <p className="eyebrow">{entry.name}{isCurrent ? ' · current' : ''}</p>
            <p className="plan-price">{entry.price}</p>
            <p className="plan-cadence">{entry.cadence}</p>
            {entry.id === 'freemium' && isCurrent && (
              <p className="plan-usage">{used} of {FREEMIUM_LIMIT} products used</p>
            )}
            <ul className="plan-features">
              {entry.features.map(feature => <li key={feature}>{feature}</li>)}
            </ul>
            {isCurrent
              ? <p className="plan-note">Your current plan.</p>
              : (
                <a className="button button-outline" href="mailto:hello@furnishar.ph?subject=FurnishAR%20Premium">
                  Ask about {entry.name}
                </a>
              )}
          </article>
        );
      })}
    </div>
  );
}

/** Label for a submit button that may be busy or held shut by a rate limit. */
function submitLabel({ busy, cooldown, busyText, idle }) {
  if (cooldown > 0) return `Try again in ${cooldown}s`;
  return busy ? busyText : idle;
}

function LoginPanel({ onSubmit, error, busy, cooldown, onShowSignup }) {
  return (
    <div className="login-panel">
      <div className="login-copy">
        <span className="secure-mark" aria-hidden="true">⌑</span>
        <h2>Sign in to your store.</h2>
        <p>Keep your listings accurate so shoppers only see what you actually have.</p>
      </div>
      <form className="login-form" onSubmit={onSubmit}>
        <label>
          Email
          <input
            name="email"
            type="email"
            required
            autoComplete="email"
            defaultValue="owner@furnishar.ph"
            aria-invalid={error ? 'true' : undefined}
          />
        </label>
        <label>
          Password
          <input name="password" type="password" required autoComplete="current-password" defaultValue="furnishar" />
        </label>
        <button className="button button-primary" type="submit" disabled={busy || cooldown > 0}>
          {cooldown > 0 || busy
            ? submitLabel({ busy, cooldown, busyText: 'Signing in…' })
            : <>Sign in securely <span aria-hidden="true">→</span></>}
        </button>
        <p className="form-error" role="alert" aria-live="assertive">{error}</p>
        <button className="text-button" type="button" onClick={onShowSignup}>New store? Sign up</button>
      </form>
    </div>
  );
}

function SignupPanel({ onSubmit, message, busy, cooldown, onShowLogin }) {
  return (
    <div className="login-panel">
      <div className="login-copy">
        <span className="secure-mark" aria-hidden="true">⌑</span>
        <h2>List your store on FurnishAR.</h2>
        <p>Tell us about your shop. We check every application by hand so the catalog stays accurate.</p>
      </div>
      <form className="login-form" onSubmit={onSubmit}>
        <label>Store name<input name="storeName" type="text" required autoComplete="organization" maxLength={120} /></label>
        <label>Contact email<input name="email" type="email" required autoComplete="email" /></label>
        <label>Password<input name="password" type="password" required autoComplete="new-password" minLength={8} /></label>
        <label>Contact number<input name="phone" type="tel" required autoComplete="tel" inputMode="tel" /></label>
        <label>
          What will you list?
          <textarea name="message" rows={2} maxLength={1000} placeholder="e.g. 40 pieces, mostly cabinets and dining sets" />
        </label>
        <button className="button button-primary" type="submit" disabled={busy || cooldown > 0}>
          {cooldown > 0 || busy
            ? submitLabel({ busy, cooldown, busyText: 'Creating…' })
            : <>Create account <span aria-hidden="true">→</span></>}
        </button>
        <p className={`form-error${message?.ok ? ' is-ok' : ''}`} role="status" aria-live="polite">
          {message?.text}
        </p>
        <button className="text-button" type="button" onClick={onShowLogin}>Back to login</button>
      </form>
    </div>
  );
}

function PendingPanel({ email, onLogout }) {
  return (
    <div className="login-panel">
      <div className="login-copy">
        <span className="secure-mark" aria-hidden="true">⌑</span>
        <h2>Your store is in review.</h2>
        <p>
          The account for <b>{email}</b> is active, but it is not linked to a store yet. We check
          new applications by hand so the catalog stays accurate.
        </p>
        <p className="demo-note">
          You will be able to add furniture and upload 3D models as soon as it is approved.
        </p>
      </div>
      <div className="login-form">
        <p className="card-copy">Nothing to do here for now. Sign out and come back once you hear from us.</p>
        <button className="button button-outline" type="button" onClick={onLogout}>Sign out</button>
      </div>
    </div>
  );
}

/* ----------------------------------------------------------------- portal -- */

export default function Portal({ initialProducts }) {
  const [ready, setReady] = useState(false);
  const [mode, setMode] = useState('login');       // 'login' | 'signup'
  const [session, setSession] = useState(null);    // { token, user }
  const [ownProducts, setOwnProducts] = useState([]);
  const [busy, setBusy] = useState(false);
  const [loginError, setLoginError] = useState('');
  const [signupMessage, setSignupMessage] = useState(null);
  const [editing, setEditing] = useState(undefined); // undefined = closed
  const [notice, setNotice] = useState('');
  const [cooldown, setCooldown] = useState(0);       // seconds left after a 429
  // Whether to show a way through to the platform console. The server answers
  // this; it decides what to render and grants nothing on its own.
  const [isAdmin, setIsAdmin] = useState(false);

  // Counts the rate-limit wait down so the button can say how long is left
  // rather than just refusing.
  useEffect(() => {
    if (cooldown <= 0) return undefined;
    const timer = setTimeout(() => setCooldown(seconds => seconds - 1), 1000);
    return () => clearTimeout(timer);
  }, [cooldown]);

  const startCooldown = seconds => setCooldown(Math.min(Math.ceil(seconds), 3600));

  const toast = message => {
    setNotice(message);
    setTimeout(() => setNotice(''), 3400);
  };

  /** Reads whichever session exists and loads the store's own inventory. */
  const refreshSession = useCallback(async () => {
    if (usingSupabase()) {
      const sb = supabase();
      const current = await sb.getSession();
      if (!current) {
        setSession(null);
        setOwnProducts([]);
        return;
      }
      const membership = await sb.getMembership();
      setSession({
        token: current.access_token,
        user: membership
          ? {
              email: current.user.email,
              storeId: membership.storeId,
              storeUuid: membership.storeUuid,
              store: membership.store,
              plan: membership.plan
            }
          : { email: current.user.email, storeId: null, storeUuid: null, store: null, plan: null }
      });
      if (membership) {
        try {
          setOwnProducts(await sb.listOwnProducts(membership.storeUuid));
        } catch (error) {
          console.warn('Could not load store inventory:', error.message);
        }
      }
      return;
    }

    const stored = demoSession.read();
    setSession(stored.token && stored.user ? stored : null);
  }, []);

  useEffect(() => {
    let active = true;
    (async () => {
      await initBackend();
      if (!active) return;
      await refreshSession();
      if (!active) return;
      setReady(true);

      // Follow sign-ins and sign-outs made in another tab.
      if (usingSupabase()) {
        supabase().onAuthChange(event => {
          if (['SIGNED_IN', 'SIGNED_OUT', 'TOKEN_REFRESHED'].includes(event)) refreshSession();
        });
        supabase().isPlatformAdmin().then(admin => { if (active) setIsAdmin(admin); });
      }
    })();
    return () => { active = false; };
  }, [refreshSession]);

  async function handleLogin(event) {
    event.preventDefault();
    const form = event.currentTarget;            // captured before any await
    const fields = Object.fromEntries(new FormData(form));
    setLoginError('');
    setBusy(true);
    try {
      if (usingSupabase()) {
        await supabase().signIn({ email: fields.email, password: fields.password });
        await refreshSession();
      } else {
        const response = await api('/api/auth/login', {
          method: 'POST',
          body: JSON.stringify(fields)
        });
        demoSession.write(response.token, response.user);
        setSession({ token: response.token, user: response.user });
      }
      form.reset();
      toast('Signed in.');
    } catch (error) {
      setLoginError(error.message);
      // Sign-in is rate-limited by Supabase too, and had exactly the same
      // "[object Object]" problem on an empty error body.
      if (error.retryAfter) startCooldown(error.retryAfter);
      form.querySelector('[name="email"]')?.focus();
    } finally {
      setBusy(false);
    }
  }

  async function handleSignup(event) {
    event.preventDefault();
    const form = event.currentTarget;
    const fields = Object.fromEntries(new FormData(form));
    setSignupMessage(null);

    // Only the fallback. When the database is reachable, sign-up creates a real
    // account below; this branch is for when it is not, and it says which,
    // because "not configured" and "configured but unreachable" need different
    // responses from whoever runs the site.
    if (!usingSupabase()) {
      const why = backendReason();
      setSignupMessage({
        ok: false,
        text: "Online store applications are temporarily unavailable because the catalogue database is not connected. Email hello@furnishar.ph and we can add your store manually."
          + (why ? ` (${why})` : '')
      });
      return;
    }

    setBusy(true);
    try {
      const result = await supabase().signUp({
        email: fields.email,
        password: fields.password,
        storeName: fields.storeName,
        phone: fields.phone,
        message: fields.message
      });
      form.reset();

      const confirm = result.needsEmailConfirmation
        ? 'Account created. Confirm your email address, then sign in'
        : 'Account created. You can sign in now';
      setSignupMessage({
        ok: true,
        text: result.applicationFiled
          ? `${confirm} — your store is queued for review.`
          : `${confirm}. We could not file your store application automatically, so email hello@furnishar.ph with your store name and we will add it by hand. Do not sign up again; the account already exists.`
      });
      toast('Application received.');
    } catch (error) {
      setSignupMessage({ ok: false, text: error.message });
      // Supabase rate-limits sign-ups hard. Holding the button shut for the
      // stated interval is the difference between one 429 and four.
      if (error.retryAfter) startCooldown(error.retryAfter);
    } finally {
      setBusy(false);
    }
  }

  async function handleLogout() {
    if (usingSupabase()) await supabase().signOut();
    else demoSession.clear();
    setSession(null);
    setOwnProducts([]);
    toast('Signed out.');
  }

  async function handleDelete(product) {
    if (!window.confirm(`Delete "${product.name}"? This cannot be undone.`)) return;
    try {
      if (usingSupabase()) await supabase().deleteProduct(product.id);
      else await api(`/api/products/${product.id}`, { method: 'DELETE', token: session.token });
      await reloadInventory();
      toast('Product deleted.');
    } catch (error) {
      toast(error.message);
    }
  }

  const reloadInventory = useCallback(async () => {
    if (usingSupabase()) {
      if (!session?.user?.storeUuid) return;
      setOwnProducts(await supabase().listOwnProducts(session.user.storeUuid));
    } else {
      const data = await api('/api/products');
      setOwnProducts(data.products.filter(p => p.storeId === session?.user?.storeId));
    }
  }, [session]);

  // The demo backend has no per-store endpoint, so the owner's list is filtered
  // out of the catalogue that was server-rendered with the page.
  useEffect(() => {
    if (ready && !usingSupabase() && session?.user) {
      setOwnProducts(initialProducts.filter(p => p.storeId === session.user.storeId));
    }
  }, [ready, session, initialProducts]);

  if (!ready) {
    return <p className="card-copy">Loading the portal…</p>;
  }

  const user = session?.user;
  const loggedIn = Boolean(session?.token && user);
  const awaitingApproval = loggedIn && usingSupabase() && !user.storeUuid;

  if (!loggedIn) {
    return mode === 'signup'
      ? (
        <SignupPanel
          onSubmit={handleSignup}
          message={signupMessage}
          busy={busy}
          cooldown={cooldown}
          onShowLogin={() => { setMode('login'); setSignupMessage(null); }}
        />
      )
      : (
        <LoginPanel
          onSubmit={handleLogin}
          error={loginError}
          busy={busy}
          cooldown={cooldown}
          onShowSignup={() => { setMode('signup'); setLoginError(''); }}
        />
      );
  }

  if (awaitingApproval) {
    return <PendingPanel email={user.email} onLogout={handleLogout} />;
  }

  const plan = usingSupabase()
    ? (user.plan === 'premium' ? 'premium' : 'freemium')
    : (ownProducts.length > 0 ? 'premium' : 'freemium');
  const isFree = plan === 'freemium';
  const units = ownProducts.reduce((sum, product) => sum + product.stock, 0);
  const value = ownProducts.reduce((sum, product) => sum + product.price * product.stock, 0);

  return (
    <section className="dashboard">
      <div className="dashboard-top">
        <div>
          <p className="eyebrow">{user.store}</p>
          <h2>Welcome back</h2>
        </div>
        <div>
          {isAdmin && (
            <Link className="button button-outline" href="/admin">Platform console</Link>
          )}
          <button className="button button-primary" type="button" onClick={() => setEditing(null)}>
            + Add product
          </button>
          <button className="button button-outline" type="button" onClick={handleLogout}>Sign out</button>
        </div>
      </div>

      <div className="inventory-summary">
        <div className="inventory-stat"><span>Plan</span><strong>{isFree ? 'Freemium' : 'Premium'}</strong></div>
        <div className="inventory-stat">
          <span>Listed products</span>
          <strong>{ownProducts.length}{isFree ? `/${FREEMIUM_LIMIT}` : ''}</strong>
        </div>
        <div className="inventory-stat"><span>Units available</span><strong>{units}</strong></div>
        <div className="inventory-stat"><span>Catalog value</span><strong>{peso(value)}</strong></div>
      </div>

      <section className="plan-section" aria-labelledby="plan-title">
        <div className="section-heading">
          <div><p className="eyebrow">Subscription</p><h2 id="plan-title">Your plan</h2></div>
        </div>
        <PlanPanel plan={plan} used={ownProducts.length} />
      </section>

      <div className="inventory-table-wrap">
        <table>
          <thead>
            <tr>
              <th>Product</th><th>Dimensions</th><th>Price</th><th>In stock</th>
              <th>Updated</th><th><span className="sr-only">Actions</span></th>
            </tr>
          </thead>
          <tbody>
            {ownProducts.length ? ownProducts.map(product => (
              <tr key={product.id}>
                <td>
                  {product.name}
                  <small>
                    {product.category} · {product.color}{product.modelGlb ? ' · 3D model' : ''}
                  </small>
                </td>
                <td>
                  {product.dimensions.width} × {product.dimensions.depth} × {product.dimensions.height} cm
                </td>
                <td>{peso(product.price)}</td>
                <td>{product.stock}</td>
                <td><small>{relativeTime(product.updatedAt)}</small></td>
                <td>
                  <div className="table-actions">
                    <button className="icon-button" type="button" onClick={() => setEditing(product)}>Edit</button>
                    <button className="icon-button delete" type="button" onClick={() => handleDelete(product)}>
                      Delete
                    </button>
                  </div>
                </td>
              </tr>
            )) : (
              <tr><td colSpan={6}>No products listed yet. Add your first product above.</td></tr>
            )}
          </tbody>
        </table>
      </div>

      {editing !== undefined && (
        <ProductFormDialog
          product={editing}
          session={session}
          onClose={() => setEditing(undefined)}
          onSaved={async message => {
            setEditing(undefined);
            await reloadInventory().catch(() => {});
            toast(message);
          }}
        />
      )}

      {notice && <div className="toast show" role="status" aria-live="polite">{notice}</div>}
    </section>
  );
}
