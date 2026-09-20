'use client';

import { useCallback, useEffect, useState } from 'react';
import { initBackend, usingSupabase, supabase, backendReason, api, demoSession } from './backend.js';
import Link from 'next/link';
import ProductFormDialog from './ProductFormDialog.js';
import PasswordField from '../PasswordField.js';
import ConfirmDialog from '../ConfirmDialog.js';
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
            aria-invalid={error ? 'true' : undefined}
          />
        </label>
        {/* This used to carry defaultValue="furnishar" — the demo account's
            password, prefilled on the live sign-in form for every visitor. */}
        <PasswordField autoComplete="current-password" />
        <button className="button button-primary" type="submit" disabled={busy || cooldown > 0}>
          {cooldown > 0 || busy
            ? submitLabel({ busy, cooldown, busyText: 'Signing in…' })
            : <>Sign in securely <span aria-hidden="true">→</span></>}
        </button>
        <p className="form-error" role="alert" aria-live="assertive">{error}</p>
        <button className="text-button" type="button" onClick={onShowSignup}>New store? Sign up</button>
      </form>

      {/* The single way in to the platform console.
          Showing it to everyone gives nothing away: /admin refuses anyone who
          is not in platform_admins, and row level security means the server
          never sends them an applicant's details in the first place. A link
          nobody can see is not a permission — the database is what says no. */}
      <p className="superadmin-entry">
        <Link href="/admin">Superadmin sign-in <span aria-hidden="true">→</span></Link>
      </p>
    </div>
  );
}

/**
 * Shown after a successful sign-up that still needs email confirmation.
 *
 * This is the other half of fixing "approve does nothing": most stuck
 * applications are stuck here, at the very first step, because the one
 * confirmation email Supabase sends landed in spam or was never seen. Giving
 * the applicant a way to ask for it again, right where they are told they
 * need it, is cheaper than an admin ever finding out later that this is why
 * an approval keeps failing.
 */
function ResendSignupConfirmation({ email }) {
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

  if (state === 'sent') return <p className="form-note" role="status">Sent to {email} — check spam too.</p>;
  return (
    <p className="form-note">
      Didn&apos;t get it?{' '}
      <button className="text-button" type="button" onClick={resend} disabled={state === 'sending'}>
        {state === 'sending' ? 'Sending…' : 'Resend the confirmation email'}
      </button>
      {state === 'error' && ' — could not send it, try again shortly.'}
    </p>
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
        <PasswordField autoComplete="new-password" minLength={8} />
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
        {message?.ok && message.needsEmailConfirmation && message.email && (
          <ResendSignupConfirmation email={message.email} />
        )}
        <button className="text-button" type="button" onClick={onShowLogin}>Back to login</button>
      </form>
    </div>
  );
}

/**
 * Signed in, but linked to no store.
 *
 * For an applicant that means "we are still checking you". For the platform
 * operator it means nothing is wrong at all: an admin deliberately never
 * becomes a member of anybody's shop, so they land here every time. Showing
 * them "your store is in review" was a dead end — their console was rendered
 * further down a branch this panel returns before reaching.
 */
function PendingPanel({ email, onLogout, isAdmin }) {
  if (isAdmin) {
    return (
      <div className="login-panel">
        <div className="login-copy">
          <span className="secure-mark" aria-hidden="true">⌑</span>
          <h2>You are the platform operator.</h2>
          <p>
            <b>{email}</b> runs no shop of its own — that is on purpose. Approving a store
            makes somebody else its owner; it never makes you one.
          </p>
          <p className="demo-note">
            Review sign-ups, watch what is being uploaded, and see every decision on record.
          </p>
        </div>
        <div className="login-form">
          <Link className="button button-primary" href="/admin">
            Open the platform console <span aria-hidden="true">→</span>
          </Link>
          <button className="button button-outline" type="button" onClick={onLogout}>Sign out</button>
        </div>
      </div>
    );
  }

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
  const [pendingDelete, setPendingDelete] = useState(null); // product awaiting confirmation
  const [notice, setNotice] = useState('');
  const [cooldown, setCooldown] = useState(0);       // seconds left after a 429
  // Whether to show a way through to the platform console. The server answers
  // this; it decides what to render and grants nothing on its own.
  const [isAdmin, setIsAdmin] = useState(false);

  // Applying had no address of its own: it was a button on the login panel and
  // nothing else, so the footer, a poster or a message to a shop owner could
  // only ever point at "the portal, then find the link". /portal#apply opens
  // it directly.
  //
  // Read after mount rather than during render, because the hash is not part
  // of what the server sees — deciding the first render from it is the classic
  // hydration mismatch.
  useEffect(() => {
    if (window.location.hash !== '#apply') return;
    setMode('signup');
    // And put the person where they asked to go. The panel renders on the
    // next tick, so the focus move waits for it.
    const move = requestAnimationFrame(() => {
      document.getElementById('apply')?.focus({ preventScroll: false });
    });
    return () => cancelAnimationFrame(move);
  }, []);

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
        setIsAdmin(false);
        return;
      }
      const membership = await sb.getMembership();

      // Asked here, not once at page load: at load the visitor is usually
      // signed out, and isPlatformAdmin() answers false for anyone without a
      // session. Checking it only then meant an operator never saw their own
      // console until they reloaded the page by hand.
      setIsAdmin(await sb.isPlatformAdmin());

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

      // Carried on the message so the panel can offer a resend for exactly
      // the account that might need it, not a generic "resend something".
      const email = fields.email;

      const confirm = result.needsEmailConfirmation
        ? 'Account created. Confirm your email address, then sign in'
        : 'Account created. You can sign in now';
      setSignupMessage({
        ok: true,
        text: result.applicationFiled
          ? `${confirm} — your store is queued for review.`
          : `${confirm}. We could not file your store application automatically, so email hello@furnishar.ph with your store name and we will add it by hand. Do not sign up again; the account already exists.`,
        email,
        needsEmailConfirmation: result.needsEmailConfirmation
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

  /** Opens the confirmation. The deletion itself happens in performDelete. */
  function handleDelete(product) {
    setPendingDelete(product);
  }

  async function performDelete(product) {
    setPendingDelete(null);
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
  // A platform admin must never see a store's dashboard here, whatever the
  // membership data says. The design has always assumed an admin account is
  // never a store_members row for any shop — see PendingPanel below, "an
  // admin deliberately never becomes a member of anybody's shop" — but that
  // was only ever an assumption about the DATA, never something this branch
  // actually checked. The branch below decided purely on `!user.storeUuid`,
  // so an admin account that also happened to carry a real membership (from
  // testing, from signing up before being promoted, from anything) fell
  // straight through into that OTHER store's dashboard instead of the
  // operator view — the exact bug reported: sign in as the superadmin,
  // click "Store portal", and land on someone else's shop.
  //
  // `isAdmin` now takes priority over whatever storeUuid says, so this is
  // guaranteed by the branch itself rather than by hoping the membership
  // table never disagrees with the design.
  const awaitingApproval = loggedIn && usingSupabase() && (isAdmin || !user.storeUuid);

  if (!loggedIn) {
    /*
       id="apply" is the target of /portal#apply, linked from the footer of
       every page. It sits on this wrapper rather than on the signup panel
       because the panel only exists once the mode has switched — so the id
       was absent at exactly the moment the browser looked for it, leaving the
       hash pointing at nothing: no scroll, and nobody arriving by keyboard or
       screen reader moved to the form they had just asked for.

       tabIndex={-1} makes it a focus target without putting it in the tab
       order, which is the standard way to land somebody on a region.
    */
    return (
      <div id="apply" tabIndex={-1}>
        {mode === 'signup' ? (
          <SignupPanel
            onSubmit={handleSignup}
            message={signupMessage}
            busy={busy}
            cooldown={cooldown}
            onShowLogin={() => { setMode('login'); setSignupMessage(null); }}
          />
        ) : (
          <LoginPanel
            onSubmit={handleLogin}
            error={loginError}
            busy={busy}
            cooldown={cooldown}
            onShowSignup={() => { setMode('signup'); setLoginError(''); }}
          />
        )}
      </div>
    );
  }

  if (awaitingApproval) {
    return <PendingPanel email={user.email} onLogout={handleLogout} isAdmin={isAdmin} />;
  }

  const plan = usingSupabase()
    ? (user.plan === 'premium' ? 'premium' : 'freemium')
    : (ownProducts.length > 0 ? 'premium' : 'freemium');
  const isFree = plan === 'freemium';
  const units = ownProducts.reduce((sum, product) => sum + product.stock, 0);
  const value = ownProducts.reduce((sum, product) => sum + product.price * product.stock, 0);
  /*
    How many listings a shopper can actually stand in their room.

    This is the shop's most actionable number and it was nowhere on the
    dashboard: a store could list ten pieces, have models for two, and see a
    confident "10 listed products" with no hint that eight of them cannot do
    the one thing this platform is for. The per-row note said so, but only if
    you read every row.
  */
  const placeable = ownProducts.filter(product => product.modelGlb).length;
  const missingModels = ownProducts.length - placeable;

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
        <div className="inventory-stat">
          <span>Can be placed in AR</span>
          <strong>{placeable}<small>/{ownProducts.length}</small></strong>
        </div>
        <div className="inventory-stat"><span>Units available</span><strong>{units}</strong></div>
        <div className="inventory-stat"><span>Catalog value</span><strong>{peso(value)}</strong></div>
      </div>

      {/* Said once, plainly, with the number — rather than leaving it to be
          inferred from reading every row of the table. */}
      {missingModels > 0 && (
        <p className="dashboard-nudge">
          <b>{missingModels} {missingModels === 1 ? 'listing has' : 'listings have'} no 3D model.</b>
          {' '}Shoppers can see {missingModels === 1 ? 'it' : 'them'} and read the
          measurements, but cannot place {missingModels === 1 ? 'it' : 'them'} in
          their room. Add a <code>.glb</code> from Edit to change that.
        </p>
      )}

      <section className="plan-section" aria-labelledby="plan-title">
        <div className="section-heading">
          <div><p className="eyebrow">Subscription</p><h2 id="plan-title">Your plan</h2></div>
        </div>
        <PlanPanel plan={plan} used={ownProducts.length} />
      </section>

      <div className="inventory-table-wrap">
        <table role="table">
          <thead>
            <tr>
              <th>Product</th><th>Dimensions</th><th>Price</th><th>In stock</th>
              <th>Updated</th><th><span className="sr-only">Actions</span></th>
            </tr>
          </thead>
          <tbody>
            {ownProducts.length ? ownProducts.map(product => (
              <tr key={product.id} role="row">
                <td data-label="Product">
                  <div className="inventory-product">
                    {/* Their own render, so a shop can tell their listings
                        apart at a glance rather than by reading names. */}
                    {product.thumbnail ? (
                      <img
                        className="inventory-thumb"
                        src={product.thumbnail}
                        alt=""
                        width="48"
                        height="48"
                        loading="lazy"
                      />
                    ) : (
                      <span className="inventory-thumb inventory-thumb-empty" aria-hidden="true">⬚</span>
                    )}
                    <span>
                      {product.name}
                      <small>
                        {product.category} · {product.color}
                        {product.modelGlb
                          ? ' · 3D model'
                          : <span className="missing-model"> · no 3D model — will not show in AR</span>}
                      </small>
                    </span>
                  </div>
                </td>
                <td data-label="Dimensions">
                  {product.dimensions.width} × {product.dimensions.depth} × {product.dimensions.height} cm
                </td>
                <td data-label="Price">{peso(product.price)}</td>
                <td data-label="In stock">{product.stock}</td>
                <td data-label="Updated"><small>{relativeTime(product.updatedAt)}</small></td>
                <td data-label="Actions">
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

      {pendingDelete && (
        <ConfirmDialog
          title="Delete this product?"
          body={`"${pendingDelete.name}" will be removed from your catalog and from any
                 shopper's saved plan. This cannot be undone.`}
          confirmLabel="Delete product"
          onConfirm={() => performDelete(pendingDelete)}
          onCancel={() => setPendingDelete(null)}
        />
      )}

      {notice && <div className="toast show" role="status" aria-live="polite">{notice}</div>}
    </section>
  );
}
