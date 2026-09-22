import AdminGate from './AdminGate.js';

/**
 * The console's shell, for the operator who vets store owners.
 *
 * Nothing is server-rendered into any of these pages, on purpose: the queue
 * holds applicants' email addresses and phone numbers, and a statically
 * generated page could be cached and served to the wrong person. The gate
 * fetches what it needs as the signed-in user, and row level security decides
 * what that is.
 *
 * The gate sits here rather than in each page so that moving between the six
 * sections does not re-run the role check and the six queries behind it.
 */
export const dynamic = 'force-dynamic';

export const metadata = {
  title: 'Platform console',
  // Never indexed, never previewed, never followed.
  robots: { index: false, follow: false, nocache: true }
};

export default function AdminLayout({ children }) {
  return (
    <section className="view admin-view active" aria-labelledby="console-title">
      <AdminGate>{children}</AdminGate>
    </section>
  );
}
