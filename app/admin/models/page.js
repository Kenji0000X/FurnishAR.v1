'use client';

import { useCallback, useEffect, useState } from 'react';
import { useAdmin } from '../AdminGate.js';
import PagedTable from '../PagedTable.js';
import ConfirmDialog from '../../ConfirmDialog.js';
import useAlert from '../../alerts/useAlert.js';
import { supabase } from '../../portal/backend.js';
import { formatBytes, isOversized, timeAgo, spanOf } from '../format.js';

/**
 * Every 3D file on the platform, how recently it was used, and — once one
 * has gone unused for a full year — the one write an admin has over a shop's
 * files: deleting that stale model (0012).
 *
 * Nothing on this page works out the lifecycle. Last use, idle days and
 * eligibility come from admin_model_lifecycle(), the database's single copy
 * of the 365-day rule, and the delete is re-checked by the server, by
 * Storage and by the database at the moment it runs.
 *
 * Deleting a model never deletes the product: the listing, its dimensions
 * and its orders stay; it just can no longer be placed in a room.
 */

const HALF_YEAR = 182;
const FILTERS = [
  ['all', 'All'],
  ['active', 'Active'],
  ['unused', 'Unused 6+ months'],
  ['eligible', 'Eligible for cleanup'],
  ['missing', 'Missing model']
];

const bytes = value => (Number(value) > 0 ? formatBytes(value) : '0 B');

function statusOf(model) {
  if (model.eligible) return { label: 'Eligible for cleanup', tone: 'is-danger' };
  if (model.idle_days >= HALF_YEAR) return { label: `Unused ${spanOf(model.idle_days)}`, tone: 'is-warning' };
  if (!model.last_accessed_at) return { label: 'No use recorded yet', tone: '' };
  return { label: 'Active', tone: 'is-success' };
}

function lastUsedText(model) {
  const ago = model.idle_days < 1 ? 'today' : `${spanOf(model.idle_days)} ago`;
  return model.last_accessed_at ? ago.replace(/^t/, 'T') : `Never opened · uploaded ${ago}`;
}

export default function AdminModels() {
  const { missingModels, reload } = useAdmin();
  const alert = useAlert();
  const [models, setModels] = useState(null);   // null = loading, false = could not be read
  const [filter, setFilter] = useState('all');
  const [confirming, setConfirming] = useState(null);
  const [deleting, setDeleting] = useState(null);

  const load = useCallback(async () => {
    try {
      setModels(await supabase().listModelLifecycle());
    } catch {
      setModels(false);
    }
  }, []);
  useEffect(() => { load(); }, [load]);

  async function remove(model) {
    setConfirming(null);
    setDeleting(model.asset_id);
    try {
      await supabase().cleanupStaleModel(model.asset_id);
      alert.showSuccess('3D model deleted. The product stays listed without AR.');
    } catch (error) {
      // The server's words, which say what did and did not happen — "used
      // recently", or "nothing was removed", or a record still to clear.
      alert.showError(error.message || 'We couldn’t delete this model. Nothing else was removed.');
    }
    setDeleting(null);
    await Promise.all([load(), reload?.()].filter(Boolean));
  }

  const list = Array.isArray(models) ? models : [];
  const eligible = list.filter(model => model.eligible);
  const totals = {
    count: list.length,
    bytes: list.reduce((sum, model) => sum + (Number(model.byte_size) || 0), 0),
    eligible: eligible.length,
    reclaim: eligible.reduce((sum, model) => sum + (Number(model.byte_size) || 0), 0)
  };
  const shown = list.filter(model => (
    filter === 'all' ? true
      : filter === 'active' ? !model.eligible && model.idle_days < HALF_YEAR
        : filter === 'unused' ? !model.eligible && model.idle_days >= HALF_YEAR
          : filter === 'eligible' ? model.eligible
            : false
  ));

  return (
    <>
      <section className="admin-intro">
        <p className="eyebrow">Uploaded Across Every Store</p>
        <h1 id="console-title">3D Files</h1>
        <p>
          <b>Last used</b> is when FurnishAR last opened a model for anyone (a shopper, its shop or an
          administrator), or its upload if nobody has opened it since. A model can be deleted once it has gone
          unused for a full year. Nothing is deleted automatically.
        </p>
      </section>

      {models === false ? (
        <div className="bezel"><div className="bezel-core console-empty">
          <h3>The model list could not be loaded</h3>
          <p>Check your connection, then try again.</p>
          <button className="button" type="button" onClick={load}>Try Again</button>
        </div></div>
      ) : (
        <>
          <ul className="console-bento" aria-label="Model storage">
            {[
              ['3D Models', models === null ? '…' : totals.count, 'Files on the platform'],
              ['Storage Used', models === null ? '…' : bytes(totals.bytes), 'By those files'],
              ['Eligible for Cleanup', models === null ? '…' : totals.eligible, 'Unused for 365+ days'],
              ['Could Be Reclaimed', models === null ? '…' : bytes(totals.reclaim), totals.eligible ? 'If every eligible model were deleted' : 'Nothing eligible yet']
            ].map(([label, value, note]) => (
              <li key={label} className="console-tile bezel">
                <div className="bezel-core">
                  <p className="console-tile-label">{label}</p>
                  <p className="console-tile-value">{value}</p>
                  <p className="console-tile-note">{note}</p>
                </div>
              </li>
            ))}
          </ul>

          <div className="mode-switch" role="group" aria-label="Show">
            {FILTERS.map(([key, label]) => (
              <button key={key} type="button" className={`mode-option${filter === key ? ' is-active' : ''}`}
                aria-pressed={filter === key} onClick={() => setFilter(key)}>
                {label}
              </button>
            ))}
          </div>

          {filter === 'missing' ? (
            <PagedTable
              param="missing"
              rows={missingModels}
              colSpan={3}
              empty="Every listing has a 3D model."
              head={<tr><th>Store</th><th>Product</th><th>Status</th></tr>}
              renderRow={product => (
                <tr key={product.id}>
                  <td>{product.store?.name || '—'}</td>
                  <td>{product.name}</td>
                  <td>{product.status}</td>
                </tr>
              )}
            />
          ) : (
            <PagedTable
              rows={shown}
              colSpan={8}
              empty={models === null ? 'Loading…' : filter === 'eligible' ? 'No model has gone unused for a year.' : 'Nothing here.'}
              head={<tr>
                <th scope="col">Store</th><th scope="col">Product</th><th scope="col">Type</th><th scope="col">Size</th>
                <th scope="col">Uploaded</th><th scope="col">Last Used</th><th scope="col">Status</th>
                <th scope="col"><span className="sr-only">Actions</span></th>
              </tr>}
              renderRow={model => {
                const status = statusOf(model);
                return (
                  <tr key={model.asset_id}>
                    <td translate="no">{model.store_name}</td>
                    <td>
                      {model.product_name}
                      {model.product_status !== 'published' && <small> ({model.product_status})</small>}
                    </td>
                    <td><code>{model.kind}</code></td>
                    <td className={isOversized(model.byte_size) ? 'verification-warning' : undefined}>
                      {formatBytes(model.byte_size)}
                    </td>
                    <td><small>{timeAgo(model.uploaded_at)}</small></td>
                    <td>{lastUsedText(model)}</td>
                    <td><span className={`status-chip ${status.tone}`}>{status.label}</span></td>
                    <td>
                      {model.eligible ? (
                        <div className="table-actions">
                          <button className="button button-danger" type="button"
                            disabled={deleting === model.asset_id} aria-busy={deleting === model.asset_id || undefined}
                            onClick={() => setConfirming(model)}
                            aria-label={`Delete the 3D model of ${model.product_name}…`}>
                            {deleting === model.asset_id ? 'Deleting…' : 'Delete Model…'}
                          </button>
                          <small className="cleanup-frees">Frees {formatBytes(model.byte_size)}</small>
                        </div>
                      ) : (
                        <small>Delete available {new Date(model.eligible_on).toLocaleDateString('en-PH', { year: 'numeric', month: 'short', day: 'numeric' })}</small>
                      )}
                    </td>
                  </tr>
                );
              }}
            />
          )}
        </>
      )}

      {confirming && (
        <ConfirmDialog
          title="Delete this 3D model?"
          body={`${confirming.product_name} (${confirming.store_name}) has not used this model for ${spanOf(confirming.idle_days)}.`}
          confirmLabel="Delete Model"
          confirmPhrase="DELETE"
          onConfirm={() => remove(confirming)}
          onCancel={() => setConfirming(null)}
        >
          <ul className="confirm-facts">
            {confirming.product_status === 'published' && (
              <li>This product is currently published. Deleting the model removes its AR availability; the product stays listed.</li>
            )}
            <li>The product, its dimensions and its orders are not deleted.</li>
            <li>{formatBytes(confirming.byte_size)} of storage is freed{confirming.poster_path ? ', and the catalogue preview made from this model is removed too' : ''}.</li>
            <li>The shop can upload a new model at any time to restore AR.</li>
          </ul>
        </ConfirmDialog>
      )}
    </>
  );
}
