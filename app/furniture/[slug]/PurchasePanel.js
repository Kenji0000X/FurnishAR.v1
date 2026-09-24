'use client';

import Link from 'next/link';
import { useEffect, useRef, useState } from 'react';
import { initBackend, usingSupabase, supabase } from '../../portal/backend.js';
import AuthGateDialog from '../../AuthGateDialog.js';
import useAlert from '../../alerts/useAlert.js';

/**
 * Buying, or asking for a build.                               DFD: P10
 *
 * A STOCKED shop's piece is bought outright: the buyer sees the shop's
 * price, FurnishAR's 10% service fee on top, and the total, then pays the
 * shop directly on PayPal. A CUSTOM shop's piece is a starting point: the
 * buyer describes what they want and the shop replies with a quote.
 *
 * What this component shows is a preview. The amount actually charged is
 * computed by the database from the product row (0009) — this page could be
 * edited in devtools to say ₱1 and the buyer would still be asked for the
 * real price.
 */
const money = value => `₱${Number(value || 0).toLocaleString('en-PH', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;

export default function PurchasePanel({ product }) {
  const alert = useAlert();
  const [config, setConfig] = useState(null);
  const [role, setRole] = useState(null);
  const [quantity, setQuantity] = useState(1);
  const [busy, setBusy] = useState(false);
  const [gate, setGate] = useState(null);
  const [requesting, setRequesting] = useState(false);

  const custom = product.fulfilment === 'custom';
  const stock = Number(product.stock) || 0;
  const here = `/furniture/${encodeURIComponent(product.slug || product.id)}`;

  useEffect(() => {
    let alive = true;
    (async () => {
      await initBackend();
      if (!usingSupabase()) { if (alive) setConfig({ payments: false, offline: true }); return; }
      const [cfg, who] = await Promise.all([
        supabase().billingConfig(),
        supabase().myRole().catch(() => 'unknown')
      ]);
      if (alive) { setConfig(cfg); setRole(who); }
    })();
    return () => { alive = false; };
  }, []);

  // No database: the bundled demo catalogue has no shops to pay.
  if (!config || config.offline || !product.storeUuid) return null;
  if (!custom && !config.payments) return null;

  const rate = Number(config.feeRate ?? 0.1);
  const subtotal = Number(product.price) * quantity;
  const fee = Math.round(subtotal * rate * 100) / 100;

  function needsBuyer(title) {
    if (role === 'guest') {
      setGate({ title, body: `Create a free shopper account or sign in. You will come straight back to the ${product.name}.` });
      return true;
    }
    if (role === 'owner' || role === 'admin' || role === 'pending') {
      alert.showInfo('Store and admin accounts cannot place orders. Sign in with a shopper account to buy.');
      return true;
    }
    return false;
  }

  async function buy() {
    if (needsBuyer('Sign in to buy this piece.')) return;
    setBusy(true);
    try {
      const result = await supabase().orderAction('checkout', { productId: product.id, quantity });
      // To PayPal — the shop's own account — and back to /account.
      window.location.assign(result.approveUrl);
    } catch (error) {
      setBusy(false);
      if (error.code === 'auth_required' || error.code === 'session_expired') {
        alert.raise('auth.expired', { actions: [{ label: 'Sign in again', href: `/login?as=buyer&next=${encodeURIComponent(here)}` }] });
      } else {
        alert.showError(error.message);
      }
    }
  }

  return (
    <section className="purchase-panel" aria-labelledby="purchase-heading">
      <h2 id="purchase-heading" className="sr-only">{custom ? 'Request a custom build' : 'Buy'}</h2>

      {custom ? (
        <>
          <p className="purchase-note">
            Made to order by {product.store}. Send your size and finish; the shop replies with a
            price and lead time. You pay a 50% deposit to reserve the build and the balance when it is ready.
          </p>
          <button
            className="button button-primary"
            type="button"
            onClick={() => { if (!needsBuyer('Sign in to request a custom build.')) setRequesting(true); }}
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
            <div className="price-total"><dt>Total</dt><dd>{money(subtotal + fee)}</dd></div>
          </dl>
          <div className="purchase-row">
            <label className="quantity-field">
              Qty
              <select value={quantity} onChange={event => setQuantity(Number(event.target.value))} disabled={busy}>
                {Array.from({ length: Math.min(stock, 20) }, (_, i) => i + 1).map(n => (
                  <option key={n} value={n}>{n}</option>
                ))}
              </select>
            </label>
            <button className="button button-primary" type="button" onClick={buy} disabled={busy} aria-busy={busy}>
              {busy ? 'Opening PayPal…' : 'Buy with PayPal'}
            </button>
          </div>
          <p className="purchase-note">
            You pay {product.store} directly through PayPal. The piece is held for you for 30 minutes while you pay.
            {config.sandbox ? ' (Test mode — no real money moves.)' : ''}
          </p>
        </>
      )}

      {requesting && (
        <CustomRequestDialog product={product} onClose={() => setRequesting(false)} />
      )}
      {gate && (
        <AuthGateDialog title={gate.title} body={gate.body} next={here} onClose={() => setGate(null)} />
      )}
    </section>
  );
}

function CustomRequestDialog({ product, onClose }) {
  const alert = useAlert();
  const dialogRef = useRef(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');

  useEffect(() => {
    const dialog = dialogRef.current;
    if (!dialog?.open) dialog?.showModal();
    dialog?.addEventListener('close', onClose);
    return () => dialog?.removeEventListener('close', onClose);
  }, [onClose]);

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
        }
      });
      alert.showSuccess(`Request ${result.reference} sent. ${product.store} will reply with a quote by email.`, {
        actions: [{ label: 'View your orders', href: '/account#orders' }]
      });
      dialogRef.current?.close();
    } catch (failure) {
      setError(failure.message);
      setBusy(false);
    }
  }

  const d = product.dimensions || {};
  return (
    <dialog ref={dialogRef} className="confirm-dialog request-dialog" aria-labelledby="request-title">
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
        <label>Notes<textarea name="notes" rows={4} maxLength={1000} placeholder="Anything the shop should know…" /></label>
        {error && <p className="form-error" role="alert">{error}</p>}
        <div className="confirm-actions">
          <button className="button" type="button" onClick={() => dialogRef.current?.close()}>Cancel</button>
          <button className="button button-primary" type="submit" disabled={busy} aria-busy={busy}>
            {busy ? 'Sending…' : 'Send request'}
          </button>
        </div>
        <p className="purchase-note">Nothing is charged until you accept a quote. <Link href="/faq">How custom orders work</Link></p>
      </form>
    </dialog>
  );
}
