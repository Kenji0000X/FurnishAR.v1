'use client';

import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { useEffect, useRef, useState } from 'react';
import { initBackend, usingSupabase, supabase } from '../../portal/backend.js';
import AuthGateDialog from '../../AuthGateDialog.js';
import useAlert from '../../alerts/useAlert.js';

/**
 * Buying, or asking for a build.                               DFD: P10
 *
 * A STOCKED shop's piece is bought outright: the buyer sees the shop's
 * price, FurnishAR's 10% service fee on top, and the total, says how they
 * want it (free delivery or store pickup), then pays on the provider's own
 * page: PayPal (straight to the shop's PayPal account) or GCash, processed
 * by PayMongo (FurnishAR's PayMongo account, which owes the shop its share —
 * 0016). A CUSTOM
 * shop's piece is a starting point: the buyer describes what they want and
 * the shop replies with a quote.
 *
 * What this component shows is a preview. The amount actually charged, the
 * fee, the payee and whether the delivery details are acceptable are decided
 * by the database (0009–0016) — this page could be edited in devtools to say
 * ₱1 and the buyer would still be asked for the real price.
 *
 * Only the payment methods the server says this shop can take are offered
 * (/api/sb/orders/providers). A shop with none says so instead of offering a
 * button the server would refuse. Buyers never connect PayPal or GCash to
 * FurnishAR: they authorise only on the provider's page, for that one payment,
 * and no GCash number, PIN or OTP ever reaches FurnishAR.
 */
const money = value => `₱${Number(value || 0).toLocaleString('en-PH', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;

const PROVIDER_LABEL = { paypal: 'PayPal', paymongo: 'GCash' };

/** One sentence on where the money goes, true for each provider. */
function whoIsPaid(provider, store, config) {
  if (provider === 'paypal') {
    return `You pay ${store} directly through PayPal — with your PayPal account or a card through PayPal.`;
  }
  const gcash = (config?.providers || []).find(p => p.id === 'paymongo');
  return gcash?.splitEnabled
    ? `You pay with GCash, securely through PayMongo. ${store}'s share is settled to it through PayMongo.`
    : `You pay with GCash, securely through PayMongo. FurnishAR receives the payment and pays ${store} its share.`;
}

/** The button that sends the buyer to the provider. */
function buyLabel(available) {
  return available.length === 1 ? `Buy with ${PROVIDER_LABEL[available[0]]}` : 'Buy now';
}

export default function PurchasePanel({ product }) {
  const alert = useAlert();
  const router = useRouter();
  const [config, setConfig] = useState(null);
  const [available, setAvailable] = useState([]);   // payment methods this shop takes, per the server
  const [role, setRole] = useState(null);
  const [quantity, setQuantity] = useState(1);
  const [gate, setGate] = useState(null);
  const [dialog, setDialog] = useState(null);   // 'checkout' | 'request' | null

  const custom = product.fulfilment === 'custom';
  const stock = Number(product.stock) || 0;
  const here = `/furniture/${encodeURIComponent(product.slug || product.id)}`;

  useEffect(() => {
    let alive = true;
    (async () => {
      await initBackend();
      if (!usingSupabase()) { if (alive) setConfig({ payments: false, offline: true }); return; }
      const [cfg, who, methods] = await Promise.all([
        supabase().billingConfig(),
        supabase().myRole().catch(() => 'unknown'),
        product.storeUuid ? supabase().storePaymentProviders(product.storeUuid) : []
      ]);
      if (alive) { setConfig(cfg); setRole(who); setAvailable(methods); }
    })();
    return () => { alive = false; };
  }, [product.storeUuid]);

  // No database: the bundled demo catalogue has no shops to pay.
  if (!config || config.offline || !product.storeUuid) return null;
  if (!custom && !config.payments) return null;

  if (product.paymentsReady === false || (!custom && available.length === 0)) {
    return (
      <section className="purchase-panel" aria-labelledby="purchase-heading">
        <h2 id="purchase-heading" className="sr-only">Buying</h2>
        <p className="purchase-note" role="status">
          {product.store} is finishing its payment setup, so online {custom ? 'requests' : 'checkout'} will open soon.
          {product.storeContact ? ` To buy now, contact the shop at ${product.storeContact}.` : ' To buy now, contact the shop directly.'}
        </p>
      </section>
    );
  }

  const rate = Number(config.feeRate ?? 0.1);
  const subtotal = Number(product.price) * quantity;
  const fee = Math.round(subtotal * rate * 100) / 100;

  function needsBuyer(title) {
    if (role === 'guest') {
      setGate({ title, body: `Create a free shopper account or sign in. You will come straight back to the ${product.name}.` });
      return true;
    }
    if (role === 'onboarding') {
      // Signed in (e.g. with Google) but not yet a shopper: one question first.
      router.push(`/onboarding?as=buyer&next=${encodeURIComponent(here)}`);
      return true;
    }
    if (role === 'owner' || role === 'admin' || role === 'pending') {
      alert.showInfo('Store and admin accounts cannot place orders. Sign in with a shopper account to buy.');
      return true;
    }
    return false;
  }

  return (
    <section className="purchase-panel" aria-labelledby="purchase-heading">
      <h2 id="purchase-heading" className="sr-only">{custom ? 'Request a custom build' : 'Buy'}</h2>

      {custom ? (
        <>
          <p className="purchase-note">
            Made to order by {product.store}. Send your size and finish; the shop replies with a
            price and lead time. You pay a 50% deposit to reserve the build and the balance when it is ready.
            Delivery is free, or pick it up at the shop.
          </p>
          <button
            className="button button-primary"
            type="button"
            onClick={() => { if (!needsBuyer('Sign in to request a custom build.')) setDialog('request'); }}
          >
            Request a custom build
          </button>
        </>
      ) : stock < 1 ? (
        <p className="purchase-note">Out of stock. Check back soon, or contact {product.store}.</p>
      ) : (
        <>
          <dl className="price-breakdown">
            <div><dt>Price{quantity > 1 ? ` × ${quantity}` : ''}</dt><dd>{money(subtotal)}</dd></div>
            <div><dt>Service fee ({Math.round(rate * 100)}%)</dt><dd>{money(fee)}</dd></div>
            <div><dt>Delivery</dt><dd>Free</dd></div>
            <div className="price-total"><dt>Total</dt><dd>{money(subtotal + fee)}</dd></div>
          </dl>
          <div className="purchase-row">
            <label className="quantity-field">
              Qty
              <select value={quantity} onChange={event => setQuantity(Number(event.target.value))}>
                {Array.from({ length: Math.min(stock, 20) }, (_, i) => i + 1).map(n => (
                  <option key={n} value={n}>{n}</option>
                ))}
              </select>
            </label>
            <button
              className="button button-primary"
              type="button"
              onClick={() => { if (!needsBuyer('Sign in to buy this piece.')) setDialog('checkout'); }}
            >
              {buyLabel(available)}
            </button>
          </div>
          <p className="purchase-note">
            {available.length === 1 ? whoIsPaid(available[0], product.store, config)
              : `Pay with ${available.map(id => PROVIDER_LABEL[id]).join(' or ')}.`}{' '}
            Free delivery in Occidental Mindoro, or pick it up
            at the shop. The piece is held for you for 30 minutes while you pay.
            {(config.providers || []).some(p => available.includes(p.id) && p.sandbox) ? ' (Test mode — no real money moves.)' : ''}
          </p>
        </>
      )}

      {dialog === 'checkout' && (
        <CheckoutDialog product={product} quantity={quantity} subtotal={subtotal} fee={fee} here={here}
          config={config} available={available} onClose={() => setDialog(null)} />
      )}
      {dialog === 'request' && (
        <CustomRequestDialog product={product} onClose={() => setDialog(null)} />
      )}
      {gate && (
        <AuthGateDialog title={gate.title} body={gate.body} next={here} onClose={() => setGate(null)} />
      )}
    </section>
  );
}

/** A native <dialog>, opened on mount, closed by Escape, Cancel or success. */
function useModal(onClose) {
  const ref = useRef(null);
  useEffect(() => {
    const dialog = ref.current;
    if (!dialog?.open) dialog?.showModal();
    dialog?.addEventListener('close', onClose);
    return () => dialog?.removeEventListener('close', onClose);
  }, [onClose]);
  return ref;
}

/**
 * How the buyer gets it: free delivery or store pickup, and a number the
 * shop can call. The municipality defaults to the one on their profile.
 */
function DeliveryFields({ store }) {
  const [method, setMethod] = useState('delivery');
  const [towns, setTowns] = useState([]);
  const [home, setHome] = useState('');

  useEffect(() => {
    let alive = true;
    Promise.all([
      supabase().listMunicipalities().catch(() => []),
      supabase().buyerProfile().catch(() => null)
    ]).then(([list, profile]) => {
      if (!alive) return;
      setTowns(list);
      setHome(profile?.municipality || '');
    });
    return () => { alive = false; };
  }, []);

  return (
    <fieldset className="delivery-fields">
      <legend>How would you like to get it?</legend>
      <div className="delivery-choice" role="radiogroup">
        <label className="choice-card">
          <input type="radio" name="method" value="delivery" checked={method === 'delivery'}
            onChange={() => setMethod('delivery')} />
          <span><b>Free delivery</b><small>Anywhere in Occidental Mindoro</small></span>
        </label>
        <label className="choice-card">
          <input type="radio" name="method" value="pickup" checked={method === 'pickup'}
            onChange={() => setMethod('pickup')} />
          <span><b>Store pickup</b><small>Collect it at {store}</small></span>
        </label>
      </div>

      {method === 'delivery' && (
        <>
          <label>
            Delivery address
            <input name="address" required minLength={5} maxLength={300} autoComplete="street-address"
              placeholder="House no., street, barangay…" />
          </label>
          <label>
            Municipality
            <select name="municipality" required value={home} onChange={event => setHome(event.target.value)}>
              <option value="" disabled>Choose…</option>
              {towns.map(town => <option key={town} value={town}>{town}</option>)}
            </select>
          </label>
        </>
      )}
      <label>
        Mobile number
        <input name="phone" type="tel" required inputMode="tel" autoComplete="tel" pattern="[0-9+() \-]{7,20}"
          maxLength={20} placeholder="0917 123 4567…" />
      </label>
      <label>
        Notes for the shop (optional)
        <input name="deliveryNotes" maxLength={300} placeholder={method === 'delivery' ? 'Landmark, gate colour…' : 'Preferred pickup time…'} />
      </label>
    </fieldset>
  );
}

function deliveryFrom(values) {
  return {
    method: values.method,
    address: values.address || null,
    municipality: values.municipality || null,
    phone: values.phone,
    notes: values.deliveryNotes || null
  };
}

function CheckoutDialog({ product, quantity, subtotal, fee, here, config, available, onClose }) {
  const alert = useAlert();
  const ref = useModal(onClose);
  const [provider, setProvider] = useState(available[0]);
  const [busy, setBusy] = useState(false);
  const sandbox = (config.providers || []).find(p => p.id === provider)?.sandbox ?? config.sandbox;
  const [error, setError] = useState('');
  const [email, setEmail] = useState('');

  useEffect(() => {
    supabase().getSession().then(current => setEmail(current?.user?.email || '')).catch(() => {});
  }, []);

  async function submit(event) {
    event.preventDefault();
    const values = Object.fromEntries(new FormData(event.currentTarget));
    setBusy(true);
    setError('');
    try {
      const result = await supabase().orderAction('checkout', {
        productId: product.id, quantity, provider, delivery: deliveryFrom(values)
      });
      // To the provider's own page, and back to /account (PayPal) or
      // /account/payment/return (GCash), where the server confirms it.
      window.location.assign(result.approveUrl);
    } catch (failure) {
      setBusy(false);
      if (failure.code === 'auth_required' || failure.code === 'session_expired') {
        alert.raise('auth.expired', { actions: [{ label: 'Sign in again', href: `/login?as=buyer&next=${encodeURIComponent(here)}` }] });
        ref.current?.close();
      } else {
        setError(failure.message);
      }
    }
  }

  return (
    <dialog ref={ref} className="confirm-dialog request-dialog" aria-labelledby="checkout-title">
      <form className="product-form" onSubmit={submit}>
        <h2 id="checkout-title">Checkout</h2>
        {email && <p className="form-note">Signed in as <b>{email}</b></p>}
        <dl className="price-breakdown">
          <div><dt>{product.name}{quantity > 1 ? ` × ${quantity}` : ''}</dt><dd>{money(subtotal)}</dd></div>
          <div><dt>Service fee (10%)</dt><dd>{money(fee)}</dd></div>
          <div><dt>Delivery</dt><dd>Free</dd></div>
          <div className="price-total"><dt>Total</dt><dd>{money(subtotal + fee)}</dd></div>
        </dl>
        <DeliveryFields store={product.store} />
        {available.length > 1 && (
          <fieldset className="delivery-fields payment-methods">
            <legend>Pay with</legend>
            <div className="delivery-choice" role="radiogroup">
              {available.map(id => (
                <label className="choice-card" key={id}>
                  <input type="radio" name="provider" value={id} checked={provider === id}
                    onChange={() => setProvider(id)} />
                  <span><b>{PROVIDER_LABEL[id]}</b>
                    <small>{id === 'paypal' ? 'PayPal account or card' : 'Secure payment via PayMongo'}</small></span>
                </label>
              ))}
            </div>
          </fieldset>
        )}
        {error && <p className="form-error" role="alert">{error}</p>}
        <div className="confirm-actions">
          <button className="button" type="button" onClick={() => ref.current?.close()}>Cancel</button>
          <button className="button button-primary" type="submit" disabled={busy || !provider} aria-busy={busy}>
            {busy ? 'Opening payment…' : 'Continue to payment'}
          </button>
        </div>
        <p className="purchase-note">
          {whoIsPaid(provider, product.store, config)} You finish on {provider === 'paymongo' ? 'PayMongo' : 'PayPal'}&rsquo;s own page;
          FurnishAR never sees your password, card, GCash PIN or OTP. Your receipt and estimated arrival date are emailed to you after payment.
          {sandbox && <><br /><span className="status-chip is-sandbox">{provider === 'paymongo' ? 'PayMongo test mode' : 'PayPal Sandbox'}</span> Test mode — no real money moves.</>}
        </p>
      </form>
    </dialog>
  );
}

function CustomRequestDialog({ product, onClose }) {
  const alert = useAlert();
  const ref = useModal(onClose);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');

  async function submit(event) {
    event.preventDefault();
    const values = Object.fromEntries(new FormData(event.currentTarget));
    setBusy(true);
    setError('');
    try {
      const result = await supabase().orderAction('request', {
        storeId: product.storeUuid,
        productId: product.id,
        request: {
          width_cm: values.width, height_cm: values.height, depth_cm: values.depth,
          material: values.material, color: values.color, notes: values.notes
        },
        delivery: deliveryFrom(values)
      });
      alert.showSuccess(`Request ${result.reference} sent. ${product.store} will reply with a quote by email.`, {
        actions: [{ label: 'View your orders', href: '/account#orders' }]
      });
      ref.current?.close();
    } catch (failure) {
      setError(failure.message);
      setBusy(false);
    }
  }

  const d = product.dimensions || {};
  return (
    <dialog ref={ref} className="confirm-dialog request-dialog" aria-labelledby="request-title">
      <form className="product-form" onSubmit={submit}>
        <h2 id="request-title">Custom build from {product.store}</h2>
        <p>Based on the {product.name}. Change anything you like.</p>
        <div className="form-grid form-grid-3">
          <label>Width (cm)<input name="width" inputMode="decimal" defaultValue={d.width || ''} pattern="\d{1,4}(\.\d)?" /></label>
          <label>Depth (cm)<input name="depth" inputMode="decimal" defaultValue={d.depth || ''} pattern="\d{1,4}(\.\d)?" /></label>
          <label>Height (cm)<input name="height" inputMode="decimal" defaultValue={d.height || ''} pattern="\d{1,4}(\.\d)?" /></label>
        </div>
        <div className="form-grid">
          <label>Material<input name="material" maxLength={80} placeholder="Narra, rattan…" /></label>
          <label>Colour / finish<input name="color" maxLength={80} placeholder="Natural oil…" /></label>
        </div>
        <label>Notes<textarea name="notes" rows={3} maxLength={1000} placeholder="Anything the shop should know…" /></label>
        <DeliveryFields store={product.store} />
        {error && <p className="form-error" role="alert">{error}</p>}
        <div className="confirm-actions">
          <button className="button" type="button" onClick={() => ref.current?.close()}>Cancel</button>
          <button className="button button-primary" type="submit" disabled={busy} aria-busy={busy}>
            {busy ? 'Sending…' : 'Send request'}
          </button>
        </div>
        <p className="purchase-note">Nothing is charged until you accept a quote. <Link href="/faq">How custom orders work</Link></p>
      </form>
    </dialog>
  );
}
