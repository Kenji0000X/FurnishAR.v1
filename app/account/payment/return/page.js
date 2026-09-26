import PaymentReturn from './PaymentReturn.js';

/**
 * Back from a payment provider.                                DFD: P10
 *
 * Provider-neutral: /account/payment/return?provider=maya&ref=<FurnishAR
 * reference>&result=success|failure|cancel. The query is only a pointer —
 * the server re-reads the payment from the provider and checks it against
 * the attempt it recorded before the buyer left. Rendered in the browser
 * only: the answer belongs to one signed-in person.
 */
export const dynamic = 'force-dynamic';

export const metadata = {
  title: 'Confirming your payment',
  robots: { index: false, follow: false, nocache: true }
};

export default function PaymentReturnPage() {
  return (
    <section className="view account-view active" aria-labelledby="payment-return-title">
      <PaymentReturn />
    </section>
  );
}
