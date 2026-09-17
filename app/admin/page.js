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

/**
 * The page itself says nothing.
 *
 * The headings used to live here, server-rendered for whoever asked — so a
 * signed-out visitor who typed /admin, or pressed Back onto it, was met by
 * "Platform administration — Store applications — check each applicant before
 * approving", and only then told they were not allowed. That advertised the
 * surface, and the URL worked for everyone. Everything the console says now
 * lives inside AdminConsole, which renders nothing until the server has
 * confirmed who is asking, and sends anybody else to the store portal.
 */
export default function AdminPage() {
  return (
    <section className="view admin-view active" aria-labelledby="console-title">
      <AdminConsole />
    </section>
  );
}
