'use client';

import { useCallback, useEffect, useState } from 'react';
import { supabase } from '../../portal/backend.js';
import useAlert from '../../alerts/useAlert.js';
import PagedTable from '../PagedTable.js';
import ConfirmDialog from '../../ConfirmDialog.js';
import { money } from '../../billing/OrderCard.js';
import { describeStatus } from '../../billing/payment-status.mjs';

/**
 * The platform's 10% and every shop's PayPal connection.    DFD: P8 → D5
 *
 * Says truthfully which fee mode is in force:
 *   accrual         buyers pay shops in full; the fee is owed and settled here;
 *   platform_split  PayPal takes the fee at capture — counted as COLLECTED
 *                   only when PayPal's capture breakdown reported it. Any
 *                   payment where it did not (seller without the partner-fee
 *                   permission, older payments) still accrues.
 * fee_overview(), record_fee_settlement() and /api/sb/payments/admin refuse
 * anyone who is not a platform admin; this page being behind the console
 * gate is the convenience, not the protection.
 */
export default function AdminBilling() {
  const alert = useAlert();
  const [rows, setRows] = useState(null);
  const [config, setConfig] = useState(null);   // null = loading, false = could not be read
  const [settling, setSettling] = useState(null);
  const [busy, setBusy] = useState(false);
  const [unlinking, setUnlinking] = useState(null);   // the row awaiting confirmation

  const load = useCallback(async () => {
    const sb = supabase();
    const [overview, cfg] = await Promise.all([
      sb.feeOverview().catch(error => { alert.showError(error.message); return []; }),
      sb.adminPaymentsConfig().catch(() => false)
    ]);
    setRows(overview);
    setConfig(cfg);
  }, [alert]);

  useEffect(() => { load(); }, [load]);

  /**
   * Disconnect a shop's PayPal account: its online checkout closes at once.
   * Confirmed in a real dialog (BRAND §9) rather than window.confirm, which a
   * browser can be told to stop showing.
   */
  async function disconnect(row) {
    setUnlinking(null);
    try {
      await supabase().paymentsAction('admin-unlink', { storeId: row.store_id });
      alert.showSuccess(`${row.store_name} is disconnected from PayPal.`);
      await load();
    } catch (error) {
      alert.showError(error.message);
    }
  }

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
  const sum = key => list.reduce((total, row) => total + Number(row[key] || 0), 0);
  const split = config?.feeMode === 'platform_split';
  const splitAskedButOff = config?.feeModeConfigured === 'platform_split' && !split;
  const connected = list.filter(row => row.payment_status === 'CONNECTED').length;

  return (
    <>
      <section className="admin-intro">
        <p className="eyebrow">10% Service Fee</p>
        <h1 id="console-title">
          Billing
          {config?.sandbox && <span className="status-chip is-sandbox" title="No real money moves">PayPal Sandbox</span>}
        </h1>
        <p>
          {rows === null ? 'Loading…'
            : `${money(sum('sales'))} paid to shops · ${connected} of ${list.length} shops connected to PayPal.`}
        </p>
      </section>

      <div className="bezel console-panel fee-mode">
        <div className="bezel-core">
          <p className="console-tile-label">Fee mode in force</p>
          <h2>{config ? (split ? 'Platform split through PayPal' : 'Accrual — shops settle the fee')
            : config === false ? 'Could not read the PayPal configuration' : 'Checking…'}</h2>
          <p>
            {split
              ? 'PayPal takes the 10% at capture from shops that granted FurnishAR the partner-fee permission. It is counted as collected only when PayPal reports it. Payments without it accrue and are settled below.'
              : 'Buyers pay the shop in full (price + 10%). The 10% is owed by the shop and recorded here when it is settled. Nothing is split by PayPal.'}
          </p>
          {splitAskedButOff && (
            <p className="form-error" role="status">PAYPAL_FEE_MODE is platform_split, but the partner settings are incomplete, so no split is attempted.</p>
          )}
          {config?.problems?.length > 0 && (
            <ul className="config-problems" aria-label="PayPal configuration problems">
              {config.problems.map(problem => <li key={problem}>{problem}</li>)}
            </ul>
          )}
          {config?.warnings?.length > 0 && (
            <ul className="config-warnings" aria-label="PayPal configuration warnings">
              {config.warnings.map(warning => <li key={warning}>{warning}</li>)}
            </ul>
          )}
        </div>
      </div>

      <dl className="billing-summary">
        <div><dt>Accrued (Owed)</dt><dd>{money(sum('accrued'))}</dd></div>
        <div><dt>Collected by PayPal</dt><dd>{money(sum('collected'))}</dd></div>
        <div><dt>Refunded to Buyers</dt><dd>{money(sum('refunded'))}</dd></div>
        <div><dt>Outstanding</dt><dd>{money(sum('outstanding'))}</dd></div>
      </dl>

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
        colSpan={7}
        empty={rows === null ? 'Loading…' : 'No stores yet.'}
        head={<tr>
          <th scope="col">Store</th><th scope="col">PayPal</th>
          <th scope="col" className="num">Paid to Shop</th><th scope="col" className="num">Accrued</th>
          <th scope="col" className="num">Collected</th><th scope="col" className="num">Outstanding</th>
          <th><span className="sr-only">Actions</span></th>
        </tr>}
        renderRow={row => {
          const status = describeStatus(row.payment_status);
          return (
            <tr key={row.store_id}>
              <td translate="no">{row.store_name}<br /><small>{row.fulfilment === 'custom' ? 'Custom' : 'Stocked'}</small></td>
              <td>
                <span className={`status-chip is-${status.tone}`}>{status.label}</span>
                {row.merchant_id_masked && <><br /><small translate="no">{row.merchant_id_masked}{row.payment_environment === 'sandbox' ? ' · sandbox' : ''}</small></>}
              </td>
              <td className="num">{money(row.sales)}</td>
              <td className="num">{money(row.accrued)}</td>
              <td className="num">{money(row.collected)}</td>
              <td className="num"><b>{money(row.outstanding)}</b></td>
              <td>
                <div className="table-actions">
                  <button className="icon-button" type="button" onClick={() => setSettling(row)}
                    aria-label={`Record a payment from ${row.store_name}`}>Record Payment…</button>
                  {row.payment_status === 'CONNECTED' && (
                    <button className="icon-button delete" type="button" onClick={() => setUnlinking(row)}
                      aria-label={`Disconnect ${row.store_name} from PayPal…`}>Disconnect…</button>
                  )}
                </div>
              </td>
            </tr>
          );
        }}
      />

      {unlinking && (
        <ConfirmDialog
          title={`Disconnect ${unlinking.store_name} from PayPal?`}
          body="Buyers won’t be able to pay this shop online until it connects a PayPal account again. Payments already made are not affected."
          confirmLabel="Disconnect PayPal"
          onConfirm={() => disconnect(unlinking)}
          onCancel={() => setUnlinking(null)}
        />
      )}
    </>
  );
}
