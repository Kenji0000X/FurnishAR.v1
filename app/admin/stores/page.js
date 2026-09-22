'use client';

import { useAdmin } from '../AdminGate.js';
import PagedTable from '../PagedTable.js';

export default function AdminStores() {
  const { stores } = useAdmin();

  return (
    <>
      <section className="admin-intro">
        <p className="eyebrow">Registered</p>
        <h1 id="console-title">Stores</h1>
        <p>Every shop approved to list furniture, and the address its catalogue lives at.</p>
      </section>

      <PagedTable
        rows={stores}
        colSpan={4}
        empty="No stores yet."
        head={<tr><th>Store</th><th>Address</th><th>Plan</th><th>Status</th></tr>}
        renderRow={store => (
          <tr key={store.id}>
            <td>{store.name}</td>
            <td><code>/{store.slug}</code></td>
            <td>{store.plan}</td>
            <td>{store.status}</td>
          </tr>
        )}
      />
    </>
  );
}
