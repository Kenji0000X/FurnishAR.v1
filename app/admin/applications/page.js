'use client';

import { useState } from 'react';
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
  const [tab, setTab] = useState('pending');

  const shown = tab === 'pending'
    ? applications.filter(a => a.status === 'pending')
    : applications;

  return (
    <>
      <section className="admin-intro">
        <p className="eyebrow">Platform administration</p>
        <h1 id="console-title">Store applications</h1>
        <p>
          Check each applicant before approving. Approving creates their store and lets
          them publish furniture that shoppers will see.
        </p>
      </section>

      <div className="mode-switch" role="tablist" aria-label="Which applications to show">
        <button type="button" role="tab" aria-selected={tab === 'pending'}
          className={`mode-option${tab === 'pending' ? ' is-active' : ''}`}
          onClick={() => setTab('pending')}>
          Awaiting review
        </button>
        <button type="button" role="tab" aria-selected={tab === 'all'}
          className={`mode-option${tab === 'all' ? ' is-active' : ''}`}
          onClick={() => setTab('all')}>
          All applications
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
