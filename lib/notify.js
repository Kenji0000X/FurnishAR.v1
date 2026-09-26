/**
 * Order emails and receipts.                             DFD: P10 → P9
 *
 * Sent through Gmail (an App Password on a Gmail account the shop platform
 * owns) when GMAIL_USER and GMAIL_APP_PASSWORD are set, otherwise through
 * Resend (RESEND_API_KEY + EMAIL_FROM). Gmail needs no domain of our own and
 * reaches any inbox; Resend without a verified domain only reaches its own
 * account's address.
 *
 * An email is a notification of something that already happened in the
 * database — never the thing itself. So sending never throws: an order that
 * was paid stays paid if the email bounces, and the failure is logged for
 * whoever runs the site instead of being shown to the buyer as an error.
 *
 * Every credential here lives on the server only.
 */

const env = name => String(process.env[name] || '').trim();

function transportKind() {
  if (env('GMAIL_USER') && env('GMAIL_APP_PASSWORD')) return 'gmail';
  if (env('RESEND_API_KEY') && env('EMAIL_FROM')) return 'resend';
  return null;
}

function isConfigured() {
  return transportKind() !== null;
}

function escapeHtml(value) {
  return String(value ?? '').replace(/[&<>"']/g, ch => (
    { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[ch]));
}

function peso(value) {
  const number = Number(value || 0);
  return `₱${number.toLocaleString('en-PH', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
}

/** A date as a person in Occidental Mindoro reads it. */
function day(value) {
  if (!value) return '—';
  const date = /^\d{4}-\d{2}-\d{2}$/.test(String(value)) ? new Date(`${value}T12:00:00+08:00`) : new Date(value);
  return date.toLocaleDateString('en-PH', { timeZone: 'Asia/Manila', weekday: 'short', year: 'numeric', month: 'long', day: 'numeric' });
}

function when(value) {
  if (!value) return '—';
  return new Date(value).toLocaleString('en-PH', { timeZone: 'Asia/Manila', dateStyle: 'medium', timeStyle: 'short' });
}

/**
 * Paragraphs, an optional table of label/value rows, and an optional button,
 * in, a small readable HTML email (and its plain-text twin) out.
 */
function render({ heading, lines = [], rows = [], action }) {
  const body = lines.map(line => `<p style="margin:0 0 12px">${escapeHtml(line)}</p>`).join('');
  const table = rows.length
    ? `<table role="presentation" style="width:100%;border-collapse:collapse;margin:8px 0 16px;font-size:14px">${rows.map(row =>
        row.rule
          ? '<tr><td colspan="2" style="border-top:1px solid #d5dbdc;padding:0;height:8px"></td></tr>'
          : `<tr><td style="padding:4px 12px 4px 0;color:#5b6769;vertical-align:top">${escapeHtml(row.label)}</td>`
            + `<td style="padding:4px 0;text-align:right;${row.strong ? 'font-weight:700;' : ''}">${escapeHtml(row.value)}</td></tr>`
      ).join('')}</table>`
    : '';
  const button = action
    ? `<p style="margin:20px 0"><a href="${escapeHtml(action.href)}" style="background:#1f5c48;color:#fff;padding:10px 18px;border-radius:999px;text-decoration:none">${escapeHtml(action.label)}</a></p>`
    : '';
  const textRows = rows.filter(row => !row.rule).map(row => `${row.label}: ${row.value}`);
  return {
    html: `<div style="font-family:system-ui,sans-serif;font-size:15px;line-height:1.5;color:#1b2426;max-width:560px">
      <h1 style="font-size:20px;margin:0 0 16px">${escapeHtml(heading)}</h1>${body}${table}${button}
      <p style="margin:24px 0 0;font-size:12px;color:#5b6769">FurnishAR · Payments are made on PayPal's page or through PayMongo for GCash; FurnishAR never sees your password, PIN or card.</p></div>`,
    text: [heading, '', ...lines, ...(textRows.length ? ['', ...textRows] : []),
           ...(action ? ['', `${action.label}: ${action.href}`] : [])].join('\n')
  };
}

let gmailTransport = null;

async function sendViaGmail({ to, subject, html, text }) {
  if (!gmailTransport) {
    const nodemailer = require('nodemailer');
    gmailTransport = nodemailer.createTransport({
      service: 'gmail',
      // App Passwords are shown with spaces ("abcd efgh ijkl mnop"); Gmail wants them without.
      auth: { user: env('GMAIL_USER'), pass: env('GMAIL_APP_PASSWORD').replace(/\s+/g, '') }
    });
  }
  // Gmail sends as the signed-in account whatever From says, so say it plainly.
  await gmailTransport.sendMail({ from: `"FurnishAR" <${env('GMAIL_USER')}>`, to, subject, html, text });
}

async function sendViaResend({ to, subject, html, text }, fetchImpl) {
  const response = await fetchImpl('https://api.resend.com/emails', {
    method: 'POST',
    headers: { Authorization: `Bearer ${env('RESEND_API_KEY')}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ from: env('EMAIL_FROM'), to, subject, html, text }),
    signal: AbortSignal.timeout(10_000)
  });
  if (!response.ok) {
    const error = new Error(`http ${response.status}`);
    error.status = response.status;
    throw error;
  }
}

async function sendEmail({ to, subject, heading, lines, rows, action }, fetchImpl = fetch) {
  const recipients = (Array.isArray(to) ? to : [to]).filter(Boolean);
  if (!recipients.length) return { sent: false, reason: 'no recipient' };
  const kind = transportKind();
  if (!kind) {
    console.info(`[notify] email not configured; skipped "${subject}"`);
    return { sent: false, reason: 'unconfigured' };
  }
  const message = { to: recipients, subject, ...render({ heading, lines, rows, action }) };
  try {
    if (kind === 'gmail') await sendViaGmail(message);
    else await sendViaResend(message, fetchImpl);
    return { sent: true, via: kind };
  } catch (error) {
    // Never log the credential; the provider's code is enough to act on.
    console.error(`[notify] ${kind} could not send "${subject}": ${error?.responseCode || error?.status || error?.code || error?.name || 'error'}`);
    return { sent: false, reason: kind };
  }
}

/* ----------------------------------------------------------- content --- */

/* How each payment reads to a person: GCash is the method, PayMongo processes it. */
const PROVIDER_NAME = { paypal: 'PayPal', paymongo: 'GCash via PayMongo' };
const providerName = id => PROVIDER_NAME[id] || 'PayPal';
/* The method alone, for sentences ("confirmed through GCash"). */
const METHOD_NAME = { paypal: 'PayPal', paymongo: 'GCash' };
const methodName = id => METHOD_NAME[id] || 'PayPal';

/** The latest payment recorded on the order, applied or not. */
function latestPaymentAny(c) {
  const all = c.payments || [];
  return all[all.length - 1] || null;
}

/** The payment this event is about: the latest one applied to the order. */
function latestPayment(c) {
  const applied = (c.payments || []).filter(p => p.applied);
  return applied[applied.length - 1] || null;
}

/**
 * Where the money is, in words the shop can rely on (0016). PayPal pays the
 * shop's own account. GCash through PayMongo pays FurnishAR's PayMongo
 * account (platform settlement), which owes the shop its share; with
 * PayMongo Split Payments the shop's share is transferred by PayMongo. Never
 * "the money is in your GCash account": it is not.
 */
function whereTheMoneyIs(c) {
  const p = latestPayment(c);
  const fee = peso(c.platform_fee);
  if (!p || (p.provider || 'paypal') === 'paypal') {
    return `The money is in your PayPal account; FurnishAR's 10% service fee on this order is ${fee}.`;
  }
  const share = peso(Number(p.amount) - Number(p.platform_fee || 0));
  if (p.fee_mode === 'platform_held') {
    return `Payment was confirmed through GCash. It was received by FurnishAR's PayMongo account; `
      + `your share of ${share} is owed to you and paid out by FurnishAR. PayMongo's processing fee is shown separately in Billing.`;
  }
  return `Payment was confirmed through GCash. PayMongo transfers your share of ${share} to your PayMongo account, `
    + `less any processing fee PayMongo deducts; FurnishAR's 10% service fee on this order is ${fee}.`;
}

function itemLine(c) {
  return `${c.product_name}${c.quantity > 1 ? ` × ${c.quantity}` : ''}`;
}

function howItArrives(c) {
  if (c.fulfilment_method === 'pickup') {
    return `Store pickup at ${c.store_name}${c.store_address ? `, ${c.store_address}` : ''}`;
  }
  if (c.fulfilment_method === 'delivery') {
    return `Free delivery to ${[c.delivery_address, c.delivery_municipality, 'Occidental Mindoro'].filter(Boolean).join(', ')}`;
  }
  return 'Arranged with the shop';
}

/** The receipt, as rows. Everything in `c` came from the database. */
function receiptRows(c) {
  const captures = (c.payments || []).filter(p => p.applied);
  const last = captures[captures.length - 1];
  const balance = Number(c.total || 0) - Number(c.amount_paid || 0);
  return [
    { label: 'Receipt no.', value: c.reference },
    { label: 'Order date', value: when(c.created_at) },
    ...(last ? [{ label: 'Paid on', value: when(last.captured_at) }] : []),
    { label: 'Sold by', value: `${c.store_name}${c.store_contact ? ` · ${c.store_contact}` : ''}` },
    { rule: true },
    { label: itemLine(c), value: peso(c.subtotal) },
    ...(c.quantity > 1 && c.unit_price ? [{ label: 'Unit price', value: peso(c.unit_price) }] : []),
    { label: 'FurnishAR service fee (10%)', value: peso(c.platform_fee) },
    { label: c.fulfilment_method === 'pickup' ? 'Pickup' : 'Delivery', value: 'Free' },
    { label: 'Total', value: peso(c.total), strong: true },
    { rule: true },
    ...captures.map(p => ({
      label: `Paid via ${providerName(p.provider)} (${p.stage === 'full' ? 'in full' : p.stage}) · ${p.capture_id}`,
      value: peso(p.amount)
    })),
    ...(balance > 0.004 ? [{ label: 'Balance still due', value: peso(balance), strong: true }] : []),
    { rule: true },
    { label: 'How you get it', value: howItArrives(c) },
    { label: c.fulfilment_method === 'pickup' ? 'Ready for pickup by' : 'Estimated arrival', value: day(c.estimated_arrival) },
    ...(c.delivery_phone ? [{ label: 'Contact number', value: c.delivery_phone }] : []),
    ...(c.delivery_notes ? [{ label: 'Notes', value: c.delivery_notes }] : [])
  ];
}

/* ------------------------------------------- PayPal payment received --- */

const STAGE_WORD = { full: 'in full', deposit: 'deposit', balance: 'balance' };

/** "Pickup" or "Delivery", as the order says. */
function fulfilmentWord(c) {
  return c.fulfilment_method === 'pickup' ? 'Store pickup' : c.fulfilment_method === 'delivery' ? 'Delivery' : 'Arranged with the shop';
}

/**
 * Where FurnishAR's fee on ONE PayPal payment stands, from the payment row
 * (0017 fee_status), never from what was hoped for:
 *   collected  PayPal reported taking exactly the fee for FurnishAR
 *   accrued    the shop received it and owes it to FurnishAR
 */
function paypalFeeState(p) {
  const status = p?.fee_status || (p?.fee_mode === 'platform_split' ? 'collected' : 'accrued');
  return status === 'collected'
    ? { collected: true, mode: 'PayPal platform split', status: 'Collected' }
    : { collected: false, mode: 'Accrual', status: status === 'refunded' ? 'Refunded' : 'Accrued' };
}

/**
 * The three "payment received" emails for one VERIFIED, RECORDED PayPal
 * payment (0017 ledger): the buyer's receipt, the shop's notice and the
 * superadmin's fee notice. `c` is order_contacts_for() plus `payment` (the
 * payment row this is about) and, for the admin, `admin_emails`. Every figure
 * comes from the database; nothing from the checkout request.
 */
function paymentReceivedMessage(audience, c, site) {
  const p = c.payment || latestPayment(c) || {};
  const ref = `Order ${c.reference}`;
  const staged = p.stage && p.stage !== 'full';
  const stageWord = STAGE_WORD[p.stage] || 'in full';
  const fee = paypalFeeState(p);
  const balance = Number(c.total || 0) - Number(c.amount_paid || 0);
  const sandbox = c.sandbox || p.environment === 'sandbox' ? ['This is the PayPal sandbox: no real money moved.'] : [];
  const orderRows = [
    { label: 'Furniture subtotal', value: peso(c.subtotal) },
    { label: 'FurnishAR service fee (10%)', value: peso(c.platform_fee) },
    { label: 'Order total', value: peso(c.total), strong: !staged }
  ];

  if (audience === 'buyer') {
    return {
      to: c.buyer_email,
      subject: `${staged ? `${p.stage === 'deposit' ? 'Deposit' : 'Balance'} payment received` : 'Payment received'} — ${ref}`,
      heading: staged ? `Payment received — ${stageWord}` : 'Payment received',
      lines: [`Thank you, ${c.buyer_name}. PayPal confirmed your payment for ${itemLine(c)} from ${c.store_name}.`],
      rows: [
        { label: 'Store', value: c.store_name },
        { label: 'Furniture', value: itemLine(c) },
        { rule: true },
        ...orderRows,
        { rule: true },
        { label: staged ? `Paid now (${stageWord})` : 'Total paid', value: peso(p.amount), strong: true },
        ...(balance > 0.004 ? [{ label: 'Balance still due', value: peso(balance) }] : []),
        { label: 'Payment method', value: 'PayPal' },
        { label: 'Order reference', value: c.reference },
        ...(p.captured_at ? [{ label: 'Paid on', value: when(p.captured_at) }] : []),
        { rule: true },
        { label: 'How you get it', value: howItArrives(c) },
        ...(c.estimated_arrival ? [{ label: c.fulfilment_method === 'pickup' ? 'Ready for pickup by' : 'Estimated arrival', value: day(c.estimated_arrival) }] : [])
      ],
      action: { label: 'View receipt', href: `${site}/account/receipt/${c.order_id}` }
    };
  }

  if (audience === 'store') {
    const confirmation = fee.collected
      ? `PayPal confirmed the payment for this order and took FurnishAR's ${peso(p.platform_fee)} service fee at capture.`
      : `PayPal confirmed the payment for this order. It was paid to your PayPal account; FurnishAR's ${peso(p.platform_fee)} service fee is recorded as owed by your shop and appears in Billing.`;
    return {
      to: c.store_emails,
      subject: `New payment received — ${ref}`,
      heading: 'New payment received',
      lines: [
        `A buyer has paid for ${itemLine(c)}${staged ? ` (${stageWord})` : ''}.`,
        confirmation,
        'PayPal may deduct its own processing fee, so the amount that reaches your PayPal balance can be lower.',
        ...(p.stage === 'deposit' ? ['Mark it ready in the portal when it is built, and the buyer will be asked for the balance.'] : []),
        ...sandbox
      ],
      rows: [
        { label: 'Buyer', value: c.buyer_name },
        { label: 'Furniture', value: itemLine(c) },
        { rule: true },
        { label: 'Furniture subtotal', value: peso(c.subtotal) },
        { label: 'Buyer total', value: peso(c.total) },
        ...(staged ? [{ label: `Paid now (${stageWord})`, value: peso(p.amount) }] : []),
        { label: 'Your portion of this payment', value: `${peso(p.store_portion ?? Number(p.amount) - Number(p.platform_fee || 0))} before PayPal fees` },
        { label: 'Payment method', value: 'PayPal' },
        { label: 'Order', value: c.reference },
        { label: 'Fulfilment', value: fulfilmentWord(c) },
        ...(c.delivery_phone ? [{ label: 'Contact number', value: c.delivery_phone }] : []),
        ...(c.estimated_arrival ? [{ label: c.fulfilment_method === 'pickup' ? 'Promised ready by' : 'Promised arrival', value: day(c.estimated_arrival) }] : [])
      ],
      action: { label: 'Open Store Portal', href: `${site}/portal#orders` }
    };
  }

  // Superadmin: the fee's real state, never "received" for an accrued fee.
  const feeLine = fee.collected
    ? `PayPal confirmed FurnishAR's ${peso(p.platform_fee)} platform fee.`
    : `${peso(p.platform_fee)} FurnishAR service fee was recorded as accrued. The shop received it and owes it; it is not collected until settled in Billing.`;
  return {
    to: c.admin_emails,
    subject: `FurnishAR payment received — ${peso(p.platform_fee)} platform fee ${fee.collected ? 'collected' : 'accrued'} (${ref})`,
    heading: fee.collected ? 'Platform fee collected' : 'Platform fee accrued',
    lines: [feeLine, ...sandbox],
    rows: [
      { label: 'Order', value: c.reference },
      { label: 'Store', value: c.store_name },
      { label: 'Furniture subtotal', value: peso(c.subtotal) },
      { label: staged ? `Buyer paid (${stageWord})` : 'Buyer paid', value: peso(p.amount) },
      { label: 'Store portion', value: peso(p.store_portion ?? Number(p.amount) - Number(p.platform_fee || 0)) },
      { label: 'FurnishAR service fee', value: peso(p.platform_fee) },
      { label: 'Payment provider', value: 'PayPal' },
      { label: 'Fee mode', value: fee.mode },
      { label: 'Status', value: fee.status, strong: true },
      ...(p.processing_fee != null ? [{ label: 'PayPal processing fee (shop\'s)', value: peso(p.processing_fee) }] : [])
    ],
    action: { label: 'Open platform billing', href: `${site}/admin/billing` }
  };
}

/**
 * The emails each order event sends. `c` is order_contacts() — everything in
 * it came from the database, not the request.
 */
function messagesFor(event, c, site) {
  const ref = `Order ${c.reference}`;
  const receipt = { label: 'View your receipt', href: `${site}/account/receipt/${c.order_id}` };
  const account = { label: 'View your order', href: `${site}/account#orders` };
  const portal = { label: 'Open your store portal', href: `${site}/portal#orders` };
  const size = c.request && ['width_cm', 'height_cm', 'depth_cm'].map(k => c.request[k]).some(Boolean)
    ? `Size: ${['width_cm', 'height_cm', 'depth_cm'].map(k => c.request[k] ?? '—').join(' × ')} cm`
    : null;
  const spec = c.request
    ? [size, c.request.material && `Material: ${c.request.material}`, c.request.color && `Colour: ${c.request.color}`,
       c.request.notes && `Notes: ${c.request.notes}`].filter(Boolean)
    : [];
  const handover = [
    { label: 'Buyer', value: `${c.buyer_name} · ${c.buyer_email}` },
    { label: 'Contact number', value: c.delivery_phone || '—' },
    { label: 'How', value: howItArrives(c) },
    { label: c.fulfilment_method === 'pickup' ? 'Promised ready by' : 'Promised arrival', value: day(c.estimated_arrival) },
    ...(c.delivery_notes ? [{ label: 'Notes', value: c.delivery_notes }] : [])
  ];

  switch (event) {
    case 'paid':
      return [
        { to: c.buyer_email, subject: `Receipt for ${ref} — ${c.store_name}`, heading: 'Payment received — your receipt',
          lines: [`Thank you, ${c.buyer_name}. ${c.store_name} has received your payment for ${itemLine(c)}.`],
          rows: receiptRows(c), action: receipt },
        { to: c.store_emails, subject: `${ref}: new paid order — prepare it`, heading: 'New paid order',
          lines: [`${c.buyer_name} paid ${peso(c.amount_paid)} for ${itemLine(c)}. ${whereTheMoneyIs(c)}`, ...spec],
          rows: handover, action: portal }
      ];
    case 'deposit_paid':
      return [
        { to: c.buyer_email, subject: `Deposit receipt for ${ref} — ${c.store_name}`, heading: 'Deposit received — your build is reserved',
          lines: [`${c.store_name} received your deposit for ${c.product_name}. We will email you when it is ready and the balance is due.`],
          rows: receiptRows(c), action: receipt },
        { to: c.store_emails, subject: `${ref}: deposit paid — start the build`, heading: 'Deposit paid',
          lines: [`${c.buyer_name} paid the ${peso(c.amount_paid)} deposit for ${c.product_name}.`,
                  ...((latestPayment(c)?.provider || 'paypal') === 'paymongo' ? [whereTheMoneyIs(c)] : []), ...spec,
                  'Mark it ready in the portal when it is built, and the buyer will be asked for the balance.'],
          rows: handover, action: portal }
      ];
    case 'requested':
      return [
        { to: c.store_emails, subject: `${ref}: new custom request`, heading: 'New custom request',
          lines: [`${c.buyer_name} (${c.buyer_email}) would like a custom build.`, ...spec, 'Send a quote from your portal.'],
          rows: handover.filter(row => !/Promised/.test(row.label)), action: portal },
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
    case 'out_for_delivery':
      return [{ to: c.buyer_email, subject: `${ref}: out for delivery`, heading: 'Your furniture is on its way',
        lines: [`${c.store_name} has sent ${itemLine(c)} out for delivery to ${[c.delivery_address, c.delivery_municipality].filter(Boolean).join(', ')}.`,
                `Please keep ${c.delivery_phone || 'your phone'} reachable. Estimated arrival: ${day(c.estimated_arrival)}.`],
        action: receipt }];
    case 'ready_for_pickup':
      return [{ to: c.buyer_email, subject: `${ref}: ready for pickup`, heading: 'Ready for pickup',
        lines: [`${itemLine(c)} is ready at ${c.store_name}${c.store_address ? `, ${c.store_address}` : ''}.`,
                `Bring your receipt number ${c.reference}.${c.store_contact ? ` The shop's number is ${c.store_contact}.` : ''}`],
        action: receipt }];
    case 'delivered':
    case 'fulfilled':
      return [{ to: c.buyer_email, subject: `${ref}: ${c.fulfilment_method === 'pickup' ? 'picked up' : 'delivered'}`,
        heading: 'Enjoy your furniture',
        lines: [`${c.store_name} marked ${itemLine(c)} as ${c.fulfilment_method === 'pickup' ? 'picked up' : 'delivered'}. Thank you for shopping on FurnishAR.`],
        action: receipt }];
    case 'cancelled':
      // An abandoned stock checkout is routine; only a withdrawn custom
      // request is news to the shop.
      if (c.kind !== 'custom') return [];
      return [{ to: c.store_emails, subject: `${ref}: cancelled by the buyer`, heading: 'Order cancelled',
        lines: [`${c.buyer_name} cancelled ${c.product_name} before paying. Nothing was charged.`] }];
    case 'unapplied': {
      const provider = c.provider || latestPaymentAny(c)?.provider || 'paypal';
      return [{ to: c.store_emails, subject: `${ref}: payment needs a refund`, heading: 'A payment could not be applied',
        lines: [`A ${providerName(provider)} payment for ${c.product_name} from ${c.buyer_name} (${c.buyer_email}) arrived after the order had moved on (paid twice, or the stock ran out).`,
                provider === 'paymongo'
                  ? 'FurnishAR received it through GCash (PayMongo) and will refund the buyer; you do not need to do anything.'
                  : 'Please refund it from your PayPal account.'], action: portal }];
    }
    case 'payment_failed':
      return [{ to: c.buyer_email, subject: `${ref}: payment not completed`, heading: 'Your payment did not go through',
        lines: [`${methodName(c.provider)} did not complete your payment for ${itemLine(c)}. You have not been charged.`,
                'You can try again from your orders.'], action: account }];
    case 'refund_completed': {
      const amount = peso(c.refund_amount);
      return [
        { to: c.buyer_email, subject: `${ref}: refund of ${amount}`, heading: 'Your refund is on its way',
          lines: c.provider === 'paymongo'
            ? [`FurnishAR refunded ${amount} for ${itemLine(c)} to your GCash, through PayMongo.`,
               'GCash refunds usually reflect within the day.']
            : [`${c.store_name} refunded ${amount} for ${itemLine(c)} through PayPal.`,
               'PayPal returns it to the account or card you paid with; banks can take a few days to show it.'],
          action: receipt },
        { to: c.store_emails, subject: `${ref}: refund of ${amount} recorded`, heading: 'Refund recorded',
          lines: [`A refund of ${amount} to ${c.buyer_name} was recorded from ${providerName(c.provider)}.`,
                  `Of that, ${peso(c.refund_platform_fee)} was FurnishAR's service fee and ${peso(Number(c.refund_amount) - Number(c.refund_platform_fee))} your share.`],
          action: portal }
      ];
    }
    case 'paypal_refund_admin': {
      const collected = c.fee_mode === 'platform_split';
      const back = Number(c.refund_platform_fee || 0);
      return [{ to: c.admin_emails, subject: `PayPal refund recorded — ${ref}`, heading: 'A PayPal refund was recorded',
        lines: [`${c.store_name} refunded ${peso(c.refund_amount)} to ${c.buyer_name} through PayPal.`,
                collected
                  ? (back > 0 ? `PayPal returned ${peso(back)} of FurnishAR's collected platform fee; it no longer counts as collected.`
                              : 'PayPal did not return FurnishAR\'s collected platform fee with this refund; it still counts as collected.')
                  : `${peso(back)} of FurnishAR's accrued service fee was cancelled with it; the shop no longer owes that part.`],
        action: { label: 'Open platform billing', href: `${site}/admin/billing` } }];
    }
    default:
      return accountMessages(event, c, site);
  }
}

/* ------------------------------------------ account, store and PayPal --- */

/**
 * Emails that are not about one order: accounts, applications, the shop's
 * PayPal connection and the platform fee. `c` is built by the server from
 * the database (or from PayPal, for connection status) — never the browser.
 */
function accountMessages(event, c, site) {
  const billing = { label: 'Open store billing', href: `${site}/portal#billing` };
  const sandboxNote = c.sandbox ? ['This is the PayPal sandbox: no real money moves.'] : [];
  switch (event) {
    case 'buyer_welcome':
      return [{ to: c.email, subject: 'Welcome to FurnishAR', heading: `Welcome, ${c.full_name || 'there'}`,
        lines: ['Your shopper account is ready. Measure your room, stand furniture in it at true size, and buy from shops in Occidental Mindoro.',
                'You do not need a payment account with us: you pay with PayPal or GCash only when you check out.'],
        action: { label: 'Browse furniture', href: `${site}/collection` } }];
    case 'store_application_received':
      return [{ to: c.contact_email, subject: `We received your application for ${c.store_name}`,
        heading: 'Application received',
        lines: [`Thank you. ${c.store_name} is in our review queue; a person checks every shop by hand.`,
                'We will email you when it is approved. After approval you connect a PayPal seller account so buyers can pay you.'],
        action: { label: 'Open the store portal', href: `${site}/portal` } }];
    case 'store_application_admin_notice':
      return [{ to: c.admin_emails, subject: `New store application: ${c.store_name}`, heading: 'A shop applied to sell',
        lines: [`${c.store_name} (${c.contact_email}${c.contact_phone ? ` · ${c.contact_phone}` : ''}) applied.`,
                ...(c.message ? [`They said: ${c.message}`] : [])],
        action: { label: 'Review applications', href: `${site}/admin/applications` } }];
    case 'store_approved':
      return [{ to: c.contact_email, subject: `${c.store_name} is approved on FurnishAR`, heading: 'Your store is approved',
        lines: ['You can now sign in to the store portal, list furniture and upload 3D models.',
                'One step before buyers can pay you online: connect your PayPal seller account under Billing. You sign in on PayPal\'s own page; FurnishAR never sees your PayPal password.'],
        action: { label: 'Connect PayPal', href: `${site}/portal#billing` } }];
    case 'store_rejected':
      return [{ to: c.contact_email, subject: `Your FurnishAR application for ${c.store_name}`, heading: 'Application not approved',
        lines: [c.note ? `The reviewer said: ${c.note}` : 'Your application was not approved this time.',
                'Reply to this email if you think this was a mistake.'] }];
    case 'paypal_connection_required':
      return [{ to: c.store_emails, subject: `Finish payment setup for ${c.store_name}`, heading: 'Buyers cannot pay you yet',
        lines: [`${c.store_name} is not connected to a PayPal seller account, so shoppers cannot buy from you online.`,
                'It takes a few minutes: open Billing in the store portal and choose Connect PayPal.', ...sandboxNote],
        action: billing }];
    case 'model_expiry_notice': {
      // One email per shop, listing every model that is due (0013).
      const models = c.models || [];
      const one = models.length === 1;
      return [{ to: c.store_emails,
        subject: one ? `Keep the 3D model of ${models[0].product_name}?` : `Keep ${models.length} 3D models at ${c.store_name}?`,
        heading: one ? 'A 3D model has not been used for 11 months' : `${models.length} 3D models have not been used for 11 months`,
        lines: [
          `Nobody has opened ${one ? 'this model' : 'these models'} on FurnishAR for about 11 months. A FurnishAR administrator may delete a model once it has gone unused for a full year, to free storage. Nothing is deleted automatically.`,
          'To keep a model, open Inventory in the store portal and choose "Keep 3D model". Opening it in the portal or on the product page also counts.',
          'If a model is deleted, only the 3D file and its catalogue preview go. The product, its measurements and its orders stay, and you can upload a new model at any time.'
        ],
        rows: models.map(m => ({ label: m.product_name, value: `Can be deleted from ${day(m.deletable_from)}` })),
        action: { label: 'Open Inventory', href: `${site}/portal#inventory` } }];
    }
    case 'paypal_connected':
      return [{ to: c.store_emails, subject: `PayPal connected for ${c.store_name}`, heading: 'You can take online payments',
        lines: [`PayPal confirmed the seller account for ${c.store_name}. Buyers can now pay you directly.`, ...sandboxNote],
        action: billing }];
    case 'paypal_connection_problem':
      return [
        { to: c.store_emails, subject: `Action needed: PayPal for ${c.store_name}`, heading: 'Your PayPal connection needs attention',
          lines: [c.detail || 'PayPal reported a problem with your seller account.',
                  'Until it is fixed, buyers cannot pay you online.', ...sandboxNote],
          action: billing },
        ...(c.admin_emails?.length ? [{ to: c.admin_emails, subject: `PayPal problem: ${c.store_name}`, heading: 'A shop\'s PayPal connection changed',
          lines: [`${c.store_name}: ${c.status}. ${c.detail || ''}`.trim()] }] : [])
      ];
    case 'platform_fee_recorded': {
      const via = providerName(c.provider);
      const sandbox = c.sandbox ? [c.provider === 'paymongo' ? 'This is PayMongo test mode: no real money moves.'
                                                            : `This is the ${via} sandbox: no real money moves.`] : [];
      const text = {
        platform_split: ['Platform fee collected by PayPal',
          `PayPal reported taking ${peso(c.platform_fee)} for FurnishAR from a ${peso(c.amount)} payment (${c.stage}).`],
        platform_held: ['GCash payment received by FurnishAR\'s PayMongo account',
          `A ${peso(c.amount)} GCash payment (${c.stage}) was received by FurnishAR's PayMongo account. ${peso(c.platform_fee)} is FurnishAR's fee, `
          + `accrued — not collected by any split; ${peso(Number(c.amount) - Number(c.platform_fee))} is owed to the shop until paid out. `
          + 'PayMongo\'s processing fee is deducted from the balance and shown in Billing.'],
        provider_split: ['Platform fee expected via PayMongo split',
          `A ${peso(c.amount)} GCash payment (${c.stage}) was split by PayMongo to the shop's child merchant. ${peso(c.platform_fee)} is expected for FurnishAR; it is not collected until reconciled against PayMongo's records.`],
        accrual: ['Platform fee accrued',
          `A ${peso(c.amount)} ${via} payment (${c.stage}) went to the shop in full; ${peso(c.platform_fee)} is owed to FurnishAR and appears in Billing until settled.`]
      }[c.fee_mode] || ['Platform fee recorded', `A ${peso(c.amount)} ${via} payment (${c.stage}) was recorded.`];
      return [{ to: c.admin_emails, subject: `${text[0]}: ${peso(c.platform_fee)}${c.sandbox ? ' (sandbox)' : ''}`,
        heading: text[0], lines: [text[1], ...sandbox],
        action: { label: 'Open platform billing', href: `${site}/admin/billing` } }];
    }
    case 'payment_problem':
      return [{ to: c.admin_emails, subject: `Payment needs attention (${providerName(c.provider)})`,
        heading: 'A payment needs attention',
        lines: [`Reference ${c.reference || '—'}: ${c.detail || 'see the order.'}`],
        action: { label: 'Open platform billing', href: `${site}/admin/billing` } }];
    default:
      return [];
  }
}

function siteUrl() {
  return String(process.env.SITE_URL || '').trim().replace(/\/$/, '');
}

module.exports = { isConfigured, transportKind, sendEmail, messagesFor, paymentReceivedMessage, paypalFeeState, accountMessages, receiptRows, render, escapeHtml, peso, day, siteUrl };
