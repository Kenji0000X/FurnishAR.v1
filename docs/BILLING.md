# Orders & payments — setup

> **Since 0011**, shops are paid through a connected PayPal **seller** account, not a typed email:
> - the fee can be split by PayPal (`platform_split`) or accrue (the default);
> - webhooks, refunds and reminders exist.
>
> See `GOOGLE-PAYPAL-SETUP.md`.
>
> **Since 0016**, GCash (processed by PayMongo) is a second payment method in the same orders and payments system. See `PAYMONGO-GCASH-INTEGRATION.md`.

DFD process **P10**, data store **D5**. Migration `supabase/migrations/0009_orders_billing.sql`.

## How the money moves

- **Stocked shops**: the buyer pays in full. The piece is held (reserved when the order is placed) for 30 minutes while they pay on PayPal's or PayMongo's page; starting or switching a checkout never changes stock again.
- **Custom shops**:
  1. The buyer sends a request.
  2. The shop quotes a price and lead time.
  3. The buyer pays a 50% deposit.
  4. The shop marks the piece ready.
  5. The buyer pays the balance.
- **Where the money goes depends on the method:**
  - **PayPal** pays **directly into the shop's own PayPal account**; FurnishAR never holds that money.
  - **GCash via PayMongo**, as set up by default (`platform`), pays into **FurnishAR's** PayMongo account, less PayMongo's processing fee. FurnishAR holds its 10% and **owes the shop its share**, which it pays out and records (`store_remittances`). The processing fee is shown separately; a shop's exact net is never promised in advance.
  - GCash settling straight to a shop needs PayMongo Split Payments (activated by PayMongo, with the shop registered as a child merchant) and `PAYMONGO_SPLIT_MODE=split`.
- **The fee:** the buyer pays the shop's price **plus a 10% service fee**. Per payment, `payments.fee_mode` says where the fee is:
  - `accrual`: the shop owes it;
  - `platform_split`: PayPal took it and reported it;
  - `platform_held`: a GCash payment was received by FurnishAR's PayMongo account; the fee is accrued and held, not "collected";
  - `provider_split`: expected via PayMongo Split Payments, not collected until reconciled.

  Shops see the figures in the portal; an admin records settlements and payouts in `/admin/billing`.

## A PayPal payment, and who is told (0017)

The brief's example: a ₱10,000 piece. FurnishAR's fee is 10% **of the
subtotal** (₱1,000), never of the total; the buyer pays ₱11,000.

| | Amount | Where it is recorded |
|---|---|---|
| Buyer paid (gross) | ₱11,000 | `payments.amount` |
| Store portion (the furniture money) | ₱10,000 | `payments.store_portion` |
| FurnishAR service fee | ₱1,000 | `payments.platform_fee` |
| Fee mode | `platform_split` or `accrual` | `payments.fee_mode` |
| Fee status | `collected` only when PayPal reported taking exactly ₱1,000 for FurnishAR; otherwise `accrued` | `payments.fee_status` |
| PayPal processing fee | whatever PayPal reports (the shop's) | `payments.processing_fee` |
| Capture id, PayPal order id, date | from PayPal | `capture_id`, `provider_order_id`, `captured_at` |

Every amount comes from the database (`begin_payment`), never the browser. An
order is paid only after the server captured it with PayPal and PayPal's order
matches the attempt it recorded: order, stage, amount, currency, the shop's
merchant id, and — for a split — the requested fee. Clicking PayPal, opening
PayPal or coming back with a `token` in the address proves nothing.

When the payment is recorded, the database queues three emails with it
(`payment_notifications`): the **buyer's** "Payment received — Order …", the
**shop's** "New payment received — Order …" and the **superadmin's**
"FurnishAR payment received — ₱1,000 platform fee collected / accrued". They
go out through the existing Gmail sender (`lib/notify.js`), each exactly once,
whichever of the buyer's return, a refresh, a capture retry or PayPal's webhook
gets there first. An accrued fee is never called received or collected. If
Gmail is down, the payment stays paid and the emails are retried (next touch of
that payment, or the daily `/api/cron/payment-reminders` run, up to five
attempts). Declined, pending, mismatched and wrong-currency payments send no
"payment received" email.

For a custom build the fee is computed once at the quote; the deposit and the
balance each carry their part, and together exactly the order's fee.

A PayPal refund updates the payment and the order. FurnishAR's fee counts as
refunded when the shop refunded an accrued payment, or — for a split — only
when PayPal says it returned the platform fee. The buyer, the shop and the
superadmin are emailed.

## Environment variables (server only — Vercel → Settings → Environment Variables)

| Variable | What it is |
|---|---|
| `PAYPAL_CLIENT_ID` | PayPal REST app client ID (developer.paypal.com → Apps & Credentials) |
| `PAYPAL_CLIENT_SECRET` | That app's secret. **Never** a `NEXT_PUBLIC_` variable. |
| `PAYPAL_ENV` | `sandbox` (default) or `live` |
| `PAYMENT_RECORDER_SECRET` | A random string, 32+ characters. Must match the hash stored in the database (below). |
| `GMAIL_USER` | The Gmail address that sends receipts and order emails, e.g. `furnishar.orders@gmail.com` |
| `GMAIL_APP_PASSWORD` | A Google **App Password** for that Gmail (16 letters; spaces are fine). Not the normal Gmail password. |
| `RESEND_API_KEY` / `EMAIL_FROM` | Alternative to Gmail. Only used when the Gmail pair is not set; without a verified domain Resend only delivers to its own account's address. |
| `SITE_URL` | optional, e.g. `https://furnisharv1.vercel.app` — where PayPal and PayMongo send buyers back |
| `PAYMONGO_*` | PayMongo's test/live keys, webhook secret, GCash and split settings — see `PAYMONGO-GCASH-INTEGRATION.md` §6. There is no GCash key. |

Payments stay switched off until the recorder secret and at least one provider (PayPal, or PayMongo with GCash enabled) are set. Without an email sender the orders still work; the emails are skipped and logged.

## The payment-recorder secret

The server presents this secret when it records a payment that PayPal has confirmed. The database keeps only its SHA-256 hash, in a schema no client can read. So a buyer who calls the database directly cannot fake a payment.

1. Generate a value: `openssl rand -hex 32`.
2. Put it in Vercel as `PAYMENT_RECORDER_SECRET`.
3. Run this once in the Supabase SQL editor, with the same value:

```sql
insert into billing_private.secrets (name, sha256_hex)
values ('payment_recorder', encode(sha256(convert_to('<the value>', 'UTF8')), 'hex'))
on conflict (name) do update set sha256_hex = excluded.sha256_hex;
```

To rotate it, repeat all three steps with a new value.

## Each shop

In `/portal`, under **Billing & store type**:

- **Store type:** stocked or custom.
- **PayPal seller account:** connected with a PayPal Merchant ID, which PayPal checks, or through PayPal's own onboarding page. Checkout by PayPal opens only once PayPal reports the account `CONNECTED` (0011). The "PayPal email" field is a record for the shop only; it no longer enables checkout.
- **GCash via PayMongo:** nothing to connect. An administrator enables GCash for a shop in `/admin/billing`, and the portal shows "Available", "Pending setup" or "Not enabled" and where the money goes.
- **Notification email:** optional. If it's empty, order emails go to the owner's sign-in email.

A shop can take online orders once it can be paid through at least one method.

## Limits worth knowing

- **Pending captures:** a capture that comes back PENDING is not recorded as paid. Since 0011 the `PAYMENT.CAPTURE.COMPLETED` webhook records it when it clears.
- **Refunds:** refunds are done by the shop in its own PayPal account; since 0011 the refund webhook records them (`payment_refunds`, seller and platform portions). A payment that arrives after an order has already moved on (paid twice, or the stock ran out) is recorded with `applied = false`, and the shop is emailed to refund it.
- **Automatic 10% split:** `PAYPAL_FEE_MODE=platform_split`, only once PayPal has enabled the partner app for platform fees and the seller granted the permission (0011).

## Tests

- `node --test tests/billing.test.js`: the database rules, against a local Postgres.
- `node --test tests/orders.test.js`: the server, against a fake PayPal.
- `node --test tests/paypal-notifications-db.test.js tests/paypal-payment-notifications.test.js`: the PayPal split and the exactly-once payment emails (0017).
- `node --test tests/paymongo-db.test.js tests/paymongo-server.test.js`: GCash via PayMongo — database rules and server, against a stand-in PayMongo.
- `npm run check:billing`: the browser flow end to end, PayPal and GCash. Run `npm run build` first.

## Gmail App Password (for receipts)

1. Use a Gmail account for the shop platform (a new one such as `furnishar.orders@gmail.com` is best).
2. Turn on **2-Step Verification**: myaccount.google.com → Security → 2-Step Verification.
3. Create an App Password: myaccount.google.com/apppasswords → name it "FurnishAR" → **Create**. Copy the 16-letter password.
4. In Vercel add `GMAIL_USER` (the Gmail address) and `GMAIL_APP_PASSWORD` (the 16 letters), then redeploy.

Gmail allows about 500 emails a day from a personal account.

## Delivery, pickup and receipts (0010)

- At checkout the buyer chooses **free delivery** (address, municipality, mobile number) or **store pickup**.
- Each shop sets how many days delivery and pickup take (portal → Billing & store type).
- When an order is paid — or a custom build's deposit is — the database stamps an **estimated arrival date**: today + those days (+ the quoted lead time for a custom build).
- The shop moves a paid order along: **Out for delivery** / **Ready for pickup** → **Delivered / Picked up**. Each step emails the buyer.
- The buyer gets an itemised **receipt email** on payment and can open or print it any time at `/account/receipt/<order>`.
