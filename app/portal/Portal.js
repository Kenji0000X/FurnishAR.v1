'use client';

import { useCallback, useEffect, useState } from 'react';
import { initBackend, usingSupabase, supabase, backendReason, backendConfigured, api, demoSession } from './backend.js';
import Link from 'next/link';
import ProductFormDialog from './ProductFormDialog.js';
import PasswordField from '../PasswordField.js';
import GoogleButton from '../GoogleButton.js';
import { oauthAlert } from '../../lib/role-routes.mjs';
import PaymentSetupReminder from '../billing/PaymentSetupReminder.js';
import useAlert from '../alerts/useAlert.js';
import ConfirmDialog from '../ConfirmDialog.js';
import { formatDimensions } from '../../lib/spatial/units.mjs';
import { SquaresFour, Package, ShoppingBag, Receipt, Crown, Plus, ArrowRight, ArrowUpRight, CheckCircle } from '@phosphor-icons/react/dist/ssr';
import ConsoleShell, { ConsoleHeader, ConsoleSection, ConsoleCta } from '../console/ConsoleShell.js';

/* One currency format across the portal: pesos with centavos, as orders and fees show them. */
const money = value => `₱${Number(value || 0).toLocaleString('en-PH', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
import StoreOrders from '../billing/StoreOrders.js';

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
      '3D model upload, up to 40 MB per file',
      'Store profile in every listing'
    ]
  },
  {
    id: 'premium',
    name: 'Premium',
    price: '₱499.00',
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
            <p className="eyebrow">{entry.name}{isCurrent ? ' · Current' : ''}</p>
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
                <a className="button button-outline" href={`mailto:hello@furnishar.ph?subject=${encodeURIComponent(`FurnishAR ${entry.name}`)}`}>
                  Ask About {entry.name}
                </a>
              )}
          </article>
        );
      })}
    </div>
  );
}

/** The portal's opening, for the screens before the dashboard. */
/**
 * The first thing under the store's name: what is waiting on the owner,
 * counted from the shop's own orders and listings, each a link to the place
 * it gets fixed. Nothing here is estimated; an empty list says so.
 */
function NeedsAttention({ items, ready }) {
  if (!items.length) {
    return ready ? (
      <p className="attention-clear"><CheckCircle size={20} weight="fill" aria-hidden="true" /> Nothing needs you right now.</p>
    ) : null;
  }
  return (
    <section className="attention" aria-labelledby="attention-title">
      <h2 id="attention-title" className="attention-title">Needs attention</h2>
      <ul className="attention-list">
        {items.map(item => (
          <li key={item.title}>
            <a className="attention-item" href={item.href}>
              <span className="attention-count">{item.count}</span>
              <span className="attention-copy"><strong>{item.title}</strong><small>{item.note}</small></span>
              <ArrowRight className="attention-arrow" size={18} aria-hidden="true" />
            </a>
          </li>
        ))}
      </ul>
    </section>
  );
}

function PortalIntro() {
  return (
    <section className="admin-intro">
      <p className="eyebrow">For Local Partners</p>
      <h1 id="portal-title">Store Owner Portal</h1>
      <p>Keep your catalog current so shoppers always see available, accurate furniture.</p>
    </section>
  );
}

/** Label for a submit button that may be busy or held shut by a rate limit. */
function submitLabel({ busy, cooldown, busyText, idle }) {
  if (cooldown > 0) return `Try again in ${cooldown}s`;
  return busy ? <><span className="loading-spinner" aria-hidden="true" />{busyText}</> : idle;
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
            type="email" spellCheck={false}
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
      <div className="oauth-row">
        <p className="or-rule" aria-hidden="true"><span>or</span></p>
        <GoogleButton intent="store" />
      </div>

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
        <label>Contact email<input name="email" type="email" spellCheck={false} required autoComplete="email" /></label>
        <PasswordField autoComplete="new-password" minLength={8} />
        <label>Contact number<input name="phone" type="tel" required autoComplete="tel" inputMode="tel" /></label>
        <label>
          What will you list?
          <textarea name="message" rows={2} maxLength={1000} placeholder="e.g. 40 pieces, mostly cabinets and dining sets…" />
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
      <div className="oauth-row">
        <p className="or-rule" aria-hidden="true"><span>or</span></p>
        <GoogleButton intent="store" label="Apply with Google" />
        <p className="form-note">No password to make: you sign in with Google, then fill in the application.</p>
      </div>
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
function PendingPanel({ email, onLogout, isAdmin, accountRole }) {
  if (!isAdmin && accountRole === 'onboarding') {
    /* Signed in (often with Google) but never applied, or the application
       was not approved: nothing is "in review". Say so and go to the form. */
    return (
      <div className="login-panel">
        <div className="login-copy">
          <span className="secure-mark" aria-hidden="true">⌑</span>
          <h2>No store application yet.</h2>
          <p>
            <b>{email}</b> is signed in but has not applied to sell, or its last application was not
            approved. Applying takes a minute.
          </p>
        </div>
        <div className="panel-actions">
          <Link className="button button-primary" href="/onboarding?as=store">Apply to sell <span aria-hidden="true">→</span></Link>
          <button className="button button-outline" type="button" onClick={onLogout}>Sign out</button>
        </div>
      </div>
    );
  }
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
        <div className="panel-actions">
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
      <div className="panel-actions">
        <p className="card-copy">Nothing to do here for now. Sign out and come back once you hear from us.</p>
        <button className="button button-outline" type="button" onClick={onLogout}>Sign out</button>
      </div>
    </div>
  );
}

/* ----------------------------------------------------------------- portal -- */

/* The shop's .glb lifecycle rows by product id (0013). A portal on a
   database without 0013 simply has no rows, and shows no warnings. */
async function loadModelLife(sb, storeUuid) {
  try {
    const rows = await sb.listStoreModelLifecycle(storeUuid);
    return new Map(rows.filter(row => row.kind === 'glb').map(row => [row.product_id, row]));
  } catch {
    return new Map();
  }
}

const shortDate = value => new Date(value).toLocaleDateString('en-PH', { year: 'numeric', month: 'short', day: 'numeric' });
const spanSince = days => (days >= 60 ? `${Math.floor(days / 30.4)} months` : `${days} days`);

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
  const [cooldown, setCooldown] = useState(0);       // seconds left after a 429
  // Whether to show a way through to the platform console. The server answers
  // this; it decides what to render and grants nothing on its own.
  const [isAdmin, setIsAdmin] = useState(false);
  const [openOrders, setOpenOrders] = useState(0);   // for the rail's Orders badge
  const [accountRole, setAccountRole] = useState(null);
  const [paymentStatus, setPaymentStatus] = useState(null);   // reported by StoreOrders
  // 0013: where each of the shop's .glb models stands against the one-year
  // rule, keyed by product id. From the database; empty when it cannot say.
  const [modelLife, setModelLife] = useState(() => new Map());
  const [keeping, setKeeping] = useState(null);

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

  /* The portal's messages go through the site's one notification system.
     This used to be a private toast — a state string, a timer and its own
     <div> — which showed a FAILED delete in exactly the same neutral style as
     a successful one. The type is now part of the call, so an error reads as
     an error. */
  const alert = useAlert();
  const toast = (message, type = 'success') => alert.notify({ type, message });

  /* Back from a Google sign-in that did not finish (lib/oauth.js). */
  useEffect(() => {
    const query = new URLSearchParams(window.location.search);
    const code = query.get('oauth_error');
    if (!code) return;
    alert.raise(oauthAlert(code));
    query.delete('oauth_error');
    window.history.replaceState(null, '', `/portal${query.size ? `?${query}` : ''}${window.location.hash}`);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);


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
      // Without a store: in review, or never applied (a Google sign-in)?
      setAccountRole(membership ? 'owner' : await sb.myRole().catch(() => null));

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
        setModelLife(await loadModelLife(sb, membership.storeUuid));
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
      } else if (backendConfigured()) {
        /* A deployment WITH a database that is not answering. The demo
           sign-in is closed here (lib/handler.js) — an outage must never
           turn into a second way in — so say what is actually wrong. */
        throw new Error('Connection failed. Check your internet connection and try again.');
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
      const message = error.message || 'Sign-in failed.';
      /* Beside the form it is about — not also as an alert. */
      setLoginError(message);
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
      const message = result.applicationFiled
        ? `${confirm} — your store is queued for review.`
        : `${confirm}. We could not file your store application automatically, so email hello@furnishar.ph with your store name and we will add it by hand. Do not sign up again; the account already exists.`;
      setSignupMessage({
        ok: true,
        text: message,
        email,
        needsEmailConfirmation: result.needsEmailConfirmation
      });
      toast('Application received.');
    } catch (error) {
      const message = error.message || 'Account creation failed.';
      setSignupMessage({ ok: false, text: message });
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

  /* "Keep 3D model" (0013): records a use, so the year starts again and the
     email the shop was sent stops counting. */
  async function keepModel(product, life) {
    setKeeping(product.id);
    try {
      await supabase().keepModel(life.asset_id);
      await reloadInventory();
      toast(`Kept. The 3D model of ${product.name} is safe for another year.`);
    } catch (error) {
      toast(error.message || 'We couldn’t keep this model. Please try again.', 'error');
    } finally {
      setKeeping(null);
    }
  }

  /** Opens the confirmation. The deletion itself happens in performDelete. */
  function handleDelete(product) {
    setPendingDelete(product);
  }

  async function performDelete(product) {
    setPendingDelete(null);
    try {
      if (usingSupabase()) {
        await supabase().deleteProduct(product.id);
        supabase().refreshCatalog();
      } else await api(`/api/products/${product.id}`, { method: 'DELETE', token: session.token });
      await reloadInventory();
      toast('Product deleted.');
    } catch (error) {
      toast(error.message || 'Could not delete the product.', 'error');
    }
  }

  const reloadInventory = useCallback(async () => {
    if (usingSupabase()) {
      if (!session?.user?.storeUuid) return;
      setOwnProducts(await supabase().listOwnProducts(session.user.storeUuid));
      setModelLife(await loadModelLife(supabase(), session.user.storeUuid));
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
      <>
      <PortalIntro />
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
      </>
    );
  }

  if (awaitingApproval) {
    return <><PortalIntro /><PendingPanel email={user.email} onLogout={handleLogout} isAdmin={isAdmin} accountRole={accountRole} /></>;
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
  const soldOut = ownProducts.filter(product => product.stock < 1).length;
  // A model with no catalogue picture (0012): uploaded before posters, or the
  // picture failed. Only knowable with the database, where posters live.
  const needsPoster = product => usingSupabase() && Boolean(product.modelGlb) && !product.posterPath;
  const missingPosters = ownProducts.filter(needsPoster).length;
  // A model within 30 days of becoming deletable, or already deletable.
  const atRisk = product => Boolean(product.modelGlb && modelLife.get(product.id)?.at_risk);
  const expiring = ownProducts.filter(atRisk);

  const accountEmail = user.email || session?.user?.email || '';
  const readyShare = ownProducts.length ? Math.round((placeable / ownProducts.length) * 100) : 0;
  const railItems = [
    { href: '#overview', label: 'Overview', icon: SquaresFour, tab: true },
    { href: '#inventory', label: 'Inventory', icon: Package, tab: true, count: missingModels, countLabel: 'without a 3D model' },
    ...(usingSupabase() && user.storeUuid
      ? [{ href: '#orders', label: 'Orders', icon: ShoppingBag, tab: true, count: openOrders, countLabel: 'open' },
         { href: '#billing', label: 'Billing', icon: Receipt, tab: true }]
      : []),
    { href: '#plan', label: 'Plan', icon: Crown }
  ];

  return (
    <ConsoleShell kicker="Store Portal" org={user.store} items={railItems} email={accountEmail}
      onSignOut={handleLogout} spy>
      <div id="overview" className="console-overview">
        <ConsoleHeader
          eyebrow="Store Portal"
          title={user.store}
          id="portal-title"
          actions={<>
            {isAdmin && <ConsoleCta href="/admin" icon={ArrowUpRight} className="is-quiet">Platform Console</ConsoleCta>}
            <ConsoleCta icon={Plus} onClick={() => setEditing(null)}>Add Product</ConsoleCta>
          </>}
        >
          {ownProducts.length
            ? <p>{placeable} of {ownProducts.length} listings can be placed in a shopper&rsquo;s room.</p>
            : <p>Add your first piece so shoppers can find it and measure it at home.</p>}
        </ConsoleHeader>

        {usingSupabase() && user.storeUuid && <PaymentSetupReminder storeUuid={user.storeUuid} status={paymentStatus} />}

        <NeedsAttention items={[
          openOrders > 0 && { href: '#orders', count: openOrders, title: openOrders === 1 ? 'Open order' : 'Open orders', note: 'Confirm, prepare and hand over.' },
          missingModels > 0 && { href: '#inventory', count: missingModels, title: missingModels === 1 ? 'Listing without a 3D model' : 'Listings without a 3D model', note: 'Shoppers can’t place these in their room.' },
          expiring.length > 0 && { href: '#inventory', count: expiring.length, title: expiring.length === 1 ? '3D model unused for 11 months' : '3D models unused for 11 months', note: `An administrator may delete ${expiring.length === 1 ? 'it' : 'them'} from ${shortDate(Math.min(...expiring.map(p => Date.parse(modelLife.get(p.id).deletable_from))))}. Choose “Keep 3D model” to keep ${expiring.length === 1 ? 'it' : 'them'}.` },
          missingPosters > 0 && { href: '#inventory', count: missingPosters, title: missingPosters === 1 ? 'Listing without a catalogue preview' : 'Listings without a catalogue preview', note: 'Shoppers see a placeholder on the card. Use “Regenerate preview”.' },
          soldOut > 0 && { href: '#inventory', count: soldOut, title: soldOut === 1 ? 'Listing out of stock' : 'Listings out of stock', note: 'Shoppers can’t buy these until you restock.' }
        ].filter(Boolean)} ready={ownProducts.length > 0} />

        <ul className="console-bento" aria-label="Store at a glance">
          <li className="console-tile is-hero bezel">
            <div className="bezel-core">
              <p className="console-tile-label">Ready for AR</p>
              <p className="console-tile-value">
                {placeable}<small>&nbsp;/&nbsp;{ownProducts.length}</small>
              </p>
              <div className="console-meter" role="img" aria-label={`${readyShare}% of listings have a 3D model`}>
                <span style={{ width: `${readyShare}%` }} />
              </div>
              <p className="console-tile-note">
                {missingModels > 0
                  ? <>{missingModels} {missingModels === 1 ? 'listing has' : 'listings have'} no 3D model. Shoppers see the
                      measurements but can&rsquo;t place {missingModels === 1 ? 'it' : 'them'} in their room.
                      Add a <code translate="no">.glb</code> from Edit.</>
                  : ownProducts.length
                    ? 'Every listing can be placed in a room at true scale.'
                    : 'Listings with a 3D model show up here.'}
              </p>
              <div className="console-tile-actions">
                <ConsoleCta href="#inventory" icon={ArrowRight} className="is-quiet">
                  {missingModels > 0 ? 'Fix Listings' : 'Open Inventory'}
                </ConsoleCta>
              </div>
            </div>
          </li>
          <li className="console-tile bezel">
            <div className="bezel-core">
              <p className="console-tile-label">Listed Products</p>
              <p className="console-tile-value">{ownProducts.length}{isFree && <small>&nbsp;/&nbsp;{FREEMIUM_LIMIT}</small>}</p>
              <p className="console-tile-note">{isFree ? `${Math.max(FREEMIUM_LIMIT - ownProducts.length, 0)} left on Freemium` : 'Unlimited on Premium'}</p>
            </div>
          </li>
          <li className="console-tile bezel">
            <div className="bezel-core">
              <p className="console-tile-label">Units in Stock</p>
              <p className="console-tile-value">{units}</p>
              <p className="console-tile-note">Across {ownProducts.length} {ownProducts.length === 1 ? 'listing' : 'listings'}</p>
            </div>
          </li>
          <li className="console-tile bezel">
            <div className="bezel-core">
              <p className="console-tile-label">Catalog Value</p>
              <p className="console-tile-value">{money(value).replace(/\.00$/, '')}</p>
              <p className="console-tile-note">Price × units in stock</p>
            </div>
          </li>
          <li className="console-tile bezel">
            <div className="bezel-core">
              <p className="console-tile-label">Plan</p>
              <p className="console-tile-value">{isFree ? 'Freemium' : 'Premium'}</p>
              <p className="console-tile-note"><a href="#plan">Compare plans</a></p>
            </div>
          </li>
        </ul>
      </div>

      <ConsoleSection
        id="inventory"
        title="Inventory"
        note="Your listings as shoppers see them. A listing without a 3D model can’t be placed in a room."
        action={<ConsoleCta icon={Plus} onClick={() => setEditing(null)}>Add Product</ConsoleCta>}
      >
        {ownProducts.length ? (
          <div className="inventory-table-wrap">
            <table>
              <thead>
                <tr>
                  <th scope="col">Product</th><th scope="col">Dimensions</th><th scope="col">Price</th>
                  <th scope="col">In Stock</th><th scope="col">Updated</th><th scope="col"><span className="sr-only">Actions</span></th>
                </tr>
              </thead>
              <tbody>
                {ownProducts.map(product => (
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
                          ? ' · 3D model ready'
                          : <span className="missing-model"> · No 3D model, not shown in AR</span>}
                        {needsPoster(product) && <span className="missing-model"> · Catalogue preview needed</span>}
                        {usingSupabase() && product.modelGlb && product.posterPath && ' · Catalogue preview ready'}
                        {atRisk(product) && (
                          <span className="missing-model"> · 3D model unused {spanSince(modelLife.get(product.id).idle_days)}; can be deleted from {shortDate(Date.parse(modelLife.get(product.id).deletable_from))}</span>
                        )}
                      </small>
                    </span>
                  </div>
                </td>
                <td data-label="Dimensions">
                  {formatDimensions(product.dimensions, 'cm')}
                </td>
                <td data-label="Price" className="num">{money(product.price)}</td>
                <td data-label="In stock" className="num">{product.stock}</td>
                <td data-label="Updated"><small>{relativeTime(product.updatedAt)}</small></td>
                <td data-label="Actions">
                  <div className="table-actions">
                    <button className="icon-button row-edit" type="button" onClick={() => setEditing(product)} aria-label={`Edit ${product.name}`}>Edit</button>
                    {atRisk(product) && (
                      <button className="icon-button" type="button" disabled={keeping === product.id}
                        aria-busy={keeping === product.id || undefined}
                        onClick={() => keepModel(product, modelLife.get(product.id))}
                        aria-label={`Keep the 3D model of ${product.name}`}>
                        {keeping === product.id ? 'Keeping…' : 'Keep 3D model'}
                      </button>
                    )}
                    {needsPoster(product) && (
                      <button className="icon-button" type="button" onClick={() => setEditing(product)}
                        aria-label={`Regenerate the catalogue preview for ${product.name}`}>Regenerate preview</button>
                    )}
                    <button className="icon-button delete row-delete" type="button" onClick={() => handleDelete(product)}
                      aria-label={`Delete ${product.name}…`}>
                      Delete…
                    </button>
                  </div>
                </td>
              </tr>
                ))}
              </tbody>
            </table>
          </div>
        ) : (
          <div className="bezel">
            <div className="bezel-core console-empty">
              <h3>No Products Yet</h3>
              <p>Add a piece with its real measurements. Attach a <code translate="no">.glb</code> model so shoppers can place it in their room.</p>
              <ConsoleCta icon={Plus} onClick={() => setEditing(null)}>Add Your First Product</ConsoleCta>
            </div>
          </div>
        )}
      </ConsoleSection>

      {/* Orders and billing live in the database (0009); the demo backend has neither. */}
      {usingSupabase() && user.storeUuid && <StoreOrders storeUuid={user.storeUuid} onOpenCount={setOpenOrders} onPaymentStatus={setPaymentStatus} />}

      <ConsoleSection id="plan" title="Your Plan" note="Premium lifts the listing limit and features your pieces at the top of the catalog.">
        <PlanPanel plan={plan} used={ownProducts.length} />
      </ConsoleSection>

      {editing !== undefined && (
        <ProductFormDialog
          product={editing}
          session={session}
          onClose={() => setEditing(undefined)}
          onSaved={async (message, type = 'success') => {
            setEditing(undefined);
            await reloadInventory().catch(() => {});
            toast(message, type);
          }}
        />
      )}

      {pendingDelete && (
        <ConfirmDialog
          title={`Delete “${pendingDelete.name}”?`}
          body="It will be removed from your catalog and from any shopper’s saved plan. This can’t be undone."
          confirmLabel="Delete Product"
          onConfirm={() => performDelete(pendingDelete)}
          onCancel={() => setPendingDelete(null)}
        />
      )}
    </ConsoleShell>
  );
}
