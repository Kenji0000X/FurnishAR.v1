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
 * Maya (0015) beside PayPal, in the same table: an admin enables Maya for a
 * store (there is no self-service Maya onboarding), and with platform
 * collect FurnishAR's Maya account receives the payment and OWES the store
 * its share, paid out and recorded here (record_store_remittance).
 * fee_overview(), record_fee_settlement(), admin_set_maya_account(),
 * record_store_remittance() and /api/sb/payments/admin refuse
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
  const [provider, setProvider] = useState('all');    // table filter: all | paypal | maya
  const [mayaFor, setMayaFor] = useState(null);       // the row whose Maya setup is open
  const [paying, setPaying] = useState(null);         // the row being paid out (Maya platform collect)

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

  async function saveMaya(event) {
    event.preventDefault();
    const v = Object.fromEntries(new FormData(event.currentTarget));
    const enabled = v.settlement !== 'off';
    setBusy(true);
    try {
      await supabase().setMayaAccount({
        storeUuid: mayaFor.store_id, environment: config?.maya?.environment || 'sandbox', enabled,
        settlement: enabled ? v.settlement : null, submerchant: v.submerchant, city: v.city, postal: v.postal
      });
      alert.showSuccess(enabled ? `Maya is set up for ${mayaFor.store_name}.` : `Maya is off for ${mayaFor.store_name}.`);
      setMayaFor(null);
      await load();
    } catch (error) {
      alert.showError(error.message);
    }
    setBusy(false);
  }

  async function payOut(event) {
    event.preventDefault();
    const v = Object.fromEntries(new FormData(event.currentTarget));
    setBusy(true);
    try {
      await supabase().recordStoreRemittance({ storeUuid: paying.store_id, amount: v.amount, reference: v.reference, note: v.note });
      alert.showSuccess(`Recorded a ${money(v.amount)} payout to ${paying.store_name}.`);
      setPaying(null);
      await load();
    } catch (error) {
      alert.showError(error.message);
    }
    setBusy(false);
  }

  const all = rows || [];
  const usesMaya = row => row.maya_status === 'CONNECTED' || Number(row.maya_sales) > 0 || Number(row.owed_to_store) > 0;
  const usesPaypal = row => row.payment_status === 'CONNECTED' || Number(row.paypal_sales) > 0;
  const list = provider === 'maya' ? all.filter(usesMaya) : provider === 'paypal' ? all.filter(usesPaypal) : all;
  const sum = key => all.reduce((total, row) => total + Number(row[key] || 0), 0);
  const mayaConfig = config?.maya;
  const split = config?.feeMode === 'platform_split';
  const splitAskedButOff = config?.feeModeConfigured === 'platform_split' && !split;
  const connected = all.filter(row => row.payment_status === 'CONNECTED').length;
  const mayaEnabled = all.filter(row => row.maya_status === 'CONNECTED').length;

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
            : `${money(sum('sales'))} in sales · ${connected} of ${all.length} shops connected to PayPal`
              + (mayaConfig?.configured ? ` · ${mayaEnabled} set up for Maya.` : '.')}
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

      <div className="bezel console-panel fee-mode">
        <div className="bezel-core">
          <p className="console-tile-label">Maya</p>
          <h2>
            {!config ? 'Checking…'
              : !mayaConfig?.configured ? 'Not configured'
              : mayaConfig.payfac ? 'Configured · Payment Facilitator enabled' : 'Configured · FurnishAR collects'}
            {mayaConfig?.configured && mayaConfig.sandbox && <span className="status-chip is-sandbox" title="No real money moves">Maya Sandbox</span>}
          </h2>
          <p>
            {mayaConfig?.payfac
              ? `Stores set to PayFac are settled by Maya to their sub-merchant; the fee is ${mayaConfig.payfacFeeMode === 'provider_settlement' ? 'expected via Maya’s settlement (never counted as collected until reconciled)' : 'owed by the store (accrual)'}. Stores set to platform collect are paid into FurnishAR’s Maya account.`
              : 'Maya payments are received by FurnishAR’s Maya account. FurnishAR keeps the 10% and owes each store its share, paid out and recorded below. Payment Facilitator is not enabled (MAYA_PAYFAC_ENABLED).'}
          </p>
          {mayaConfig?.problems?.length > 0 && (
            <ul className="config-problems" aria-label="Maya configuration problems">
              {mayaConfig.problems.map(problem => <li key={problem}>{problem}</li>)}
            </ul>
          )}
          {mayaConfig?.warnings?.length > 0 && (
            <ul className="config-warnings" aria-label="Maya configuration warnings">
              {mayaConfig.warnings.map(warning => <li key={warning}>{warning}</li>)}
            </ul>
          )}
        </div>
      </div>

      <dl className="billing-summary">
        <div><dt>Accrued (Owed)</dt><dd>{money(sum('accrued'))}</dd></div>
        <div><dt>Collected</dt><dd>{money(sum('collected'))}</dd></div>
        {sum('expected_via_settlement') > 0 && (
          <div><dt>Expected via Maya Settlement</dt><dd>{money(sum('expected_via_settlement'))}</dd></div>
        )}
        <div><dt>Refunded to Buyers</dt><dd>{money(sum('refunded'))}</dd></div>
        <div><dt>Outstanding</dt><dd>{money(sum('outstanding'))}</dd></div>
        {(mayaConfig?.configured || sum('owed_to_store') > 0) && (
          <div><dt>Owed to Shops (Maya)</dt><dd>{money(sum('owed_to_store'))}</dd></div>
        )}
      </dl>

      <div className="mode-switch" role="group" aria-label="Payment method">
        {[['all', 'All Stores'], ['paypal', 'PayPal'], ['maya', 'Maya']].map(([id, label]) => (
          <button key={id} type="button" className={`mode-option${provider === id ? ' is-active' : ''}`}
            aria-pressed={provider === id} onClick={() => setProvider(id)}>{label}</button>
        ))}
      </div>

      {mayaFor && (
        <div className="bezel console-panel">
          <MayaForm row={mayaFor} busy={busy} payfac={Boolean(mayaConfig?.payfac)} onSubmit={saveMaya} onCancel={() => setMayaFor(null)} />
        </div>
      )}

      {paying && (
        <div className="bezel console-panel">
        <form className="bezel-core product-form order-quote" onSubmit={payOut} aria-label={`Record a payout to ${paying.store_name}`}>
          <p className="form-note">FurnishAR owes {paying.store_name} {money(paying.owed_to_store)} from Maya payments it received.</p>
          <label>Amount Paid Out (₱)
            <input name="amount" type="text" required inputMode="decimal" pattern="[0-9]+([.][0-9]{1,2})?"
              autoComplete="off" autoFocus
              defaultValue={Number(paying.owed_to_store) > 0 ? Number(paying.owed_to_store).toFixed(2) : ''} />
          </label>
          <label>Reference<input name="reference" maxLength={120} autoComplete="off" spellCheck={false} placeholder="Bank or Maya transfer reference…" /></label>
          <label>Note<input name="note" maxLength={500} autoComplete="off" placeholder="Optional…" /></label>
          <div className="order-actions">
            <button className="button button-primary" type="submit" disabled={busy} aria-busy={busy || undefined}>
              {busy && <span className="loading-spinner" aria-hidden="true" />}Record Payout
            </button>
            <button className="button" type="button" onClick={() => setPaying(null)}>Cancel</button>
          </div>
        </form>
        </div>
      )}

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
        colSpan={8}
        empty={rows === null ? 'Loading…' : provider === 'all' ? 'No stores yet.' : `No stores use ${provider === 'maya' ? 'Maya' : 'PayPal'} yet.`}
        head={<tr>
          <th scope="col">Store</th><th scope="col">PayPal</th><th scope="col">Maya</th>
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
              <td>
                <span className={`status-chip ${row.maya_status === 'CONNECTED' ? 'is-success' : ''}`}>
                  {row.maya_status === 'CONNECTED' ? (row.maya_settlement === 'payfac' ? 'PayFac' : 'FurnishAR collects') : 'Not set up'}
                </span>
                {Number(row.owed_to_store) > 0 && <><br /><small>Owed {money(row.owed_to_store)}</small></>}
              </td>
              <td className="num">{money(row.sales)}</td>
              <td className="num">{money(row.accrued)}</td>
              <td className="num">{money(row.collected)}</td>
              <td className="num"><b>{money(row.outstanding)}</b></td>
              <td>
                <div className="table-actions">
                  <button className="icon-button" type="button" onClick={() => setSettling(row)}
                    aria-label={`Record a payment from ${row.store_name}`}>Record Payment…</button>
                  {mayaConfig?.configured && (
                    <button className="icon-button" type="button" onClick={() => setMayaFor(row)}
                      aria-label={`Maya setup for ${row.store_name}…`}>Maya…</button>
                  )}
                  {Number(row.owed_to_store) > 0 && (
                    <button className="icon-button" type="button" onClick={() => setPaying(row)}
                      aria-label={`Record a payout to ${row.store_name}…`}>Record Payout…</button>
                  )}
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

/**
 * Maya for one store. Platform collect needs nothing from the store: the
 * payment lands in FurnishAR's Maya account. PayFac needs the sub-merchant id,
 * city and postal code exactly as Maya registered them, and is offered only
 * once Maya has enabled Payment Facilitator for FurnishAR.
 */
function MayaForm({ row, busy, payfac, onSubmit, onCancel }) {
  const [settlement, setSettlement] = useState(
    row.maya_status === 'CONNECTED' ? (row.maya_settlement || 'platform_collect') : 'platform_collect');
  return (
    <form className="bezel-core product-form order-quote" onSubmit={onSubmit} aria-label={`Maya setup for ${row.store_name}`}>
      <label>Maya for {row.store_name}
        <select name="settlement" value={settlement} onChange={event => setSettlement(event.target.value)}>
          <option value="platform_collect">On — FurnishAR collects and pays the shop</option>
          {payfac && <option value="payfac">On — Maya settles to the shop (PayFac)</option>}
          <option value="off">Off</option>
        </select>
      </label>
      {settlement === 'payfac' && (
        <>
          <label>Sub-merchant ID<input name="submerchant" required maxLength={64} autoComplete="off" spellCheck={false} /></label>
          <label>City<input name="city" required maxLength={60} autoComplete="off" /></label>
          <label>Postal Code<input name="postal" required inputMode="numeric" pattern="[0-9]{4}" maxLength={4} autoComplete="off" /></label>
        </>
      )}
      <div className="order-actions">
        <button className="button button-primary" type="submit" disabled={busy} aria-busy={busy || undefined}>
          {busy && <span className="loading-spinner" aria-hidden="true" />}Save Maya Setup
        </button>
        <button className="button" type="button" onClick={onCancel}>Cancel</button>
      </div>
    </form>
  );
}
