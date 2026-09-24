/**
 * How a shop's PayPal seller status reads, everywhere it is shown.
 * The status itself only ever comes from PayPal via the server (0011).
 */
export const PAYMENT_STATUS = Object.freeze({
  NOT_CONNECTED: { label: 'Not connected', tone: 'muted', ready: false,
    help: 'Buyers cannot pay you online until you connect a PayPal seller account.' },
  ONBOARDING_STARTED: { label: 'Setup started', tone: 'warning', ready: false,
    help: 'You started connecting PayPal but have not finished. Continue where you left off.' },
  PENDING: { label: 'Waiting on PayPal', tone: 'warning', ready: false,
    help: 'PayPal is waiting for you, usually to confirm your email address. Check your inbox, then check the status here.' },
  CONNECTED: { label: 'Connected', tone: 'success', ready: true,
    help: 'Buyers can pay you directly through PayPal.' },
  LIMITED: { label: 'Limited by PayPal', tone: 'danger', ready: false,
    help: 'PayPal has limited this account. Log in to PayPal to see what it needs.' },
  DISABLED: { label: 'Disabled', tone: 'danger', ready: false,
    help: 'This PayPal account cannot take payments. Connect a different one.' },
  ERROR: { label: 'Needs reconnecting', tone: 'danger', ready: false,
    help: 'FurnishAR does not have permission to take payments for this account. Connect PayPal again.' },
  PAYMENTS_NEED_ATTENTION: { label: 'Needs attention', tone: 'danger', ready: false,
    help: 'PayPal says this account cannot receive payments yet. Log in to PayPal to fix it.' }
});

export function describeStatus(status) {
  return PAYMENT_STATUS[status] || PAYMENT_STATUS.NOT_CONNECTED;
}

/** The merchant id is not a secret, but it is shown masked: •••• last four. */
export function maskMerchantId(id) {
  const value = String(id || '');
  if (!value) return '—';
  return `${'•'.repeat(Math.max(value.length - 4, 0))}${value.slice(-4)}`;
}

/** The account row for the deployment's environment, or a NOT_CONNECTED stand-in. */
export function currentAccount(accounts = [], environment = 'sandbox') {
  return accounts.find(a => a.environment === environment)
    || { environment, onboarding_status: 'NOT_CONNECTED', merchant_id: null };
}
