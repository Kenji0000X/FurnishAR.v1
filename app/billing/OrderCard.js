'use client';

/**
 * One order, as its buyer or its shop sees it.                 DFD: P10
 *
 * Presentation only. Which buttons appear is a convenience; whether the
 * action is allowed is decided by the 0009 functions, as the caller, on the
 * server. A button shown by mistake is refused there.
 */
export const money = value =>
  `₱${Number(value || 0).toLocaleString('en-PH', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;

const LABELS = {
  pending_payment: ['Awaiting payment', 'action'],
  requested: ['Waiting for quote', 'wait'],
  quoted: ['Quote ready — deposit due', 'action'],
  deposit_paid: ['Deposit paid — being built', 'wait'],
  balance_due: ['Ready — balance due', 'action'],
  paid: ['Paid', 'done'],
  fulfilled: ['Handed over', 'done'],
  declined: ['Declined', 'off'],
  cancelled: ['Cancelled', 'off'],
  expired: ['Expired', 'off']
};

export function statusLabel(status) {
  return LABELS[status]?.[0] || status;
}

function requestSummary(request) {
  if (!request) return null;
  const size = ['width_cm', 'depth_cm', 'height_cm'].map(k => request[k]);
  return [
    size.some(Boolean) && `${size.map(v => v ?? '—').join(' × ')} cm`,
    request.material, request.color, request.notes
  ].filter(Boolean).join(' · ');
}

export default function OrderCard({ order, perspective, children }) {
  const [label, tone] = LABELS[order.status] || [order.status, 'wait'];
  const summary = requestSummary(order.request);
  const due = order.status === 'quoted' ? order.deposit_amount
    : order.status === 'balance_due' ? Number(order.total) - Number(order.amount_paid)
    : order.status === 'pending_payment' ? order.total : null;

  return (
    <li className="order-card">
      <div className="order-head">
        <h3>
          {order.product_name}
          {order.quantity > 1 ? ` × ${order.quantity}` : ''}
        </h3>
        <span className="order-status" data-tone={tone}>{label}</span>
      </div>
      <p className="order-ref">
        {order.reference} · {new Date(order.created_at).toLocaleDateString('en-PH', { dateStyle: 'medium' })}
        {perspective === 'buyer' && order.stores?.name ? ` · ${order.stores.name}` : ''}
        {perspective === 'store' ? ` · ${order.buyer_name} (${order.buyer_email})` : ''}
      </p>
      {summary && <p className="order-meta">Request: {summary}</p>}
      {order.total != null && (
        <p className="order-meta">
          {perspective === 'store'
            ? <>Your price {money(order.subtotal)} · buyer pays {money(order.total)} incl. {money(order.platform_fee)} FurnishAR fee</>
            : <>{money(order.subtotal)} + {money(order.platform_fee)} service fee = <b>{money(order.total)}</b></>}
          {Number(order.amount_paid) > 0 && <> · paid {money(order.amount_paid)}</>}
          {due != null && Number(due) > 0 && <> · <b>due now {money(due)}</b></>}
        </p>
      )}
      {order.lead_time_days && <p className="order-meta">Lead time: about {order.lead_time_days} days{order.quote_note ? ` · “${order.quote_note}”` : ''}</p>}
      {order.decline_reason && <p className="order-meta">Shop said: {order.decline_reason}</p>}
      {order.status === 'pending_payment' && order.hold_expires_at && (
        <p className="order-meta">Held until {new Date(order.hold_expires_at).toLocaleTimeString('en-PH', { timeStyle: 'short' })}</p>
      )}
      {children}
    </li>
  );
}
