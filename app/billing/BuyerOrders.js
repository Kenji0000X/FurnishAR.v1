'use client';

import Link from 'next/link';
import { useCallback, useEffect, useRef, useState } from 'react';
import { supabase } from '../portal/backend.js';
import useAlert from '../alerts/useAlert.js';
import OrderCard from './OrderCard.js';
import ConfirmDialog from '../ConfirmDialog.js';

/* Waiting on the buyer's money first, then anything still moving, then the
   finished ones — so "Pay balance" is never under a delivered order. The
   server's order (newest first) is kept inside each group. */
const PAY_NOW = ['pending_payment', 'quoted', 'balance_due'];
const CLOSED = ['fulfilled', 'declined', 'cancelled', 'expired'];
const rank = order => (PAY_NOW.includes(order.status) ? 0 : CLOSED.includes(order.status) ? 2 : 1);

const PROVIDER_LABEL = { paypal: 'PayPal', maya: 'Maya' };

/**
 * A shopper's orders, and the way back from PayPal.            DFD: P10
 *
 * Each order that is waiting on money offers the payment methods its shop
 * can take right now (/api/sb/orders/providers). Maya returns the buyer to
 * /account/payment/return, which confirms the payment the same way.
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
  const [methods, setMethods] = useState({});   // store id → payment methods it takes
  const [busy, setBusy] = useState('');
  const handledReturn = useRef(false);

  const load = useCallback(async () => {
    try {
      const list = await supabase().listMyOrders();
      setOrders(list);
      const stores = [...new Set(list.filter(o => PAY_NOW.includes(o.status)).map(o => o.store_id).filter(Boolean))];
      const found = await Promise.all(stores.map(id => supabase().storePaymentProviders(id)));
      setMethods(Object.fromEntries(stores.map((id, i) => [id, found[i]])));
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

  const [cancelling, setCancelling] = useState(null);   // the order awaiting confirmation

  async function act(order, action, provider = 'paypal') {
    setCancelling(null);
    setBusy(`${order.id}:${provider}`);
    try {
      if (action === 'pay') {
        const result = await supabase().orderAction('pay', { orderId: order.id, provider });
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
          No orders yet. <Link href="/collection">Browse the catalogue</Link> to buy from a shop&rsquo;s stock
          or request a custom build from a made-to-order shop.
        </p>
      ) : (
        <ul className="orders-list">
          {[...orders].sort((a, b) => rank(a) - rank(b)).map(order => {
            const payLabel = { pending_payment: 'Pay', quoted: 'Pay deposit', balance_due: 'Pay balance' }[order.status];
            const payWith = payLabel ? (methods[order.store_id] || []) : [];
            const cancellable = ['pending_payment', 'requested', 'quoted'].includes(order.status);
            const working = busy.startsWith(`${order.id}:`);
            return (
              <OrderCard key={order.id} order={order} perspective="buyer">
                {(payLabel || cancellable) && (
                  <div className="order-actions">
                    {payWith.map(provider => (
                      <button key={provider} className={`button ${provider === payWith[0] ? 'button-primary' : 'button-outline'}`}
                        type="button" disabled={working} aria-busy={busy === `${order.id}:${provider}`}
                        onClick={() => act(order, 'pay', provider)}>
                        {busy === `${order.id}:${provider}` ? `Opening ${PROVIDER_LABEL[provider]}…` : `${payLabel} with ${PROVIDER_LABEL[provider]}`}
                      </button>
                    ))}
                    {payLabel && !payWith.length && (
                      <p className="card-copy">The shop can&rsquo;t take online payments right now. Please try again later.</p>
                    )}
                    {cancellable && (
                      <button className="button button-outline" type="button" disabled={working}
                        onClick={() => setCancelling(order)}>
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
      {cancelling && (
        <ConfirmDialog
          title={cancelling.kind === 'custom' ? `Withdraw request ${cancelling.reference}?` : `Cancel order ${cancelling.reference}?`}
          body="Nothing has been charged for it. This can’t be undone; you can order again from the product page."
          confirmLabel={cancelling.kind === 'custom' ? 'Withdraw Request' : 'Cancel Order'}
          cancelLabel="Keep It"
          onConfirm={() => act(cancelling, 'cancel')}
          onCancel={() => setCancelling(null)}
        />
      )}
      <p className="card-copy demo-note">
        PayPal payments go directly to the shop&rsquo;s PayPal account. Maya payments are received by FurnishAR&rsquo;s
        Maya account, which pays the shop its share, unless Maya settles to the shop directly. The price includes FurnishAR&rsquo;s 10% service fee.
      </p>
    </section>
  );
}
