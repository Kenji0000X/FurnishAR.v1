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
 * GCash via PayMongo (0016) beside PayPal, in the same table: an admin
 * enables GCash for a store (buyers and stores never connect GCash). In
 * platform settlement FurnishAR's PayMongo account receives the payment: the
 * 10% is HELD (accrued, not "collected"), the store's share is OWED and paid
 * out here (record_store_remittance), and PayMongo's processing fee is shown
 * on its own. Split settlement is offered only when PAYMONGO_SPLIT_MODE=split;
 * its fee is EXPECTED until reconciled with PayMongo. GCash refunds go
 * through PayMongo's refund API (orders action "refund").
 * fee_overview(), record_fee_settlement(), admin_set_paymongo_account(),
 * record_store_remittance(), the refund action and /api/sb/payments/admin refuse
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
  const [provider, setProvider] = useState('all');    // table filter: all | paypal | gcash
  const [gcashFor, setGcashFor] = useState(null);     // the row whose GCash setup is open
  const [paying, setPaying] = useState(null);         // the row being paid out (GCash, platform settlement)
  const [refundsFor, setRefundsFor] = useState(null); // { row, payments } for GCash refunds
  const [paypalPayments, setPaypalPayments] = useState(null); // null = loading, false = unavailable

  const load = useCallback(async () => {
    const sb = supabase();
    const [overview, cfg, recent] = await Promise.all([
      sb.feeOverview().catch(error => { alert.showError(error.message); return []; }),
      sb.adminPaymentsConfig().catch(() => false),
      // store_portion / fee_status arrive with 0017; before it, the table says so.
      sb.recentPaypalPayments().catch(() => false)
    ]);
    setRows(overview);
    setConfig(cfg);
    setPaypalPayments(recent);
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

  async function saveGcash(event) {
    event.preventDefault();
    const v = Object.fromEntries(new FormData(event.currentTarget));
    const enabled = v.settlement !== 'off';
    setBusy(true);
    try {
      await supabase().setPaymongoAccount({
        storeUuid: gcashFor.store_id, environment: config?.paymongo?.environment || 'sandbox', enabled,
        settlement: enabled ? v.settlement : null, childMerchant: v.childMerchant
      });
      alert.showSuccess(enabled ? `GCash is set up for ${gcashFor.store_name}.` : `GCash is off for ${gcashFor.store_name}.`);
      setGcashFor(null);
      await load();
    } catch (error) {
      alert.showError(error.message);
    }
    setBusy(false);
  }

  async function openRefunds(row) {
    try {
      setRefundsFor({ row, payments: await supabase().storeGcashPayments(row.store_id) });
    } catch (error) {
      alert.showError(error.message);
    }
  }

  /** Refund through PayMongo; recorded when PayMongo reports it succeeded (here or by webhook). */
  async function refund(event) {
    event.preventDefault();
    const v = Object.fromEntries(new FormData(event.currentTarget));
    setBusy(true);
    try {
      const result = await supabase().orderAction('refund', { paymentId: v.paymentId, amount: v.amount, note: v.note });
      alert.showSuccess(result.status === 'succeeded'
        ? `Refunded through PayMongo (${result.refundId}).`
        : `PayMongo accepted the refund (${result.refundId}); it is recorded when PayMongo reports it succeeded.`);
      await openRefunds(refundsFor.row);
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
  const usesGcash = row => row.paymongo_status === 'CONNECTED' || Number(row.gcash_sales) > 0 || Number(row.owed_to_store) > 0;
  const usesPaypal = row => row.payment_status === 'CONNECTED' || Number(row.paypal_sales) > 0;
  const list = provider === 'gcash' ? all.filter(usesGcash) : provider === 'paypal' ? all.filter(usesPaypal) : all;
  const sum = key => all.reduce((total, row) => total + Number(row[key] || 0), 0);
  const gcashConfig = config?.paymongo;
  const split = config?.feeMode === 'platform_split';
  const splitAskedButOff = config?.feeModeConfigured === 'platform_split' && !split;
  const connected = all.filter(row => row.payment_status === 'CONNECTED').length;
  const gcashEnabled = all.filter(row => row.paymongo_status === 'CONNECTED').length;

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
              + (gcashConfig?.configured ? ` · ${gcashEnabled} set up for GCash.` : '.')}
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
          <p className="console-tile-label">GCash via PayMongo</p>
          <h2>
            {!config ? 'Checking…'
              : !gcashConfig?.configured ? 'Not configured'
              : gcashConfig.splitEnabled ? 'Configured · Split Payments available' : 'Configured · FurnishAR receives GCash payments'}
            {gcashConfig?.configured && gcashConfig.sandbox && <span className="status-chip is-sandbox" title="No real money moves">PayMongo Test Mode</span>}
          </h2>
          <p>
            {gcashConfig?.splitEnabled
              ? 'Stores set to split are paid their share by PayMongo Split Payments; FurnishAR’s 10% is expected until reconciled against PayMongo’s records, never counted as collected. Stores set to platform are paid into FurnishAR’s PayMongo account.'
              : `GCash payments are received by FurnishAR’s PayMongo account, less PayMongo’s processing fee. The 10% is held by FurnishAR (not “collected” from anyone) and each store’s share is owed to it, paid out and recorded below. Split Payments: ${gcashConfig?.splitMode || 'disabled'}.`}
          </p>
          {gcashConfig?.problems?.length > 0 && (
            <ul className="config-problems" aria-label="PayMongo configuration problems">
              {gcashConfig.problems.map(problem => <li key={problem}>{problem}</li>)}
            </ul>
          )}
          {gcashConfig?.warnings?.length > 0 && (
            <ul className="config-warnings" aria-label="PayMongo configuration warnings">
              {gcashConfig.warnings.map(warning => <li key={warning}>{warning}</li>)}
            </ul>
          )}
        </div>
      </div>

      <dl className="billing-summary">
        <div><dt>Accrued (Owed)</dt><dd>{money(sum('accrued'))}</dd></div>
        <div><dt>Collected</dt><dd>{money(sum('collected'))}</dd></div>
        {sum('held') > 0 && (
          <div><dt>Held from GCash Sales</dt><dd>{money(sum('held'))}</dd></div>
        )}
        {sum('expected_via_split') > 0 && (
          <div><dt>Expected via PayMongo Split</dt><dd>{money(sum('expected_via_split'))}</dd></div>
        )}
        {sum('processing_fees') > 0 && (
          <div><dt>PayMongo Processing Fees</dt><dd>{money(sum('processing_fees'))}</dd></div>
        )}
        <div><dt>Refunded to Buyers</dt><dd>{money(sum('refunded'))}</dd></div>
        <div><dt>Outstanding</dt><dd>{money(sum('outstanding'))}</dd></div>
        {(gcashConfig?.configured || sum('owed_to_store') > 0) && (
          <div><dt>Owed to Shops (GCash)</dt><dd>{money(sum('owed_to_store'))}</dd></div>
        )}
      </dl>

      <div className="mode-switch" role="group" aria-label="Payment method">
        {[['all', 'All'], ['paypal', 'PayPal'], ['gcash', 'GCash']].map(([id, label]) => (
          <button key={id} type="button" className={`mode-option${provider === id ? ' is-active' : ''}`}
            aria-pressed={provider === id} onClick={() => setProvider(id)}>{label}</button>
        ))}
      </div>

      {gcashFor && (
        <div className="bezel console-panel">
          <GcashForm row={gcashFor} busy={busy} split={Boolean(gcashConfig?.splitEnabled)} onSubmit={saveGcash} onCancel={() => setGcashFor(null)} />
        </div>
      )}

      {refundsFor && (
        <div className="bezel console-panel">
          <RefundForm row={refundsFor.row} payments={refundsFor.payments} busy={busy}
            onSubmit={refund} onCancel={() => setRefundsFor(null)} />
        </div>
      )}

      {paying && (
        <div className="bezel console-panel">
        <form className="bezel-core product-form order-quote" onSubmit={payOut} aria-label={`Record a payout to ${paying.store_name}`}>
          <p className="form-note">FurnishAR owes {paying.store_name} {money(paying.owed_to_store)} from GCash payments its PayMongo account received. PayMongo&rsquo;s processing fees are listed separately.</p>
          <label>Amount Paid Out (₱)
            <input name="amount" type="text" required inputMode="decimal" pattern="[0-9]+([.][0-9]{1,2})?"
              autoComplete="off" autoFocus
              defaultValue={Number(paying.owed_to_store) > 0 ? Number(paying.owed_to_store).toFixed(2) : ''} />
          </label>
          <label>Reference<input name="reference" maxLength={120} autoComplete="off" spellCheck={false} placeholder="Bank or GCash transfer reference…" /></label>
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
        colSpan={10}
        empty={rows === null ? 'Loading…' : provider === 'all' ? 'No stores yet.' : `No stores use ${provider === 'gcash' ? 'GCash' : 'PayPal'} yet.`}
        head={<tr>
          <th scope="col">Store</th><th scope="col">PayPal</th><th scope="col">GCash via PayMongo</th>
          <th scope="col" className="num">PayPal Sales</th><th scope="col" className="num">GCash Sales</th>
          <th scope="col" className="num">Accrued</th><th scope="col" className="num">Collected</th>
          <th scope="col" className="num">Held / Expected</th><th scope="col" className="num">Outstanding</th>
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
                <span className={`status-chip ${row.paymongo_status === 'CONNECTED' ? 'is-success' : ''}`}>
                  {row.paymongo_status === 'CONNECTED' ? (row.paymongo_settlement === 'split' ? 'Split' : 'FurnishAR receives') : 'Not set up'}
                </span>
                {Number(row.owed_to_store) > 0 && <><br /><small>Owed {money(row.owed_to_store)}</small></>}
                {Number(row.processing_fees) > 0 && <><br /><small>Processing fees {money(row.processing_fees)}</small></>}
              </td>
              <td className="num">{money(row.paypal_sales)}</td>
              <td className="num">{money(row.gcash_sales)}</td>
              <td className="num">{money(row.accrued)}</td>
              <td className="num">{money(row.collected)}</td>
              <td className="num">{money(Number(row.held || 0) + Number(row.expected_via_split || 0))}</td>
              <td className="num"><b>{money(row.outstanding)}</b></td>
              <td>
                <div className="table-actions">
                  <button className="icon-button" type="button" onClick={() => setSettling(row)}
                    aria-label={`Record a payment from ${row.store_name}`}>Record Payment…</button>
                  {gcashConfig?.configured && (
                    <button className="icon-button" type="button" onClick={() => setGcashFor(row)}
                      aria-label={`GCash setup for ${row.store_name}…`}>GCash…</button>
                  )}
                  {gcashConfig?.configured && Number(row.gcash_sales) > 0 && (
                    <button className="icon-button" type="button" onClick={() => openRefunds(row)}
                      aria-label={`GCash refunds for ${row.store_name}…`}>Refunds…</button>
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

      <PaypalPayments payments={paypalPayments} />

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
 * GCash for one store. Platform settlement needs nothing from the store: the
 * payment lands in FurnishAR's PayMongo account. Split needs the store's
 * PayMongo child-merchant id, exactly as PayMongo registered it under
 * FurnishAR, and is offered only when PAYMONGO_SPLIT_MODE=split.
 */
function GcashForm({ row, busy, split, onSubmit, onCancel }) {
  const [settlement, setSettlement] = useState(
    row.paymongo_status === 'CONNECTED' ? (row.paymongo_settlement || 'platform') : 'platform');
  return (
    <form className="bezel-core product-form order-quote" onSubmit={onSubmit} aria-label={`GCash setup for ${row.store_name}`}>
      <label>GCash for {row.store_name}
        <select name="settlement" value={settlement} onChange={event => setSettlement(event.target.value)}>
          <option value="platform">On — FurnishAR receives and pays the shop</option>
          {split && <option value="split">On — PayMongo splits to the shop&rsquo;s child merchant</option>}
          <option value="off">Off</option>
        </select>
      </label>
      {settlement === 'split' && (
        <label>PayMongo Child Merchant ID
          <input name="childMerchant" required maxLength={64} pattern="[A-Za-z0-9_-]+" autoComplete="off" spellCheck={false} />
        </label>
      )}
      <div className="order-actions">
        <button className="button button-primary" type="submit" disabled={busy} aria-busy={busy || undefined}>
          {busy && <span className="loading-spinner" aria-hidden="true" />}Save GCash Setup
        </button>
        <button className="button" type="button" onClick={onCancel}>Cancel</button>
      </div>
    </form>
  );
}

/**
 * Refund one GCash payment through PayMongo. The server re-checks that the
 * caller is a platform admin and that the amount is within what is left.
 */
function RefundForm({ row, payments, busy, onSubmit, onCancel }) {
  const refundable = payments.filter(p => Number(p.amount) - Number(p.refunded_amount || 0) > 0);
  const [paymentId, setPaymentId] = useState(refundable[0]?.capture_id || '');
  const chosen = refundable.find(p => p.capture_id === paymentId);
  const left = chosen ? Number(chosen.amount) - Number(chosen.refunded_amount || 0) : 0;
  if (!refundable.length) {
    return (
      <div className="bezel-core">
        <p className="form-note">{row.store_name} has no GCash payments left to refund.</p>
        <div className="order-actions"><button className="button" type="button" onClick={onCancel}>Close</button></div>
      </div>
    );
  }
  return (
    <form className="bezel-core product-form order-quote" onSubmit={onSubmit} aria-label={`Refund a GCash payment for ${row.store_name}`}>
      <label>GCash Payment
        <select name="paymentId" value={paymentId} onChange={event => setPaymentId(event.target.value)}>
          {refundable.map(p => (
            <option key={p.capture_id} value={p.capture_id}>
              {p.capture_id} · {p.stage} · {money(p.amount)}{Number(p.refunded_amount) > 0 ? ` (refunded ${money(p.refunded_amount)})` : ''}
            </option>
          ))}
        </select>
      </label>
      <label>Amount to Refund (₱)
        <input key={paymentId} name="amount" type="text" required inputMode="decimal" pattern="[0-9]+([.][0-9]{1,2})?"
          autoComplete="off" defaultValue={left > 0 ? left.toFixed(2) : ''} />
      </label>
      <label>Note<input name="note" maxLength={255} autoComplete="off" placeholder="Optional…" /></label>
      <p className="form-note">Sent to PayMongo. GCash refunds usually reach the buyer within the day; the order updates when PayMongo reports the refund succeeded.</p>
      <div className="order-actions">
        <button className="button button-primary" type="submit" disabled={busy} aria-busy={busy || undefined}>
          {busy && <span className="loading-spinner" aria-hidden="true" />}Refund through PayMongo
        </button>
        <button className="button" type="button" onClick={onCancel}>Cancel</button>
      </div>
    </form>
  );
}

const FEE_MODE = { platform_split: 'PayPal platform split', accrual: 'Accrual' };
const FEE_STATUS = { collected: 'Collected', accrued: 'Accrued', refunded: 'Refunded', none: '—' };

/**
 * Every PayPal payment with its split, as the database recorded it (0017):
 * what the buyer paid, the shop's portion, FurnishAR's fee, the fee mode and
 * the fee's real status. "Collected" only when PayPal reported taking the fee;
 * an accrued fee is owed by the shop and is never shown as received.
 */
function PaypalPayments({ payments }) {
  return (
    <section className="paypal-payments" aria-labelledby="paypal-payments-title">
      <h2 id="paypal-payments-title">PayPal payments</h2>
      <PagedTable
        rows={payments || []}
        colSpan={8}
        param="paypal"
        empty={payments === null ? 'Loading…'
          : payments === false ? 'Payment details need migration 0017.' : 'No PayPal payments yet.'}
        head={<tr>
          <th scope="col">Order</th><th scope="col">Store</th>
          <th scope="col" className="num">Gross Buyer Payment</th><th scope="col" className="num">Store Portion</th>
          <th scope="col" className="num">FurnishAR Fee</th><th scope="col">Fee Mode</th><th scope="col">Fee Status</th>
          <th scope="col">Captured</th>
        </tr>}
        renderRow={p => (
          <tr key={p.capture_id}>
            <td translate="no">{p.orders?.reference || '—'}<br /><small>{p.stage}{p.applied ? '' : ' · not applied'}</small></td>
            <td translate="no">{p.stores?.name || '—'}</td>
            <td className="num">{money(p.amount)}</td>
            <td className="num">{money(p.store_portion)}</td>
            <td className="num">{money(p.platform_fee)}</td>
            <td>{FEE_MODE[p.fee_mode] || p.fee_mode}</td>
            <td><span className={`status-chip ${p.fee_status === 'collected' ? 'is-success' : ''}`}>{FEE_STATUS[p.fee_status] || p.fee_status}</span>
              {p.processing_fee != null && <><br /><small>PayPal fee {money(p.processing_fee)} (shop's)</small></>}</td>
            <td>{p.captured_at ? new Date(p.captured_at).toLocaleDateString('en-PH', { dateStyle: 'medium' }) : '—'}</td>
          </tr>
        )}
      />
    </section>
  );
}
