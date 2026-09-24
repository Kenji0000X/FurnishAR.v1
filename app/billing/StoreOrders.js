'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import { supabase } from '../portal/backend.js';
import useAlert from '../alerts/useAlert.js';
import { ConsoleSection } from '../console/ConsoleShell.js';
import OrderCard, { money } from './OrderCard.js';

/**
 * A store's incoming orders, its billing settings and its fee balance.
 *                                                             DFD: P7 → P10
 *
 * The owner chooses what kind of shop this is — selling from stock, or
 * building to order — and which PayPal account buyers pay. Buyers pay that
 * account directly; FurnishAR's 10% is tallied here and settled separately.
 *
 * Every button reflects the request it started (spinner, same label), and
 * declining a request — the one thing here a buyer is told about and cannot
 * be undone — asks first, in a real dialog.
 */
const CLOSED = ['fulfilled', 'declined', 'cancelled', 'expired'];

export default function StoreOrders({ storeUuid, onOpenCount }) {
  const alert = useAlert();
  const [billing, setBilling] = useState(undefined);   // undefined = loading, null = failed
  const [orders, setOrders] = useState(null);
  const [busy, setBusy] = useState('');                 // `${orderId}:${action}` or 'settings'
  const [quoting, setQuoting] = useState(null);
  const [declining, setDeclining] = useState(null);
  const [dirty, setDirty] = useState(false);

  const load = useCallback(async () => {
    const sb = supabase();
    const [settings, list] = await Promise.all([
      sb.storeBilling(storeUuid).catch(() => null),
      sb.listStoreOrders(storeUuid).catch(() => null)
    ]);
    setBilling(settings);
    setOrders(list);
  }, [storeUuid]);

  useEffect(() => { load(); }, [load]);

  const open = (orders || []).filter(o => !CLOSED.includes(o.status));
  const past = (orders || []).filter(o => CLOSED.includes(o.status));
  useEffect(() => { onOpenCount?.(open.length); }, [open.length, onOpenCount]);

  /* Unsaved billing changes: ask before the page is left. */
  useEffect(() => {
    if (!dirty) return undefined;
    const warn = event => { event.preventDefault(); event.returnValue = ''; };
    window.addEventListener('beforeunload', warn);
    return () => window.removeEventListener('beforeunload', warn);
  }, [dirty]);

  async function saveSettings(event) {
    event.preventDefault();
    const values = Object.fromEntries(new FormData(event.currentTarget));
    setBusy('settings');
    try {
      await supabase().orderAction('store-billing', {
        storeId: storeUuid,
        fulfilment: values.fulfilment,
        paypalEmail: String(values.paypalEmail || '').trim(),
        notifyEmail: String(values.notifyEmail || '').trim(),
        deliveryDays: Number(values.deliveryDays),
        pickupDays: Number(values.pickupDays)
      });
      setDirty(false);
      alert.showSuccess('Billing settings saved.');
      await load();
    } catch (error) {
      alert.showError(error.message);
    }
    setBusy('');
  }

  async function act(order, action, extra = {}) {
    const key = `${order.id}:${action}:${extra.status || ''}`;
    setBusy(key);
    try {
      await supabase().orderAction(action, { orderId: order.id, ...extra });
      const said = action === 'delivery' ? {
        out_for_delivery: `${order.reference} is out for delivery. The buyer can follow it in their orders.`,
        ready_for_pickup: `${order.reference} is ready for pickup. The buyer can see it in their orders.`,
        delivered: `${order.reference} marked ${order.fulfilment_method === 'pickup' ? 'picked up' : 'delivered'}.`
      }[extra.status] : {
        quote: `Quote sent for ${order.reference}.`,
        decline: `Request ${order.reference} declined.`,
        ready: `${order.reference} marked ready. The buyer is asked for the balance.`
      }[action];
      alert.showSuccess(said);
      setQuoting(null);
      setDeclining(null);
      await load();
    } catch (error) {
      alert.showError(error.message);
    }
    setBusy('');
  }

  const isBusy = (order, action, status = '') => busy === `${order.id}:${action}:${status}`;
  const Spin = ({ on }) => (on ? <span className="loading-spinner" aria-hidden="true" /> : null);

  if (billing === undefined) {
    return (
      <ConsoleSection id="orders" title="Orders" note="Loading orders…">
        <div className="bezel" aria-busy="true"><div className="bezel-core console-empty"><p>Loading orders…</p></div></div>
      </ConsoleSection>
    );
  }

  return (
    <>
      <ConsoleSection
        id="orders"
        title={`Orders${open.length ? ` · ${open.length} Open` : ''}`}
        note="New and in-progress orders first. Buyers pay your PayPal directly; move each one along as you prepare it."
      >
        {orders === null ? (
          <div className="bezel"><div className="bezel-core console-empty">
            <h3>Orders Didn&rsquo;t Load</h3>
            <p>Check your connection, then try again.</p>
            <button className="button" type="button" onClick={load}>Try Again</button>
          </div></div>
        ) : !orders.length ? (
          <div className="bezel"><div className="bezel-core console-empty">
            <h3>No Orders Yet</h3>
            <p>When a shopper buys a piece or requests a custom build, it appears here with everything you need to fulfil it.</p>
          </div></div>
        ) : (
          <ul className="orders-list">
            {[...open, ...past].map(order => (
              <OrderCard key={order.id} order={order} perspective="store">
                <div className="order-actions">
                  {['requested', 'quoted'].includes(order.status) && (
                    <>
                      <button className="button button-primary" type="button" onClick={() => setQuoting(order.id)}
                        aria-expanded={quoting === order.id}>
                        {order.status === 'quoted' ? 'Revise Quote…' : 'Send Quote…'}
                      </button>
                      <button className="button button-outline" type="button" onClick={() => setDeclining(order)}>
                        Decline…
                      </button>
                    </>
                  )}
                  {order.status === 'deposit_paid' && (
                    <button className="button button-primary" type="button" disabled={isBusy(order, 'ready')}
                      aria-busy={isBusy(order, 'ready') || undefined} onClick={() => act(order, 'ready')}>
                      <Spin on={isBusy(order, 'ready')} />Mark Ready &amp; Request Balance
                    </button>
                  )}
                  {order.status === 'paid' && order.fulfilment_method !== 'pickup'
                    && order.delivery_status !== 'out_for_delivery' && (
                    <button className="button button-primary" type="button"
                      disabled={isBusy(order, 'delivery', 'out_for_delivery')}
                      aria-busy={isBusy(order, 'delivery', 'out_for_delivery') || undefined}
                      onClick={() => act(order, 'delivery', { status: 'out_for_delivery' })}>
                      <Spin on={isBusy(order, 'delivery', 'out_for_delivery')} />Out for Delivery
                    </button>
                  )}
                  {order.status === 'paid' && order.fulfilment_method === 'pickup'
                    && order.delivery_status !== 'ready_for_pickup' && (
                    <button className="button button-primary" type="button"
                      disabled={isBusy(order, 'delivery', 'ready_for_pickup')}
                      aria-busy={isBusy(order, 'delivery', 'ready_for_pickup') || undefined}
                      onClick={() => act(order, 'delivery', { status: 'ready_for_pickup' })}>
                      <Spin on={isBusy(order, 'delivery', 'ready_for_pickup')} />Ready for Pickup
                    </button>
                  )}
                  {order.status === 'paid' && (
                    <button className="button button-outline" type="button"
                      disabled={isBusy(order, 'delivery', 'delivered')}
                      aria-busy={isBusy(order, 'delivery', 'delivered') || undefined}
                      onClick={() => act(order, 'delivery', { status: 'delivered' })}>
                      <Spin on={isBusy(order, 'delivery', 'delivered')} />
                      {order.fulfilment_method === 'pickup' ? 'Mark Picked Up' : 'Mark Delivered'}
                    </button>
                  )}
                </div>
                {quoting === order.id && (
                  <form className="order-quote" onSubmit={event => {
                    event.preventDefault();
                    const v = Object.fromEntries(new FormData(event.currentTarget));
                    act(order, 'quote', { price: String(v.price).trim(), leadDays: String(v.leadDays).trim(), note: v.note });
                  }}>
                    <label>Your price (₱)
                      <input name="price" type="text" inputMode="decimal" required autoComplete="off" placeholder="12500.00…" />
                    </label>
                    <label>Lead time (days)
                      <input name="leadDays" type="text" inputMode="numeric" required autoComplete="off" placeholder="14…" />
                    </label>
                    <label>Note to buyer
                      <input name="note" maxLength={1000} autoComplete="off" placeholder="Two coats of oil finish…" />
                    </label>
                    <div className="order-actions">
                      <button className="button button-primary" type="submit" disabled={isBusy(order, 'quote')}
                        aria-busy={isBusy(order, 'quote') || undefined}>
                        <Spin on={isBusy(order, 'quote')} />Send Quote
                      </button>
                      <button className="button" type="button" onClick={() => setQuoting(null)}>Cancel</button>
                    </div>
                    <p className="form-note">The buyer sees your price plus the 10% service fee and pays half as a deposit.</p>
                  </form>
                )}
              </OrderCard>
            ))}
          </ul>
        )}
      </ConsoleSection>

      <ConsoleSection
        id="billing"
        title="Billing & Store Type"
        note="Buyers pay your PayPal account directly: your price plus FurnishAR’s 10% service fee, which you settle separately."
      >
        {billing === null ? (
          <div className="bezel"><div className="bezel-core console-empty">
            <h3>Billing Didn&rsquo;t Load</h3>
            <p>Check your connection, then try again.</p>
            <button className="button" type="button" onClick={load}>Try Again</button>
          </div></div>
        ) : (
          <>
            <dl className="billing-summary">
              <div><dt>Fees Accrued</dt><dd>{money(billing.fees.accrued)}</dd></div>
              <div><dt>Settled</dt><dd>{money(billing.fees.settled)}</dd></div>
              <div><dt>Owed to FurnishAR</dt><dd>{money(billing.fees.outstanding)}</dd></div>
            </dl>
            <div className="bezel console-panel">
              <div className="bezel-core">
                <form className="product-form billing-form" onSubmit={saveSettings} onInput={() => setDirty(true)}>
                  <fieldset className="form-grid">
                    <legend className="sr-only">Store type, payments & delivery</legend>
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
                        autoComplete="email" spellCheck={false} placeholder="payments@yourshop.ph…" />
                    </label>
                    <label>
                      Order notification email
                      <input name="notifyEmail" type="email" defaultValue={billing.notifyEmail}
                        autoComplete="email" spellCheck={false} placeholder="orders@yourshop.ph…" />
                    </label>
                    <label>
                      Delivery takes (days)
                      <input name="deliveryDays" type="number" min="1" max="60" required inputMode="numeric"
                        defaultValue={billing.deliveryDays} />
                    </label>
                    <label>
                      Ready for pickup in (days)
                      <input name="pickupDays" type="number" min="0" max="60" required inputMode="numeric"
                        defaultValue={billing.pickupDays} />
                    </label>
                  </fieldset>
                  <p className="form-note">
                    Delivery is free for buyers. These days set the estimated arrival date on each receipt, plus
                    the lead time you quote for custom builds. Leave the notification email empty to use your sign-in email.
                  </p>
                  <button className="button button-primary" type="submit" disabled={busy === 'settings'}
                    aria-busy={busy === 'settings' || undefined}>
                    {busy === 'settings' && <span className="loading-spinner" aria-hidden="true" />}
                    Save Billing Settings
                  </button>
                </form>
              </div>
            </div>
          </>
        )}
      </ConsoleSection>

      {declining && (
        <DeclineDialog
          order={declining}
          busy={isBusy(declining, 'decline')}
          onConfirm={reason => act(declining, 'decline', { reason })}
          onCancel={() => setDeclining(null)}
        />
      )}
    </>
  );
}

/** Declining tells the buyer and cannot be undone, so it is asked, with a reason. */
function DeclineDialog({ order, busy, onConfirm, onCancel }) {
  const ref = useRef(null);
  useEffect(() => {
    const dialog = ref.current;
    if (!dialog?.open) dialog?.showModal();
    dialog?.addEventListener('close', onCancel);
    return () => dialog?.removeEventListener('close', onCancel);
  }, [onCancel]);

  return (
    <dialog ref={ref} className="confirm-dialog" aria-labelledby="decline-title" aria-describedby="decline-body">
      <form method="dialog" onSubmit={event => {
        event.preventDefault();
        onConfirm(String(new FormData(event.currentTarget).get('reason') || '').trim());
      }} onKeyDown={event => {
        if (event.key === 'Enter' && (event.metaKey || event.ctrlKey)) event.currentTarget.requestSubmit();
      }}>
        <h2 id="decline-title">Decline {order.reference}?</h2>
        <p id="decline-body">{order.buyer_name} is told their request was declined. Nothing is charged. This can&rsquo;t be undone.</p>
        <label className="decline-reason">
          Reason for the buyer (optional)
          <textarea name="reason" rows={3} maxLength={500} placeholder="We can’t source narra in that size this month…" />
        </label>
        <div className="confirm-actions">
          <button className="button" type="button" autoFocus onClick={() => ref.current?.close()}>Keep Request</button>
          <button className="button button-danger" type="submit" disabled={busy} aria-busy={busy || undefined}>
            {busy && <span className="loading-spinner" aria-hidden="true" />}Decline Request
          </button>
        </div>
      </form>
    </dialog>
  );
}
