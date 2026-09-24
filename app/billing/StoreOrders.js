'use client';

import { useCallback, useEffect, useState } from 'react';
import { supabase } from '../portal/backend.js';
import useAlert from '../alerts/useAlert.js';
import OrderCard, { money } from './OrderCard.js';

/**
 * A store's billing settings, its fee balance and its incoming orders.
 *                                                             DFD: P7 → P10
 *
 * The owner chooses what kind of shop this is — selling from stock, or
 * building to order — and which PayPal account buyers pay. Buyers pay that
 * account directly; FurnishAR's 10% is tallied here and settled separately.
 */
export default function StoreOrders({ storeUuid }) {
  const alert = useAlert();
  const [billing, setBilling] = useState(null);
  const [orders, setOrders] = useState(null);
  const [busy, setBusy] = useState('');
  const [quoting, setQuoting] = useState(null);

  const load = useCallback(async () => {
    const sb = supabase();
    const [settings, list] = await Promise.all([
      sb.storeBilling(storeUuid).catch(() => null),
      sb.listStoreOrders(storeUuid).catch(() => [])
    ]);
    setBilling(settings);
    setOrders(list);
  }, [storeUuid]);

  useEffect(() => { load(); }, [load]);

  async function saveSettings(event) {
    event.preventDefault();
    const values = Object.fromEntries(new FormData(event.currentTarget));
    setBusy('settings');
    try {
      await supabase().orderAction('store-billing', {
        storeId: storeUuid,
        fulfilment: values.fulfilment,
        paypalEmail: values.paypalEmail,
        notifyEmail: values.notifyEmail
      });
      alert.showSuccess('Billing settings saved.');
      await load();
    } catch (error) {
      alert.showError(error.message);
    }
    setBusy('');
  }

  async function act(order, action, extra = {}) {
    setBusy(order.id);
    try {
      await supabase().orderAction(action, { orderId: order.id, ...extra });
      const said = {
        quote: `Quote sent for ${order.reference}. The buyer has been emailed.`,
        decline: `Request ${order.reference} declined.`,
        ready: `${order.reference} marked ready. The buyer has been asked for the balance.`,
        fulfil: `${order.reference} marked as handed over.`
      }[action];
      alert.showSuccess(said);
      setQuoting(null);
      await load();
    } catch (error) {
      alert.showError(error.message);
    }
    setBusy('');
  }

  if (!billing) return null;
  const open = (orders || []).filter(o => !['fulfilled', 'declined', 'cancelled', 'expired'].includes(o.status));
  const past = (orders || []).filter(o => !open.includes(o));

  return (
    <>
      <section className="plan-section" aria-labelledby="billing-title">
        <div className="section-heading">
          <div><p className="eyebrow">Payments</p><h2 id="billing-title">Billing &amp; store type</h2></div>
        </div>
        <form className="product-form billing-form" onSubmit={saveSettings}>
          <fieldset className="form-grid">
            <legend className="sr-only">What kind of shop</legend>
            <label>
              Store type
              <select name="fulfilment" defaultValue={billing.fulfilment}>
                <option value="stocked">Stocked — buyers pay in full for pieces on hand</option>
                <option value="custom">Custom — buyers request a build, you quote, 50% deposit</option>
              </select>
            </label>
            <label>
              PayPal email (you are paid here)
              <input name="paypalEmail" type="email" defaultValue={billing.paypalEmail} required
                autoComplete="email" spellCheck={false} placeholder="shop@example.com…" />
            </label>
            <label>
              Order notification email
              <input name="notifyEmail" type="email" defaultValue={billing.notifyEmail}
                autoComplete="email" spellCheck={false} placeholder="Optional — defaults to your sign-in email…" />
            </label>
          </fieldset>
          <p className="form-note">
            Buyers pay your PayPal account directly: your price plus FurnishAR&rsquo;s 10% service fee.
            The fee is tallied below and settled with FurnishAR separately.
          </p>
          <button className="button button-primary" type="submit" disabled={busy === 'settings'} aria-busy={busy === 'settings'}>
            {busy === 'settings' ? 'Saving…' : 'Save billing settings'}
          </button>
        </form>
        <dl className="billing-summary">
          <div><dt>Fees accrued</dt><dd>{money(billing.fees.accrued)}</dd></div>
          <div><dt>Settled</dt><dd>{money(billing.fees.settled)}</dd></div>
          <div><dt>Owed to FurnishAR</dt><dd>{money(billing.fees.outstanding)}</dd></div>
        </dl>
      </section>

      <section className="plan-section" aria-labelledby="orders-title" id="orders">
        <div className="section-heading">
          <div><p className="eyebrow">Sales</p><h2 id="orders-title">Orders{open.length ? ` (${open.length} open)` : ''}</h2></div>
        </div>
        {orders === null ? <p className="card-copy">Loading orders…</p> : !orders.length ? (
          <p className="card-copy">No orders yet.</p>
        ) : (
          <ul className="orders-list">
            {[...open, ...past].map(order => (
              <OrderCard key={order.id} order={order} perspective="store">
                <div className="order-actions">
                  {['requested', 'quoted'].includes(order.status) && (
                    <>
                      <button className="button button-primary" type="button" onClick={() => setQuoting(order.id)}
                        disabled={busy === order.id}>
                        {order.status === 'quoted' ? 'Revise quote' : 'Send quote'}
                      </button>
                      <button className="button button-outline" type="button" disabled={busy === order.id}
                        onClick={() => {
                          const reason = window.prompt('Decline this request? Add a reason for the buyer (optional):');
                          if (reason !== null) act(order, 'decline', { reason });
                        }}>
                        Decline
                      </button>
                    </>
                  )}
                  {order.status === 'deposit_paid' && (
                    <button className="button button-primary" type="button" disabled={busy === order.id}
                      onClick={() => act(order, 'ready')}>Mark ready — request balance</button>
                  )}
                  {order.status === 'paid' && (
                    <button className="button button-primary" type="button" disabled={busy === order.id}
                      onClick={() => act(order, 'fulfil')}>Mark handed over</button>
                  )}
                </div>
                {quoting === order.id && (
                  <form className="order-quote" onSubmit={event => {
                    event.preventDefault();
                    const v = Object.fromEntries(new FormData(event.currentTarget));
                    act(order, 'quote', { price: v.price, leadDays: v.leadDays, note: v.note });
                  }}>
                    <label>Your price (₱)<input name="price" type="number" min="1" step="0.01" required inputMode="decimal" /></label>
                    <label>Lead time (days)<input name="leadDays" type="number" min="1" max="365" required inputMode="numeric" /></label>
                    <label>Note to buyer<input name="note" maxLength={1000} placeholder="Optional…" /></label>
                    <div className="order-actions">
                      <button className="button button-primary" type="submit" disabled={busy === order.id}>Send quote</button>
                      <button className="button" type="button" onClick={() => setQuoting(null)}>Cancel</button>
                    </div>
                    <p className="form-note">The buyer sees your price plus the 10% service fee, and pays half as a deposit.</p>
                  </form>
                )}
              </OrderCard>
            ))}
          </ul>
        )}
      </section>
    </>
  );
}
