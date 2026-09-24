'use client';

import { usePathname, useRouter, useSearchParams } from 'next/navigation';
import { useAdmin } from '../AdminGate.js';
import ApplicationCard from '../ApplicationCard.js';

/**
 * The review queue, at a URL you can send someone.
 *
 * The filter is local now. It used to refetch the whole queue from the server
 * on every click between "Awaiting review" and "All applications" — a round
 * trip to answer a question the browser already had the answer to, and a way
 * for this page's count to disagree with the overview's.
 */
export default function AdminApplications() {
  const { applications, accounts, busy, onApprove, onReject } = useAdmin();
  /* Which list is showing lives in the URL (?show=all), so "all
     applications" is a link you can send, and refresh keeps it. */
  const router = useRouter();
  const pathname = usePathname();
  const search = useSearchParams();
  const tab = search?.get('show') === 'all' ? 'all' : 'pending';
  const setTab = next => router.replace(next === 'all' ? `${pathname}?show=all` : pathname, { scroll: false });

  const shown = tab === 'pending'
    ? applications.filter(a => a.status === 'pending')
    : applications;

  return (
    <>
      <section className="admin-intro">
        <p className="eyebrow">Platform Administration</p>
        <h1 id="console-title">Store Applications</h1>
        <p>
          Check each applicant before approving. Approving creates their store and lets
          them publish furniture that shoppers will see.
        </p>
      </section>

      <div className="mode-switch" role="tablist" aria-label="Which applications to show">
        <button type="button" role="tab" aria-selected={tab === 'pending'}
          className={`mode-option${tab === 'pending' ? ' is-active' : ''}`}
          onClick={() => setTab('pending')}>
          Awaiting Review
        </button>
        <button type="button" role="tab" aria-selected={tab === 'all'}
          className={`mode-option${tab === 'all' ? ' is-active' : ''}`}
          onClick={() => setTab('all')}>
          All Applications
        </button>
      </div>

      <div className="review-list">
        {shown.length ? shown.map(application => (
          <ApplicationCard
            key={application.id}
            application={application}
            account={accounts[application.id]}
            busy={busy}
            onApprove={onApprove}
            onReject={onReject}
          />
        )) : (
          <p className="card-copy">
            {tab === 'pending'
              ? 'Nothing waiting. New sign-ups appear here.'
              : 'No applications yet.'}
          </p>
        )}
      </div>
    </>
  );
}
