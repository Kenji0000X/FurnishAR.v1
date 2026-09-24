'use client';

import { useCallback, useEffect, useState } from 'react';
import { supabase } from '../../portal/backend.js';
import useAlert from '../../alerts/useAlert.js';
import PagedTable from '../PagedTable.js';
import { money } from '../../billing/OrderCard.js';

/**
 * What each shop owes FurnishAR.                           DFD: P8 → D5
 *
 * Buyers pay shops directly, so the 10% service fee is not collected at
 * checkout — it accrues per captured payment (0009) and is settled here when
 * the shop pays it. fee_overview() and record_fee_settlement() refuse anyone
 * who is not a platform admin; this page being behind the console gate is
 * the convenience, not the protection.
 */
export default function AdminBilling() {
  const alert = useAlert();
  const [rows, setRows] = useState(null);
  const [settling, setSettling] = useState(null);
  const [busy, setBusy] = useState(false);

  const load = useCallback(async () => {
    try {
      setRows(await supabase().feeOverview());
    } catch (error) {
      setRows([]);
      alert.showError(error.message);
    }
  }, [alert]);

  useEffect(() => { load(); }, [load]);

  async function settle(event) {
    event.preventDefault();
    const v = Object.fromEntries(new FormData(event.currentTarget));
    setBusy(true);
    try {
      await supabase().recordFeeSettlement({ storeUuid: settling.store_id, amount: v.amount, reference: v.reference, note: v.note });
      alert.showSuccess(`Recorded ${money(v.amount)} from ${settling.store_name}.`);
      setSettling(null);
      await load();
    } catch (error) {
      alert.showError(error.message);
    }
    setBusy(false);
  }

  const list = rows || [];
  const outstanding = list.reduce((sum, row) => sum + Number(row.outstanding || 0), 0);
  const sales = list.reduce((sum, row) => sum + Number(row.sales || 0), 0);

  return (
    <>
      <section className="admin-intro">
        <p className="eyebrow">10% Service Fee</p>
        <h1 id="console-title">Billing</h1>
        <p>
          {rows === null ? 'Loading…'
            : `${money(sales)} paid to shops through FurnishAR · ${money(outstanding)} in fees outstanding.`}
        </p>
      </section>

      {settling && (
        <div className="bezel console-panel">
        <form className="bezel-core product-form order-quote" onSubmit={settle} aria-label={`Record a payment from ${settling.store_name}`}>
          <label>Amount Received (₱)
            <input name="amount" type="text" required inputMode="decimal" pattern="[0-9]+([.][0-9]{1,2})?"
              autoComplete="off" autoFocus
              defaultValue={Number(settling.outstanding) > 0 ? Number(settling.outstanding).toFixed(2) : ''} />
          </label>
          <label>Reference<input name="reference" maxLength={120} autoComplete="off" spellCheck={false} placeholder="GCash or PayPal reference…" /></label>
          <label>Note<input name="note" maxLength={500} autoComplete="off" placeholder="Optional…" /></label>
          <div className="order-actions">
            <button className="button button-primary" type="submit" disabled={busy} aria-busy={busy || undefined}>
              {busy && <span className="loading-spinner" aria-hidden="true" />}Record Settlement
            </button>
            <button className="button" type="button" onClick={() => setSettling(null)}>Cancel</button>
          </div>
        </form>
        </div>
      )}

      <PagedTable
        rows={list}
        colSpan={6}
        empty={rows === null ? 'Loading…' : 'No stores yet.'}
        head={<tr><th scope="col">Store</th><th scope="col">Type</th><th scope="col" className="num">Paid to Shop</th><th scope="col" className="num">Fees Accrued</th><th scope="col" className="num">Outstanding</th><th><span className="sr-only">Actions</span></th></tr>}
        renderRow={row => (
          <tr key={row.store_id}>
            <td translate="no">{row.store_name}</td>
            <td>{row.fulfilment === 'custom' ? 'Custom' : 'Stocked'}</td>
            <td className="num">{money(row.sales)}</td>
            <td className="num">{money(row.accrued)}</td>
            <td className="num"><b>{money(row.outstanding)}</b></td>
            <td>
              <button className="icon-button" type="button" onClick={() => setSettling(row)}
                aria-label={`Record a payment from ${row.store_name}`}>Record Payment…</button>
            </td>
          </tr>
        )}
      />
    </>
  );
}
