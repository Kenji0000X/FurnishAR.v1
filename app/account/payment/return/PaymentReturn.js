'use client';

import Link from 'next/link';
import { useEffect, useRef, useState } from 'react';
import { initBackend, usingSupabase, supabase } from '../../../portal/backend.js';

const LABEL = { paypal: 'PayPal', maya: 'Maya' };

/* What each server verdict means to the buyer. */
const OUTCOME = {
  paid: { title: 'Payment received',
    body: status => (status === 'deposit_paid'
      ? 'Deposit paid. Your build is reserved, and the shop has been told.'
      : 'Thank you. The shop has been told and your receipt is on its way by email.') },
  unapplied: { title: 'Payment received, but not applied',
    body: () => 'Your payment went through, but the order had already changed (paid already, or the stock ran out). It will be refunded; FurnishAR has been told.' },
  pending: { title: 'Payment still processing',
    body: provider => `${LABEL[provider]} has not finished processing this payment. Your order updates by itself when it clears; you do not need to pay again.` },
  failed: { title: 'Payment not completed',
    body: provider => `${LABEL[provider]} did not complete the payment. You have not been charged. You can try again from your orders.` },
  cancelled: { title: 'Payment cancelled',
    body: () => 'Nothing was charged. You can pay from your orders whenever you are ready.' },
  mismatch: { title: 'We need to check this payment',
    body: () => 'The payment does not match your order, so it was not applied. FurnishAR has been told and will refund it.' }
};

export default function PaymentReturn() {
  const [view, setView] = useState({ state: 'checking' });
  const started = useRef(false);

  useEffect(() => {
    if (started.current) return;
    started.current = true;
    const params = new URLSearchParams(window.location.search);
    const provider = params.get('provider');
    const reference = params.get('ref');
    const result = params.get('result');
    // A refresh or a shared link must not carry the reference around.
    window.history.replaceState(null, '', '/account/payment/return');

    (async () => {
      if (provider !== 'maya' || !reference) { setView({ state: 'unknown' }); return; }
      await initBackend();
      if (!usingSupabase()) { setView({ state: 'unknown' }); return; }
      try {
        const answer = await supabase().orderAction('verify', { provider, reference });
        setView({ state: answer.state, status: answer.status, provider, orderId: answer.orderId });
      } catch (error) {
        if (error.code === 'auth_required' || error.code === 'session_expired') {
          setView({ state: 'signin', provider });
        } else {
          // The provider said "cancel": nothing to confirm, whatever the server could reach.
          setView(result === 'cancel' ? { state: 'cancelled', provider } : { state: 'error', provider, message: error.message });
        }
      }
    })();
  }, []);

  const { state, provider } = view;
  const outcome = OUTCOME[state];
  return (
    <article className="account-card payment-return" aria-live="polite">
      <p className="eyebrow">{LABEL[provider] || 'Payment'}</p>
      {state === 'checking' ? (
        <>
          <h1 id="payment-return-title">Confirming your payment…</h1>
          <p className="card-copy">We are checking with the payment provider. This takes a few seconds; please keep this page open.</p>
        </>
      ) : outcome ? (
        <>
          <h1 id="payment-return-title">{outcome.title}</h1>
          <p className="card-copy">{outcome.body(state === 'paid' ? view.status : provider)}</p>
        </>
      ) : state === 'signin' ? (
        <>
          <h1 id="payment-return-title">Sign in to see your payment</h1>
          <p className="card-copy">Your session ended while you were paying. Sign in again; your order shows whether the payment went through.</p>
        </>
      ) : state === 'error' ? (
        <>
          <h1 id="payment-return-title">We couldn&rsquo;t confirm the payment yet</h1>
          <p className="card-copy">{view.message} If you paid, your order updates by itself once the provider confirms it; do not pay twice.</p>
        </>
      ) : (
        <>
          <h1 id="payment-return-title">Nothing to confirm</h1>
          <p className="card-copy">This link has no payment to check. Your orders show where each one stands.</p>
        </>
      )}
      {state !== 'checking' && (
        <div className="order-actions">
          {state === 'signin'
            ? <Link className="button button-primary" href="/login?as=buyer&next=%2Faccount%23orders">Sign in</Link>
            : <Link className="button button-primary" href="/account#orders">View your orders</Link>}
          {state === 'paid' && view.orderId && (
            <Link className="button button-outline" href={`/account/receipt/${view.orderId}`}>View receipt</Link>
          )}
        </div>
      )}
    </article>
  );
}
