'use client';

import { useAdmin } from '../AdminGate.js';
import PagedTable from '../PagedTable.js';
import { timeAgo } from '../format.js';

export default function AdminActivity() {
  const { audit } = useAdmin();

  return (
    <>
      <section className="admin-intro">
        <p className="eyebrow">Every Decision, Recorded</p>
        <h1 id="console-title">Activity</h1>
        <p>
          Who approved or rejected which application, and when. Written by the database
          as part of the same transaction as the decision, so it cannot disagree with it.
        </p>
      </section>

      <PagedTable
        rows={audit}
        colSpan={3}
        empty="No decisions recorded yet."
        head={<tr><th>When</th><th>Who</th><th>What</th></tr>}
        renderRow={entry => (
          <tr key={entry.id}>
            <td><small>{timeAgo(entry.at)}</small></td>
            <td>{entry.actor_email || '—'}</td>
            <td>
              {entry.action.replace('application.', '')}
              <small>{entry.detail?.store_name || ''}</small>
            </td>
          </tr>
        )}
      />
    </>
  );
}
