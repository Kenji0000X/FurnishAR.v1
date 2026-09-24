/**
 * Order emails, sent through Resend.                    DFD: P10 → P9
 *
 * An email is a notification of something that already happened in the
 * database — never the thing itself. So sending never throws: an order that
 * was paid stays paid if the email bounces, and the failure is logged for
 * whoever runs the site instead of being shown to the buyer as an error.
 *
 * RESEND_API_KEY and EMAIL_FROM live on the server only.
 */

function isConfigured() {
  return Boolean(String(process.env.RESEND_API_KEY || '').trim() && String(process.env.EMAIL_FROM || '').trim());
}

function escapeHtml(value) {
  return String(value ?? '').replace(/[&<>"']/g, ch => (
    { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[ch]));
}

function peso(value) {
  const number = Number(value || 0);
  return `₱${number.toLocaleString('en-PH', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
}

/** Plain paragraphs in, a small readable HTML email out. */
function render({ heading, lines, action }) {
  const body = lines.map(line => `<p style="margin:0 0 12px">${escapeHtml(line)}</p>`).join('');
  const button = action
    ? `<p style="margin:20px 0"><a href="${escapeHtml(action.href)}" style="background:#1f5c48;color:#fff;padding:10px 18px;border-radius:999px;text-decoration:none">${escapeHtml(action.label)}</a></p>`
    : '';
  return {
    html: `<div style="font-family:system-ui,sans-serif;font-size:15px;line-height:1.5;color:#1b2426;max-width:520px">
      <h1 style="font-size:20px;margin:0 0 16px">${escapeHtml(heading)}</h1>${body}${button}
      <p style="margin:24px 0 0;font-size:12px;color:#5b6769">FurnishAR · Payments go directly to the shop's PayPal account.</p></div>`,
    text: [heading, '', ...lines, ...(action ? ['', `${action.label}: ${action.href}`] : [])].join('\n')
  };
}

async function sendEmail({ to, subject, heading, lines, action }, fetchImpl = fetch) {
  const recipients = (Array.isArray(to) ? to : [to]).filter(Boolean);
  if (!recipients.length) return { sent: false, reason: 'no recipient' };
  if (!isConfigured()) {
    console.info(`[notify] email not configured; skipped "${subject}"`);
    return { sent: false, reason: 'unconfigured' };
  }
  try {
    const response = await fetchImpl('https://api.resend.com/emails', {
      method: 'POST',
      headers: { Authorization: `Bearer ${process.env.RESEND_API_KEY.trim()}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ from: process.env.EMAIL_FROM.trim(), to: recipients, subject, ...render({ heading, lines, action }) }),
      signal: AbortSignal.timeout(10_000)
    });
    if (!response.ok) {
      console.error(`[notify] resend refused "${subject}": ${response.status}`);
      return { sent: false, reason: `http ${response.status}` };
    }
    return { sent: true };
  } catch (error) {
    console.error(`[notify] resend unreachable for "${subject}": ${error?.name || error}`);
    return { sent: false, reason: 'unreachable' };
  }
}

/**
 * The emails each order event sends. `c` is order_contacts() — everything in
 * it came from the database, not the request.
 */
function messagesFor(event, c, site) {
  const ref = `Order ${c.reference}`;
  const account = { label: 'View your order', href: `${site}/account#orders` };
  const portal = { label: 'Open your store portal', href: `${site}/portal#orders` };
  const size = c.request
    ? ['width_cm', 'height_cm', 'depth_cm'].map(k => c.request[k]).some(Boolean)
      ? `Size: ${['width_cm', 'height_cm', 'depth_cm'].map(k => c.request[k] ?? '—').join(' × ')} cm`
      : null
    : null;
  const spec = c.request
    ? [size, c.request.material && `Material: ${c.request.material}`, c.request.color && `Colour: ${c.request.color}`,
       c.request.notes && `Notes: ${c.request.notes}`].filter(Boolean)
    : [];

  switch (event) {
    case 'paid':
      return [
        { to: c.buyer_email, subject: `${ref}: payment received`, heading: 'Payment received',
          lines: [`Thank you, ${c.buyer_name}. ${c.store_name} has received your payment of ${peso(c.amount_paid)} for ${c.product_name}${c.quantity > 1 ? ` × ${c.quantity}` : ''}.`,
                  'The shop will contact you about pickup or delivery.'], action: account },
        { to: c.store_emails, subject: `${ref}: new paid order`, heading: 'New paid order',
          lines: [`${c.buyer_name} (${c.buyer_email}) paid ${peso(c.amount_paid)} for ${c.product_name}${c.quantity > 1 ? ` × ${c.quantity}` : ''}.`,
                  `The money is in your PayPal account. FurnishAR's 10% service fee on this order is ${peso(c.platform_fee)}.`], action: portal }
      ];
    case 'deposit_paid':
      return [
        { to: c.buyer_email, subject: `${ref}: deposit received`, heading: 'Your build is reserved',
          lines: [`${c.store_name} received your deposit of ${peso(c.amount_paid)}. Estimated lead time: ${c.lead_time_days} days.`,
                  'We will email you when it is ready and the balance is due.'], action: account },
        { to: c.store_emails, subject: `${ref}: deposit paid — start the build`, heading: 'Deposit paid',
          lines: [`${c.buyer_name} paid the ${peso(c.amount_paid)} deposit for ${c.product_name}.`, ...spec,
                  'Mark it ready in the portal when it is built, and the buyer will be asked for the balance.'], action: portal }
      ];
    case 'requested':
      return [
        { to: c.store_emails, subject: `${ref}: new custom request`, heading: 'New custom request',
          lines: [`${c.buyer_name} (${c.buyer_email}) would like a custom build.`, ...spec,
                  'Send a quote from your portal.'], action: portal },
        { to: c.buyer_email, subject: `${ref}: request sent to ${c.store_name}`, heading: 'Request sent',
          lines: [`${c.store_name} has your request and will reply with a price and lead time.`], action: account }
      ];
    case 'quoted':
      return [{ to: c.buyer_email, subject: `${ref}: your quote from ${c.store_name}`, heading: 'Your quote is ready',
        lines: [`${c.store_name} can build ${c.product_name} for ${peso(c.subtotal)} in about ${c.lead_time_days} days.`,
                `With FurnishAR's 10% service fee the total is ${peso(c.total)}. Pay a ${peso(c.deposit_amount)} deposit to reserve the build.`,
                ...(c.quote_note ? [`Note from the shop: ${c.quote_note}`] : [])], action: account }];
    case 'declined':
      return [{ to: c.buyer_email, subject: `${ref}: request declined`, heading: `${c.store_name} can't take this build`,
        lines: [c.decline_reason ? `The shop said: ${c.decline_reason}` : 'The shop is unable to take this request.',
                'Nothing was charged.'], action: account }];
    case 'balance_due':
      return [{ to: c.buyer_email, subject: `${ref}: ready — balance due`, heading: 'Your furniture is ready',
        lines: [`${c.store_name} has finished ${c.product_name}. The balance of ${peso(Number(c.total) - Number(c.amount_paid))} is due.`],
        action: { label: 'Pay the balance', href: `${site}/account#orders` } }];
    case 'fulfilled':
      return [{ to: c.buyer_email, subject: `${ref}: handed over`, heading: 'Enjoy your furniture',
        lines: [`${c.store_name} marked ${c.product_name} as handed over. Thank you for shopping on FurnishAR.`] }];
    case 'cancelled':
      // An abandoned stock checkout is routine; only a withdrawn custom
      // request is news to the shop.
      if (c.kind !== 'custom') return [];
      return [{ to: c.store_emails, subject: `${ref}: cancelled by the buyer`, heading: 'Order cancelled',
        lines: [`${c.buyer_name} cancelled ${c.product_name} before paying. Nothing was charged.`] }];
    case 'unapplied':
      return [{ to: c.store_emails, subject: `${ref}: payment needs a refund`, heading: 'A payment could not be applied',
        lines: [`A PayPal payment for ${c.product_name} from ${c.buyer_name} (${c.buyer_email}) arrived after the order had moved on (paid twice, or the stock ran out).`,
                'Please refund it from your PayPal account.'], action: portal }];
    default:
      return [];
  }
}

module.exports = { isConfigured, sendEmail, messagesFor, render, escapeHtml, peso };
