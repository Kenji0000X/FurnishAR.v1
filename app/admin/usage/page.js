'use client';

import { useAdmin } from '../AdminGate.js';
import PagedTable from '../PagedTable.js';
import { StorageByStore } from '../AdminCharts.js';
import { formatBytes } from '../format.js';

/**
 * What the platform is spending against its storage plan.
 *
 * Bytes, not files: a per-file cap says nothing about the total the project's
 * storage plan actually bills or caps. Raising the per-file limit without
 * anywhere to watch the total would be the same mistake with worse timing — a
 * quota hit discovered by an owner's upload failing, not by anyone looking.
 */
export default function AdminUsage() {
  const { usage } = useAdmin();
  const total = usage.reduce((sum, row) => sum + (Number(row.total_bytes) || 0), 0);

  return (
    <>
      <section className="admin-intro">
        <p className="eyebrow">Against your storage plan</p>
        <h1 id="console-title">Usage by store</h1>
        <p>{formatBytes(total)} across {usage.length} store{usage.length === 1 ? '' : 's'}.</p>
      </section>

      <div className="chart-grid is-single">
        <StorageByStore usage={usage} />
      </div>

      <PagedTable
        rows={usage}
        colSpan={3}
        empty="No files uploaded yet."
        head={<tr><th>Store</th><th>Files</th><th>Storage used</th></tr>}
        renderRow={row => (
          <tr key={row.store_id}>
            <td>{row.store_name}</td>
            <td>{row.file_count}</td>
            <td>{formatBytes(row.total_bytes)}</td>
          </tr>
        )}
      />
    </>
  );
}
