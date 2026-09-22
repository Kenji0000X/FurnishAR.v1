import BuyerAccount from './BuyerAccount.js';

/**
 * The shopper's page, the counterpart to /portal.
 *
 * Nothing is server-rendered into it: it holds a person's name and
 * municipality, and a statically generated page could be cached and served to
 * the wrong person.
 */
export const dynamic = 'force-dynamic';

export const metadata = {
  title: 'Your account',
  robots: { index: false, follow: false, nocache: true }
};

export default function AccountPage() {
  return (
    <section className="view account-view active" aria-labelledby="account-title">
      <BuyerAccount />
    </section>
  );
}
