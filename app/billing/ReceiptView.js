'use client';

import Link from 'next/link';
import { useEffect, useState } from 'react';
import { initBackend, usingSupabase, supabase } from '../portal/backend.js';
import { money, statusLabel } from './OrderCard.js';

/**
 * The receipt: what was bought, what was paid and how, and when it arrives.
 *                                                              DFD: P10
 * Every figure here is read from the order and payment rows the database
 * wrote; nothing is recomputed in the browser except the balance shown,
 * which is total minus paid.
 */
const day = value => (value
  ? new Date(/^\d{4}-\d{2}-\d{2}$/.test(value) ? `${value}T12:00:00+08:00` : value)
      .toLocaleDateString('en-PH', { timeZone: 'Asia/Manila', weekday: 'short', year: 'numeric', month: 'long', day: 'numeric' })
  : '—');
const when = value => (value
  ? new Date(value).toLocaleString('en-PH', { timeZone: 'Asia/Manila', dateStyle: 'medium', timeStyle: 'short' })
  : '—');

/** The steps an order goes through, marked done up to where it is now. */
function timeline(order) {
  const paidAt = order.payments?.filter(p => p.applied).at(-1)?.captured_at || order.paid_at;
  const pickup = order.fulfilment_method === 'pickup';
  const rank = { preparing: 1, out_for_delivery: 2, ready_for_pickup: 2, delivered: 3 }[order.delivery_status] || 0;
  const closed = ['declined', 'cancelled', 'expired'].includes(order.status);
  return [
    { label: 'Order placed', done: true, at: when(order.created_at) },
    { label: order.kind === 'custom' ? 'Deposit / payment received' : 'Payment received', done: rank >= 1, at: rank >= 1 ? when(paidAt) : '' },
    { label: order.kind === 'custom' ? 'Being built and prepared' : 'Being prepared', done: rank >= 1, at: '' },
    { label: pickup ? 'Ready for pickup' : 'Out for delivery', done: rank >= 2, at: '' },
    { label: pickup ? 'Picked up' : 'Delivered', done: rank >= 3, at: rank >= 3 ? when(order.delivered_at || order.fulfilled_at) : '' }
  ].map(step => ({ ...step, closed }));
}

export default function ReceiptView({ orderId }) {
  const [state, setState] = useState('loading');   // loading | ready | missing | offline
  const [order, setOrder] = useState(null);

  useEffect(() => {
    let alive = true;
    (async () => {
      await initBackend();
      if (!usingSupabase()) { if (alive) setState('offline'); return; }
      try {
        const row = await supabase().getOrderReceipt(orderId);
        if (!alive) return;
        setOrder(row);
        setState(row ? 'ready' : 'missing');
      } catch {
        if (alive) setState('missing');
      }
    })();
    return () => { alive = false; };
  }, [orderId]);

  if (state === 'loading') return <p className="card-copy">Loading your receipt…</p>;
  if (state !== 'ready') {
    return (
      <div className="account-card">
        <h1 id="receipt-title">Receipt not found</h1>
        <p className="card-copy">
          Sign in with the account that placed this order to see its receipt.
        </p>
        <div className="panel-actions">
          <Link className="button button-primary" href={`/login?as=buyer&next=${encodeURIComponent(`/account/receipt/${orderId}`)}`}>Sign in</Link>
          <Link className="button" href="/account#orders">Your orders</Link>
        </div>
      </div>
    );
  }

  const payments = (order.payments || []).filter(p => p.applied).sort((a, b) => a.captured_at.localeCompare(b.captured_at));
  const balance = Number(order.total || 0) - Number(order.amount_paid || 0);
  const pickup = order.fulfilment_method === 'pickup';
  const store = order.stores || {};

  return (
    <article className="receipt">
      <header className="receipt-head">
        <div>
          <p className="eyebrow">FurnishAR receipt</p>
          <h1 id="receipt-title">{Number(order.amount_paid) > 0 ? 'Payment receipt' : 'Order summary'}</h1>
          <p className="order-ref">No. {order.reference} · {statusLabel(order.status)}</p>
        </div>
        <div className="receipt-actions no-print">
          <button className="button button-primary" type="button" onClick={() => window.print()}>Print / save PDF</button>
          <Link className="button" href="/account#orders">Your orders</Link>
        </div>
      </header>

      <section className="receipt-grid" aria-label="Parties">
        <div>
          <h2>Sold by</h2>
          <p><b>{store.name || 'The shop'}</b><br />{store.address}<br />{store.contact_number}</p>
        </div>
        <div>
          <h2>Bill to</h2>
          <p><b>{order.buyer_name}</b><br />{order.buyer_email}<br />{order.delivery_phone}</p>
        </div>
      </section>

      <section aria-labelledby="items-title">
        <h2 id="items-title">Items</h2>
        <table className="receipt-table">
          <thead><tr><th>Item</th><th>Qty</th><th>Unit price</th><th>Amount</th></tr></thead>
          <tbody>
            <tr>
              <td>{order.product_name}</td>
              <td>{order.quantity}</td>
              <td>{order.unit_price != null ? money(order.unit_price) : '—'}</td>
              <td>{order.subtotal != null ? money(order.subtotal) : 'Awaiting quote'}</td>
            </tr>
          </tbody>
          {order.total != null && (
            <tfoot>
              <tr><td colSpan={3}>FurnishAR service fee (10%)</td><td>{money(order.platform_fee)}</td></tr>
              <tr><td colSpan={3}>{pickup ? 'Store pickup' : 'Delivery'}</td><td>Free</td></tr>
              <tr className="receipt-total"><td colSpan={3}>Total</td><td>{money(order.total)}</td></tr>
              {payments.map(p => (
                <tr key={p.capture_id}>
                  <td colSpan={3}>
                    Paid via PayPal{p.stage !== 'full' ? ` (${p.stage})` : ''} · {when(p.captured_at)}
                    <small className="receipt-txn">Transaction {p.capture_id}</small>
                  </td>
                  <td>−{money(p.amount)}</td>
                </tr>
              ))}
              <tr className="receipt-total">
                <td colSpan={3}>{balance > 0.004 ? 'Balance due' : 'Balance'}</td>
                <td>{money(Math.max(balance, 0))}</td>
              </tr>
            </tfoot>
          )}
        </table>
        {order.request && (
          <p className="order-meta">
            Custom request: {['width_cm', 'depth_cm', 'height_cm'].map(k => order.request[k] ?? '—').join(' × ')} cm
            {order.request.material ? ` · ${order.request.material}` : ''}{order.request.color ? ` · ${order.request.color}` : ''}
            {order.request.notes ? ` · ${order.request.notes}` : ''}
            {order.lead_time_days ? ` · lead time about ${order.lead_time_days} days` : ''}
          </p>
        )}
      </section>

      <section className="receipt-grid" aria-label="Delivery">
        <div>
          <h2>{pickup ? 'Store pickup' : 'Delivery'}</h2>
          <p>
            {pickup
              ? <>Collect at <b>{store.name}</b>{store.address ? `, ${store.address}` : ''}. Bring receipt no. {order.reference}.</>
              : <>{order.delivery_address}<br />{order.delivery_municipality}, Occidental Mindoro</>}
            {order.delivery_notes && <><br /><small>Note: {order.delivery_notes}</small></>}
          </p>
        </div>
        <div>
          <h2>{pickup ? 'Ready for pickup by' : 'Estimated arrival'}</h2>
          <p className="receipt-eta">{order.estimated_arrival ? day(order.estimated_arrival) : 'Set once payment is received'}</p>
        </div>
      </section>

      <section aria-labelledby="progress-title">
        <h2 id="progress-title">Progress</h2>
        <ol className="receipt-timeline">
          {timeline(order).map(step => (
            <li key={step.label} data-done={step.done || undefined}>
              <span>{step.label}</span>
              {step.at && <small>{step.at}</small>}
            </li>
          ))}
        </ol>
      </section>

      <p className="purchase-note">
        Paid directly to {store.name || 'the shop'} through PayPal. Keep this receipt for pickup, delivery and any returns.
      </p>
    </article>
  );
}
