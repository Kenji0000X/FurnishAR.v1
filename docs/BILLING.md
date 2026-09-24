# Orders & payments — setup

> **Since 0011** shops are paid through a connected PayPal **seller** account (Partner Referrals), not a typed email; the fee can be split by PayPal (`platform_split`) or accrue (default); webhooks, refunds and reminders exist. See `GOOGLE-PAYPAL-SETUP.md`. The sections below describe the 0009/0010 base that still applies.

DFD process **P10**, data store **D5**. Migration `supabase/migrations/0009_orders_billing.sql`.

## How the money moves

- **Stocked shops**: the buyer pays in full. The piece is held for 30 minutes while they are on PayPal.
- **Custom shops**:
  1. The buyer sends a request.
  2. The shop quotes a price and lead time.
  3. The buyer pays a 50% deposit.
  4. The shop marks the piece ready.
  5. The buyer pays the balance.
- **Where the money goes:** every payment goes **directly to the shop's own PayPal account**. FurnishAR never holds buyer money.
- **The fee:** the buyer pays the shop's price **plus a 10% service fee**. The fee accrues per payment in `payments.platform_fee`. Shops see what they owe in the portal, and an admin records settlements in `/admin/billing`.

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
| `SITE_URL` | optional, e.g. `https://furnisharv1.vercel.app` — where PayPal sends buyers back |

Payments stay switched off until PayPal and the recorder secret are both set. Without an email sender the orders still work; the emails are skipped and logged.

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

In `/portal`, under **Billing & store type**, each shop sets three things:

- **Store type:** stocked or custom.
- **PayPal email:** where buyers pay the shop. It must be a PayPal account that can receive payments. A Business account is best.
- **Notification email:** optional. If it's empty, order emails go to the owner's sign-in email.

## Limits worth knowing

- **Pending captures:** a capture that comes back PENDING is not recorded as paid. Since 0011 the `PAYMENT.CAPTURE.COMPLETED` webhook records it when it clears.
- **Refunds:** refunds are done by the shop in its own PayPal account; since 0011 the refund webhook records them (`payment_refunds`, seller and platform portions). A payment that arrives after an order has already moved on (paid twice, or the stock ran out) is recorded with `applied = false`, and the shop is emailed to refund it.
- **Automatic 10% split:** `PAYPAL_FEE_MODE=platform_split`, only once PayPal has enabled the partner app for platform fees and the seller granted the permission (0011).

## Tests

- `node --test tests/billing.test.js`: the database rules, against a local Postgres.
- `node --test tests/orders.test.js`: the server, against a fake PayPal.
- `npm run check:billing`: the browser flow, end to end. Run `npm run build` first.

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
