import AdminConsole from './AdminConsole.js';

/**
 * The platform console, for the operator who vets store owners.
 *
 * Nothing is server-rendered into this page, on purpose: the queue holds
 * applicants' email addresses and phone numbers, and a statically generated
 * page could be cached and served to the wrong person. The console fetches
 * what it needs as the signed-in user, and row level security decides what
 * that is.
 */
export const dynamic = 'force-dynamic';

export const metadata = {
  title: 'Platform console',
  description: 'Review store applications.',
  // Never indexed, never previewed, never followed.
  robots: { index: false, follow: false, nocache: true }
};

export default function AdminPage() {
  return (
    <section className="view admin-view active" aria-labelledby="console-title">
      <section className="admin-intro">
        <p className="eyebrow">Platform administration</p>
        <h1 id="console-title">Store applications</h1>
        <p>
          Check each applicant before approving. Approving creates their store and lets
          them publish furniture that shoppers will see.
        </p>
      </section>
      <AdminConsole />
    </section>
  );
}
