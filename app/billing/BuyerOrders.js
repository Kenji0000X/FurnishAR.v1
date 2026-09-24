'use client';

import Link from 'next/link';
import { useCallback, useEffect, useRef, useState } from 'react';
import { supabase } from '../portal/backend.js';
import useAlert from '../alerts/useAlert.js';
import OrderCard from './OrderCard.js';

/**
 * A shopper's orders, and the way back from PayPal.            DFD: P10
 *
 * PayPal returns the buyer to /account?paypal=return&token=<PayPal order>.
 * That token is only a pointer: the server re-reads the PayPal order,
 * checks it against what the database says is owed, captures it and
 * records it. Refreshing this page cannot pay twice — the capture and the
 * record are both idempotent.
 */
export default function BuyerOrders() {
  const alert = useAlert();
  const [orders, setOrders] = useState(null);
  const [busy, setBusy] = useState('');
  const handledReturn = useRef(false);

  const load = useCallback(async () => {
    try {
      setOrders(await supabase().listMyOrders());
    } catch (error) {
      setOrders([]);
      alert.fromError(error, 'orders');
    }
  }, [alert]);

  useEffect(() => {
    if (handledReturn.current) { load(); return; }
    handledReturn.current = true;
    const params = new URLSearchParams(window.location.search);
    const outcome = params.get('paypal');
    const token = params.get('token');
    // Clean the address first, so a refresh or a shared link does not replay it.
    if (outcome) window.history.replaceState(null, '', '/account#orders');

    (async () => {
      if (outcome === 'return' && token) {
        const pending = alert.showInfo('Confirming your payment with PayPal…', { duration: 0 });
        /* One alert for one operation: the "confirming" notice becomes its
           outcome instead of a second message appearing beside it. */
        const settle = (type, message) => {
          if (!alert.update(pending, { type, message, title: undefined, duration: type === 'success' ? 6000 : 0 })) {
            alert.notify({ type, message });
          }
        };
        try {
          const result = await supabase().orderAction('capture', { paypalOrderId: token });
          if (result.pending) {
            settle('warning', 'PayPal is still reviewing this payment. We will update the order when it clears.');
          } else if (result.applied === false) {
            settle('warning', 'Your payment went through, but the order had already changed. The shop has been asked to refund it.');
          } else {
            settle('success', result.status === 'deposit_paid'
              ? 'Deposit paid. Your build is reserved.'
              : 'Payment received. The shop has been notified.');
          }
        } catch (error) {
          settle('error', error.message);
        }
      } else if (outcome === 'cancel') {
        alert.showInfo('Payment cancelled. Nothing was charged; you can pay from your orders below.');
      }
      await load();
    })();
  }, [alert, load]);

  async function act(order, action) {
    setBusy(order.id);
    try {
      if (action === 'pay') {
        const result = await supabase().orderAction('pay', { orderId: order.id });
        window.location.assign(result.approveUrl);
        return;
      }
      await supabase().orderAction('cancel', { orderId: order.id });
      alert.showSuccess(`Order ${order.reference} cancelled. Nothing was charged.`);
      await load();
    } catch (error) {
      alert.showError(error.message);
    }
    setBusy('');
  }

  return (
    <section className="account-card" aria-labelledby="orders-title" id="orders">
      <h2 id="orders-title">Your orders</h2>
      {orders === null ? (
        <p className="card-copy">Loading your orders…</p>
      ) : orders.length === 0 ? (
        <p className="card-copy">
          No orders yet. <Link href="/collection">Browse the catalogue</Link> — buy from a shop&rsquo;s stock,
          or request a custom build from a made-to-order shop.
        </p>
      ) : (
        <ul className="orders-list">
          {orders.map(order => {
            const payLabel = { pending_payment: 'Pay with PayPal', quoted: 'Pay deposit', balance_due: 'Pay balance' }[order.status];
            const cancellable = ['pending_payment', 'requested', 'quoted'].includes(order.status);
            return (
              <OrderCard key={order.id} order={order} perspective="buyer">
                {(payLabel || cancellable) && (
                  <div className="order-actions">
                    {payLabel && (
                      <button className="button button-primary" type="button" disabled={busy === order.id}
                        aria-busy={busy === order.id} onClick={() => act(order, 'pay')}>
                        {busy === order.id ? 'Opening PayPal…' : payLabel}
                      </button>
                    )}
                    {cancellable && (
                      <button className="button button-outline" type="button" disabled={busy === order.id}
                        onClick={() => act(order, 'cancel')}>
                        {order.kind === 'custom' ? 'Withdraw request' : 'Cancel'}
                      </button>
                    )}
                  </div>
                )}
              </OrderCard>
            );
          })}
        </ul>
      )}
      <p className="card-copy demo-note">
        Payments go directly to each shop&rsquo;s PayPal account. The price includes FurnishAR&rsquo;s 10% service fee.
      </p>
    </section>
  );
}
