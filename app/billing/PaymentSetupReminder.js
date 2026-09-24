'use client';

import { useEffect, useState } from 'react';
import { describeStatus } from './payment-status.mjs';

/**
 * The one "Finish payment setup" reminder in the portal.
 *
 * Shown only while the shop cannot take payments, once per browser session
 * (dismissing it hides it until the next visit), and it sends nothing: the
 * email reminders are the server's job, on a schedule with a cooldown
 * (/api/cron/payment-reminders), never a page load.
 */
export default function PaymentSetupReminder({ storeUuid, status }) {
  const key = `furnishar-payment-reminder-${storeUuid}`;
  const [hidden, setHidden] = useState(true);

  useEffect(() => {
    let dismissed = false;
    try { dismissed = sessionStorage.getItem(key) === '1'; } catch { /* private mode */ }
    setHidden(dismissed);
  }, [key]);

  if (!status || hidden || describeStatus(status).ready) return null;
  const { label, help } = describeStatus(status);

  return (
    <aside className="payment-reminder" role="status" aria-label="Payment setup">
      <div>
        <b>Finish payment setup</b>
        <span className="status-chip is-warning">{label}</span>
        <p>{help}</p>
      </div>
      <div className="payment-reminder-actions">
        <a className="button button-primary" href="#billing">Set up PayPal</a>
        <button className="text-button" type="button" onClick={() => {
          try { sessionStorage.setItem(key, '1'); } catch { /* private mode */ }
          setHidden(true);
        }}>Not now</button>
      </div>
    </aside>
  );
}
