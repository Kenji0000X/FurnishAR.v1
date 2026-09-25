'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import { supabase } from '../portal/backend.js';
import useAlert from '../alerts/useAlert.js';
import { ConsoleSection } from '../console/ConsoleShell.js';
import OrderCard, { money } from './OrderCard.js';
import ConfirmDialog from '../ConfirmDialog.js';
import { describeStatus, maskMerchantId, currentAccount } from './payment-status.mjs';

/**
 * A store's incoming orders, its billing settings and its fee balance.
 *                                                             DFD: P7 → P10
 *
 * The owner chooses what kind of shop this is — selling from stock, or
 * building to order — and connects the PayPal SELLER account buyers pay
 * (Partner Referrals, 0011). The status shown is what PayPal told the
 * server, never what this page assumes. FurnishAR's 10% is either taken by
 * PayPal at capture (platform_split, only when PayPal reports it) or owed
 * and settled separately (accrual) — the page says which.
 *
 * Every button reflects the request it started (spinner, same label), and
 * declining a request — the one thing here a buyer is told about and cannot
 * be undone — asks first, in a real dialog.
 */
const CLOSED = ['fulfilled', 'declined', 'cancelled', 'expired'];

export default function StoreOrders({ storeUuid, onOpenCount, onPaymentStatus }) {
  const alert = useAlert();
  const [billing, setBilling] = useState(undefined);   // undefined = loading, null = failed
  const [config, setConfig] = useState(null);           // /api/sb/orders/config (no secrets)
  const [paypalBusy, setPaypalBusy] = useState('');     // 'connect' | 'refresh'
  const [orders, setOrders] = useState(null);
  const [busy, setBusy] = useState('');                 // `${orderId}:${action}` or 'settings'
  const [quoting, setQuoting] = useState(null);
  const [declining, setDeclining] = useState(null);
  const [dirty, setDirty] = useState(false);
  const [confirmUnlink, setConfirmUnlink] = useState(false);

  const load = useCallback(async () => {
    const sb = supabase();
    const [settings, list, cfg] = await Promise.all([
      sb.storeBilling(storeUuid).catch(() => null),
      sb.listStoreOrders(storeUuid).catch(() => null),
      sb.billingConfig()
    ]);
    setBilling(settings);
    setOrders(list);
    setConfig(cfg);
  }, [storeUuid]);

  useEffect(() => { load(); }, [load]);

  const account = billing ? currentAccount(billing.paymentAccounts, config?.environment || 'sandbox') : null;
  useEffect(() => { if (account) onPaymentStatus?.(account.onboarding_status); }, [account?.onboarding_status, onPaymentStatus]); // eslint-disable-line react-hooks/exhaustive-deps

  const refreshPaypal = useCallback(async ({ quiet = false } = {}) => {
    setPaypalBusy('refresh');
    try {
      const result = await supabase().paymentsAction('refresh', { storeId: storeUuid });
      if (!quiet || result.ready) {
        if (result.ready) alert.showSuccess('PayPal is connected. Buyers can pay you online.');
        else alert.showInfo(describeStatus(result.status).help);
      }
      await load();
    } catch (error) {
      alert.showError(error.message);
    }
    setPaypalBusy('');
  }, [storeUuid, alert, load]);

  /* Back from PayPal's onboarding page: ask the server to read the status
     from PayPal. The query string PayPal added is not trusted for anything. */
  useEffect(() => {
    const query = new URLSearchParams(window.location.search);
    if (query.get('paypal_onboarding') !== 'return') return;
    window.history.replaceState(null, '', `/portal${window.location.hash || '#billing'}`);
    refreshPaypal();
  }, [refreshPaypal]);

  /** Merchant-ID mode: PayPal checks the id; only then is the store connected. */
  async function linkPaypal(merchantId) {
    setPaypalBusy('link');
    try {
      await supabase().paymentsAction('link', { storeId: storeUuid, merchantId });
      alert.showSuccess('PayPal accepted your Merchant ID. Buyers can now pay you online.');
      await load();
    } catch (error) {
      alert.showError(error.message);
      await load();
    }
    setPaypalBusy('');
  }

  // Asked in a real dialog (BRAND §9), never window.confirm: a browser can
  // be told to stop showing those, and this one closes the shop's checkout.
  async function unlinkPaypal() {
    setConfirmUnlink(false);
    setPaypalBusy('unlink');
    try {
      await supabase().paymentsAction('unlink', { storeId: storeUuid });
      alert.showSuccess('PayPal disconnected. Online checkout is closed for your shop.');
      await load();
    } catch (error) {
      alert.showError(error.message);
    }
    setPaypalBusy('');
  }

  async function connectPaypal() {
    setPaypalBusy('connect');
    try {
      const { actionUrl } = await supabase().paymentsAction('connect', { storeId: storeUuid });
      // PayPal's own page: the owner signs in there, never here.
      window.location.assign(actionUrl);
    } catch (error) {
      alert.showError(error.message);
      setPaypalBusy('');
    }
  }

  const open = (orders || []).filter(o => !CLOSED.includes(o.status));
  const past = (orders || []).filter(o => CLOSED.includes(o.status));
  useEffect(() => { onOpenCount?.(open.length); }, [open.length, onOpenCount]);

  /* Unsaved billing changes: ask before the page is left. */
  useEffect(() => {
    if (!dirty) return undefined;
    const warn = event => { event.preventDefault(); event.returnValue = ''; };
    window.addEventListener('beforeunload', warn);
    return () => window.removeEventListener('beforeunload', warn);
  }, [dirty]);

  async function saveSettings(event) {
    event.preventDefault();
    const values = Object.fromEntries(new FormData(event.currentTarget));
    setBusy('settings');
    try {
      await supabase().orderAction('store-billing', {
        storeId: storeUuid,
        fulfilment: values.fulfilment,
        paypalEmail: String(values.paypalEmail || '').trim(),
        notifyEmail: String(values.notifyEmail || '').trim(),
        deliveryDays: Number(values.deliveryDays),
        pickupDays: Number(values.pickupDays)
      });
      setDirty(false);
      alert.showSuccess('Billing settings saved.');
      await load();
    } catch (error) {
      alert.showError(error.message);
    }
    setBusy('');
  }

  async function act(order, action, extra = {}) {
    const key = `${order.id}:${action}:${extra.status || ''}`;
    setBusy(key);
    try {
      await supabase().orderAction(action, { orderId: order.id, ...extra });
      const said = action === 'delivery' ? {
        out_for_delivery: `${order.reference} is out for delivery. The buyer can follow it in their orders.`,
        ready_for_pickup: `${order.reference} is ready for pickup. The buyer can see it in their orders.`,
        delivered: `${order.reference} marked ${order.fulfilment_method === 'pickup' ? 'picked up' : 'delivered'}.`
      }[extra.status] : {
        quote: `Quote sent for ${order.reference}.`,
        decline: `Request ${order.reference} declined.`,
        ready: `${order.reference} marked ready. The buyer is asked for the balance.`
      }[action];
      alert.showSuccess(said);
      setQuoting(null);
      setDeclining(null);
      await load();
    } catch (error) {
      alert.showError(error.message);
    }
    setBusy('');
  }

  const isBusy = (order, action, status = '') => busy === `${order.id}:${action}:${status}`;
  const Spin = ({ on }) => (on ? <span className="loading-spinner" aria-hidden="true" /> : null);

  /* One order, with the actions its state allows. Open orders are listed
     first; closed ones sit behind "Past orders" so history never buries work. */
  const renderOrder = order => (
    <OrderCard key={order.id} order={order} perspective="store">
      <div className="order-actions">
        {['requested', 'quoted'].includes(order.status) && (
          <>
            <button className="button button-primary" type="button" onClick={() => setQuoting(order.id)}
              aria-expanded={quoting === order.id}>
              {order.status === 'quoted' ? 'Revise Quote…' : 'Send Quote…'}
            </button>
            <button className="button button-outline" type="button" onClick={() => setDeclining(order)}>
              Decline…
            </button>
          </>
        )}
        {order.status === 'deposit_paid' && (
          <button className="button button-primary" type="button" disabled={isBusy(order, 'ready')}
            aria-busy={isBusy(order, 'ready') || undefined} onClick={() => act(order, 'ready')}>
            <Spin on={isBusy(order, 'ready')} />Mark Ready &amp; Request Balance
          </button>
        )}
        {order.status === 'paid' && order.fulfilment_method !== 'pickup'
          && order.delivery_status !== 'out_for_delivery' && (
          <button className="button button-primary" type="button"
            disabled={isBusy(order, 'delivery', 'out_for_delivery')}
            aria-busy={isBusy(order, 'delivery', 'out_for_delivery') || undefined}
            onClick={() => act(order, 'delivery', { status: 'out_for_delivery' })}>
            <Spin on={isBusy(order, 'delivery', 'out_for_delivery')} />Out for Delivery
          </button>
        )}
        {order.status === 'paid' && order.fulfilment_method === 'pickup'
          && order.delivery_status !== 'ready_for_pickup' && (
          <button className="button button-primary" type="button"
            disabled={isBusy(order, 'delivery', 'ready_for_pickup')}
            aria-busy={isBusy(order, 'delivery', 'ready_for_pickup') || undefined}
            onClick={() => act(order, 'delivery', { status: 'ready_for_pickup' })}>
            <Spin on={isBusy(order, 'delivery', 'ready_for_pickup')} />Ready for Pickup
          </button>
        )}
        {order.status === 'paid' && (
          <button className="button button-outline" type="button"
            disabled={isBusy(order, 'delivery', 'delivered')}
            aria-busy={isBusy(order, 'delivery', 'delivered') || undefined}
            onClick={() => act(order, 'delivery', { status: 'delivered' })}>
            <Spin on={isBusy(order, 'delivery', 'delivered')} />
            {order.fulfilment_method === 'pickup' ? 'Mark Picked Up' : 'Mark Delivered'}
          </button>
        )}
      </div>
      {quoting === order.id && (
        <form className="order-quote" onSubmit={event => {
          event.preventDefault();
          const v = Object.fromEntries(new FormData(event.currentTarget));
          act(order, 'quote', { price: String(v.price).trim(), leadDays: String(v.leadDays).trim(), note: v.note });
        }}>
          <label>Your price (₱)
            <input name="price" type="text" inputMode="decimal" required autoComplete="off" placeholder="12500.00…" />
          </label>
          <label>Lead time (days)
            <input name="leadDays" type="text" inputMode="numeric" required autoComplete="off" placeholder="14…" />
          </label>
          <label>Note to buyer
            <input name="note" maxLength={1000} autoComplete="off" placeholder="Two coats of oil finish…" />
          </label>
          <div className="order-actions">
            <button className="button button-primary" type="submit" disabled={isBusy(order, 'quote')}
              aria-busy={isBusy(order, 'quote') || undefined}>
              <Spin on={isBusy(order, 'quote')} />Send Quote
            </button>
            <button className="button" type="button" onClick={() => setQuoting(null)}>Cancel</button>
          </div>
          <p className="form-note">The buyer sees your price plus the 10% service fee and pays half as a deposit.</p>
        </form>
      )}
    </OrderCard>
  );

  if (billing === undefined) {
    return (
      <ConsoleSection id="orders" title="Orders" note="Loading orders…">
        <div className="bezel" aria-busy="true"><div className="bezel-core console-empty"><p>Loading orders…</p></div></div>
      </ConsoleSection>
    );
  }

  return (
    <>
      <ConsoleSection
        id="orders"
        title={`Orders${open.length ? ` · ${open.length} Open` : ''}`}
        note="New and in-progress orders first. Buyers pay your PayPal seller account directly; move each one along as you prepare it."
      >
        {orders === null ? (
          <div className="bezel"><div className="bezel-core console-empty">
            <h3>Orders Didn&rsquo;t Load</h3>
            <p>Check your connection, then try again.</p>
            <button className="button" type="button" onClick={load}>Try Again</button>
          </div></div>
        ) : !orders.length ? (
          <div className="bezel"><div className="bezel-core console-empty">
            <h3>No Orders Yet</h3>
            <p>When a shopper buys a piece or requests a custom build, it appears here with everything you need to fulfil it.</p>
          </div></div>
        ) : (
          <>
            {open.length ? (
              <ul className="orders-list">{open.map(renderOrder)}</ul>
            ) : (
              <p className="orders-none">No open orders. Anything new appears here first.</p>
            )}
            {past.length > 0 && (
              <details className="orders-past">
                <summary>Past orders ({past.length})</summary>
                <ul className="orders-list">{past.map(renderOrder)}</ul>
              </details>
            )}
          </>
        )}
      </ConsoleSection>

      <ConsoleSection
        id="billing"
        title="Billing & Store Type"
        note={config?.feeMode === 'platform_split'
          ? 'Buyers pay your price plus FurnishAR’s 10% service fee. When your PayPal account allows it, PayPal takes the 10% at checkout and reports it; otherwise it is owed and settled separately.'
          : 'Buyers pay your price plus FurnishAR’s 10% service fee into your PayPal account; you settle the 10% with FurnishAR separately.'}
      >
        {billing === null ? (
          <div className="bezel"><div className="bezel-core console-empty">
            <h3>Billing Didn&rsquo;t Load</h3>
            <p>Check your connection, then try again.</p>
            <button className="button" type="button" onClick={load}>Try Again</button>
          </div></div>
        ) : (
          <>
            <PaypalCard account={account} config={config} busy={paypalBusy}
              onConnect={connectPaypal} onRefresh={() => refreshPaypal()}
              onLink={linkPaypal} onUnlink={() => setConfirmUnlink(true)} />
            {confirmUnlink && (
              <ConfirmDialog
                title="Disconnect PayPal?"
                body="Buyers won’t be able to pay you online until you connect a PayPal account again. Orders already paid are not affected."
                confirmLabel="Disconnect PayPal"
                onConfirm={unlinkPaypal}
                onCancel={() => setConfirmUnlink(false)}
              />
            )}
            <dl className="billing-summary">
              <div><dt>Fees Owed (Accrued)</dt><dd>{money(billing.fees.accrued)}</dd></div>
              {Number(billing.fees.collected) > 0 && (
                <div><dt>Collected by PayPal</dt><dd>{money(billing.fees.collected)}</dd></div>
              )}
              <div><dt>Settled</dt><dd>{money(billing.fees.settled)}</dd></div>
              <div><dt>Owed to FurnishAR</dt><dd>{money(billing.fees.outstanding)}</dd></div>
            </dl>
            <div className="bezel console-panel">
              <div className="bezel-core">
                <form className="product-form billing-form" onSubmit={saveSettings} onInput={() => setDirty(true)}>
                  <fieldset className="form-grid">
                    <legend className="sr-only">Store type, payments & delivery</legend>
                    <label>
                      Store type
                      <select name="fulfilment" defaultValue={billing.fulfilment}>
                        <option value="stocked">Stocked — buyers pay in full for pieces on hand</option>
                        <option value="custom">Custom — buyers request a build, you quote, 50% deposit</option>
                      </select>
                    </label>
                    <label>
                      PayPal email (your records only)
                      <input name="paypalEmail" type="email" defaultValue={billing.paypalEmail}
                        autoComplete="email" spellCheck={false} placeholder="payments@yourshop.ph…"
                        aria-describedby="paypal-email-note" />
                      <small id="paypal-email-note" className="form-note">
                        Optional. Buyers pay the PayPal account you connect above, not this address.
                      </small>
                    </label>
                    <label>
                      Order notification email
                      <input name="notifyEmail" type="email" defaultValue={billing.notifyEmail}
                        autoComplete="email" spellCheck={false} placeholder="orders@yourshop.ph…" />
                    </label>
                    <label>
                      Delivery takes (days)
                      <input name="deliveryDays" type="number" min="1" max="60" required inputMode="numeric"
                        defaultValue={billing.deliveryDays} />
                    </label>
                    <label>
                      Ready for pickup in (days)
                      <input name="pickupDays" type="number" min="0" max="60" required inputMode="numeric"
                        defaultValue={billing.pickupDays} />
                    </label>
                  </fieldset>
                  <p className="form-note">
                    Delivery is free for buyers. These days set the estimated arrival date on each receipt, plus
                    the lead time you quote for custom builds. Leave the notification email empty to use your sign-in email.
                  </p>
                  <button className="button button-primary" type="submit" disabled={busy === 'settings'}
                    aria-busy={busy === 'settings' || undefined}>
                    {busy === 'settings' && <span className="loading-spinner" aria-hidden="true" />}
                    Save Billing Settings
                  </button>
                </form>
              </div>
            </div>
          </>
        )}
      </ConsoleSection>

      {declining && (
        <DeclineDialog
          order={declining}
          busy={isBusy(declining, 'decline')}
          onConfirm={reason => act(declining, 'decline', { reason })}
          onCancel={() => setDeclining(null)}
        />
      )}
    </>
  );
}

/**
 * The shop's PayPal seller account: its status as PayPal reported it, the
 * merchant id masked, whether checkout is open, and the sandbox marker.
 *
 * Two ways to connect, chosen by the deployment (PAYPAL_SELLER_ONBOARDING):
 *   merchant_id        the owner pastes their Merchant ID; PayPal must accept
 *                      it as a payee before the shop is connected;
 *   partner_referrals  the owner signs in on PayPal's own onboarding page.
 */
function PaypalCard({ account, config, busy, onConnect, onRefresh, onLink, onUnlink }) {
  const status = account?.onboarding_status || 'NOT_CONNECTED';
  const view = describeStatus(status);
  const connected = status === 'CONNECTED';
  const started = status !== 'NOT_CONNECTED';
  const canConnect = Boolean(config?.sellerOnboarding);
  const byMerchantId = (config?.sellerMode || 'merchant_id') === 'merchant_id';
  const [editing, setEditing] = useState(false);
  const showForm = byMerchantId && (!connected || editing);
  const recheckable = byMerchantId ? ['CONNECTED', 'PAYMENTS_NEED_ATTENTION'].includes(status) : started;

  return (
    <div className="bezel console-panel paypal-card">
      <div className="bezel-core">
        <div className="paypal-card-head">
          <h3>PayPal Seller Account</h3>
          <span className={`status-chip is-${view.tone}`}>{view.label}</span>
          {config?.sandbox && <span className="status-chip is-sandbox" title="PayPal sandbox: no real money moves">PayPal Sandbox</span>}
        </div>
        <dl className="paypal-facts">
          <div><dt>Merchant ID</dt><dd translate="no">{maskMerchantId(connected ? account?.merchant_id : null)}</dd></div>
          <div><dt>Online checkout</dt><dd>{view.ready ? 'Open — buyers can pay you' : 'Closed until connected'}</dd></div>
          {account?.last_checked_at && (
            <div><dt>Last checked with PayPal</dt><dd>{new Date(account.last_checked_at).toLocaleString('en-PH', { dateStyle: 'medium', timeStyle: 'short' })}</dd></div>
          )}
        </dl>
        <p className="form-note">{account?.status_detail || view.help}</p>

        {showForm && (
          <form className="paypal-link" onSubmit={event => {
            event.preventDefault();
            const value = String(new FormData(event.currentTarget).get('merchantId') || '').trim();
            onLink(value);
            setEditing(false);
          }}>
            <label>
              PayPal Merchant ID
              <input name="merchantId" required autoComplete="off" spellCheck={false} inputMode="text"
                pattern="[A-Za-z0-9]{8,20}" maxLength={20} placeholder="e.g. 7XK2QJ9LMN4PA…"
                style={{ textTransform: 'uppercase' }} disabled={!canConnect || Boolean(busy)} />
            </label>
            <button className="button button-primary" type="submit" disabled={!canConnect || Boolean(busy)}
              aria-busy={busy === 'link' || undefined}>
              {busy === 'link' && <span className="loading-spinner" aria-hidden="true" />}Verify &amp; Connect
            </button>
            <p className="form-note">
              Find it in PayPal: <b>Settings (gear) → Account Settings → Business information → PayPal Merchant ID</b>.
              {config?.sandbox && <> Sandbox: developer.paypal.com → Sandbox Accounts → your Business account → <b>Account ID</b>.</>}
              {' '}PayPal checks it before your shop is connected; nothing is charged.
            </p>
            <details className="paypal-help">
              <summary>No PayPal account yet? How to get a Merchant ID</summary>
              <ol>
                <li>Go to <a href="https://www.paypal.com/ph/business" target="_blank" rel="noopener noreferrer">paypal.com</a> →
                  <b> Sign Up</b> → choose <b>Business account</b>. It&rsquo;s free. Already have a personal PayPal? Upgrade it to
                  Business in PayPal&rsquo;s Account Settings instead.</li>
                <li>Enter your shop&rsquo;s name, email and mobile number, and set a password.</li>
                <li>Open the email PayPal sends and <b>confirm your email address</b>. Until you do, PayPal won&rsquo;t accept payments for you.</li>
                <li>In PayPal, click the <b>gear icon (Settings) → Account Settings → Business information</b> and copy the
                  <b> PayPal Merchant ID</b>.</li>
                <li>Paste it above and choose <b>Verify &amp; Connect</b>.</li>
              </ol>
              <p className="form-note">
                Buyers pay straight into this PayPal account. FurnishAR never asks for your PayPal password.
                {config?.sandbox && <> This site is in <b>test mode</b>: use a sandbox Business account from developer.paypal.com → Sandbox Accounts (its <b>Account ID</b>), not a real one.</>}
              </p>
            </details>
          </form>
        )}

        <div className="order-actions">
          {!byMerchantId && !connected && (
            <button className="button button-primary" type="button" onClick={onConnect}
              disabled={!canConnect || Boolean(busy)} aria-busy={busy === 'connect' || undefined}>
              {busy === 'connect' && <span className="loading-spinner" aria-hidden="true" />}
              {started ? 'Continue PayPal Setup' : 'Connect PayPal'}
            </button>
          )}
          {recheckable && (
            <button className="button button-outline" type="button" onClick={onRefresh}
              disabled={!canConnect || Boolean(busy)} aria-busy={busy === 'refresh' || undefined}>
              {busy === 'refresh' && <span className="loading-spinner" aria-hidden="true" />}Check Status
            </button>
          )}
          {connected && byMerchantId && !editing && (
            <button className="button button-outline" type="button" onClick={() => setEditing(true)} disabled={Boolean(busy)}>
              Change Merchant ID
            </button>
          )}
          {connected && !byMerchantId && (
            <button className="button button-outline" type="button" onClick={onConnect} disabled={!canConnect || Boolean(busy)}>
              Connect a Different Account
            </button>
          )}
          {connected && byMerchantId && (
            <button className="button button-outline" type="button" onClick={onUnlink} disabled={Boolean(busy)}
              aria-busy={busy === 'unlink' || undefined}>
              {busy === 'unlink' && <span className="loading-spinner" aria-hidden="true" />}Disconnect
            </button>
          )}
        </div>
        <p className="form-note">
          {!canConnect
            ? 'Connecting PayPal is not switched on for this site yet. The FurnishAR team has been told.'
            : byMerchantId
              ? 'A Merchant ID only lets buyers pay you. FurnishAR never sees your PayPal password or the buyer’s card.'
              : 'You sign in on PayPal’s own page. FurnishAR never sees your PayPal password or the buyer’s card.'}
        </p>
      </div>
    </div>
  );
}

/** Declining tells the buyer and cannot be undone, so it is asked, with a reason. */
function DeclineDialog({ order, busy, onConfirm, onCancel }) {
  const ref = useRef(null);
  useEffect(() => {
    const dialog = ref.current;
    if (!dialog?.open) dialog?.showModal();
    dialog?.addEventListener('close', onCancel);
    return () => dialog?.removeEventListener('close', onCancel);
  }, [onCancel]);

  return (
    <dialog ref={ref} className="confirm-dialog" aria-labelledby="decline-title" aria-describedby="decline-body">
      <form method="dialog" onSubmit={event => {
        event.preventDefault();
        onConfirm(String(new FormData(event.currentTarget).get('reason') || '').trim());
      }} onKeyDown={event => {
        if (event.key === 'Enter' && (event.metaKey || event.ctrlKey)) event.currentTarget.requestSubmit();
      }}>
        <h2 id="decline-title">Decline {order.reference}?</h2>
        <p id="decline-body">{order.buyer_name} is told their request was declined. Nothing is charged. This can&rsquo;t be undone.</p>
        <label className="decline-reason">
          Reason for the buyer (optional)
          <textarea name="reason" rows={3} maxLength={500} placeholder="We can’t source narra in that size this month…" />
        </label>
        <div className="confirm-actions">
          <button className="button" type="button" autoFocus onClick={() => ref.current?.close()}>Keep Request</button>
          <button className="button button-danger" type="submit" disabled={busy} aria-busy={busy || undefined}>
            {busy && <span className="loading-spinner" aria-hidden="true" />}Decline Request
          </button>
        </div>
      </form>
    </dialog>
  );
}
