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
        <p className="eyebrow">10% service fee</p>
        <h1 id="console-title">Billing</h1>
        <p>
          {rows === null ? 'Loading…'
            : `${money(sales)} paid to shops through FurnishAR · ${money(outstanding)} in fees outstanding.`}
        </p>
      </section>

      {settling && (
        <form className="product-form order-quote" onSubmit={settle} aria-label={`Record a payment from ${settling.store_name}`}>
          <label>Amount received (₱)
            <input name="amount" type="number" min="0.01" step="0.01" required inputMode="decimal"
              defaultValue={Number(settling.outstanding) > 0 ? Number(settling.outstanding).toFixed(2) : ''} />
          </label>
          <label>Reference<input name="reference" maxLength={120} placeholder="GCash / PayPal ref…" /></label>
          <label>Note<input name="note" maxLength={500} placeholder="Optional…" /></label>
          <div className="order-actions">
            <button className="button button-primary" type="submit" disabled={busy}>{busy ? 'Saving…' : 'Record settlement'}</button>
            <button className="button" type="button" onClick={() => setSettling(null)}>Cancel</button>
          </div>
        </form>
      )}

      <PagedTable
        rows={list}
        colSpan={6}
        empty={rows === null ? 'Loading…' : 'No stores yet.'}
        head={<tr><th>Store</th><th>Type</th><th>Paid to shop</th><th>Fees accrued</th><th>Outstanding</th><th><span className="sr-only">Actions</span></th></tr>}
        renderRow={row => (
          <tr key={row.store_id}>
            <td>{row.store_name}</td>
            <td>{row.fulfilment === 'custom' ? 'Custom' : 'Stocked'}</td>
            <td>{money(row.sales)}</td>
            <td>{money(row.accrued)}</td>
            <td><b>{money(row.outstanding)}</b></td>
            <td>
              <button className="icon-button" type="button" onClick={() => setSettling(row)}>Record payment</button>
            </td>
          </tr>
        )}
      />
    </>
  );
}
