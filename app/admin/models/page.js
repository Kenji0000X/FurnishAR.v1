'use client';

import { useAdmin } from '../AdminGate.js';
import PagedTable from '../PagedTable.js';
import { formatBytes, isOversized, timeAgo } from '../format.js';

/**
 * Every 3D file on the platform, and every listing missing one.
 *
 * Read-only on purpose. Removing or replacing a model is the owning shop's
 * job — this is here so an oversized or missing file can be noticed, not so
 * one shop's inventory can be edited from another.
 */
export default function AdminModels() {
  const { models, missingModels } = useAdmin();
  const totalBytes = models.reduce((sum, asset) => sum + (Number(asset.byte_size) || 0), 0);

  return (
    <>
      <section className="admin-intro">
        <p className="eyebrow">Uploaded Across Every Store</p>
        <h1 id="console-title">3D Files</h1>
        <p>
          {models.length} file{models.length === 1 ? '' : 's'}, {formatBytes(totalBytes)} in total.
        </p>
      </section>

      <PagedTable
        rows={models}
        colSpan={5}
        empty="Nothing uploaded yet."
        head={<tr><th>Store</th><th>Product</th><th>Kind</th><th>Size</th><th>Uploaded</th></tr>}
        renderRow={asset => (
          <tr key={asset.id}>
            <td>{asset.product?.store?.name || '—'}</td>
            <td>
              {asset.product?.name || '—'}
              {asset.product?.status !== 'published' && <small> ({asset.product?.status})</small>}
            </td>
            <td><code>{asset.kind}</code></td>
            <td className={isOversized(asset.byte_size) ? 'verification-warning' : undefined}>
              {formatBytes(asset.byte_size)}
            </td>
            <td><small>{timeAgo(asset.created_at)}</small></td>
          </tr>
        )}
      />

      {missingModels.length > 0 && (
        <section className="plan-section" aria-labelledby="missing-title">
          <div className="section-heading">
            <div>
              <p className="eyebrow">Can’t Be Placed in a Room</p>
              <h2 id="missing-title">Listings With No 3D Model</h2>
            </div>
          </div>
          <p className="card-copy verification-warning">
            {missingModels.length} listing{missingModels.length === 1 ? '' : 's'} with no 3D model
            attached — these cannot be placed in AR.
          </p>
          <PagedTable
            param="missing"
            rows={missingModels}
            colSpan={3}
            empty="None."
            head={<tr><th>Store</th><th>Product</th><th>Status</th></tr>}
            renderRow={product => (
              <tr key={product.id}>
                <td>{product.store?.name || '—'}</td>
                <td>{product.name}</td>
                <td>{product.status}</td>
              </tr>
            )}
          />
        </section>
      )}
    </>
  );
}
