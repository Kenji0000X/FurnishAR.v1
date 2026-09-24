import ReceiptView from '../../../billing/ReceiptView.js';

/**
 * An order's receipt.                                          DFD: P10
 *
 * Rendered in the browser, never on the server: it holds a person's name,
 * address and payment IDs, and a cached server render could be handed to the
 * wrong person. Who may read it is decided by RLS on `orders` and `payments`.
 */
export const dynamic = 'force-dynamic';

export const metadata = {
  title: 'Receipt',
  robots: { index: false, follow: false, nocache: true }
};

export default async function ReceiptPage({ params }) {
  const { id } = await params;
  return (
    <section className="view receipt-view active" aria-labelledby="receipt-title">
      <ReceiptView orderId={id} />
    </section>
  );
}
