# Orders & payments — setup

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
| `RESEND_API_KEY` | Resend API key, for order emails |
| `EMAIL_FROM` | e.g. `FurnishAR <orders@your-domain>` — the domain must be verified in Resend |
| `SITE_URL` | optional, e.g. `https://furnisharv1.vercel.app` — where PayPal sends buyers back |

Payments stay switched off until PayPal and the recorder secret are both set. Without Resend the orders still work; the emails are skipped and logged.

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

- **Pending captures:** a PayPal capture that comes back PENDING (for example, a new seller account under review) is not recorded yet. The buyer is told it is being reviewed. Recording it automatically when it clears would need a PayPal webhook, which is not built yet.
- **Refunds:** refunds are done by the shop in its own PayPal account. A payment that arrives after an order has already moved on (paid twice, or the stock ran out) is recorded with `applied = false`, and the shop is emailed to refund it.
- **Automatic 10% split:** taking the 10% automatically at checkout, instead of billing shops for it, needs PayPal Commerce Platform (partner) approval.

## Tests

- `node --test tests/billing.test.js`: the database rules, against a local Postgres.
- `node --test tests/orders.test.js`: the server, against a fake PayPal.
- `npm run check:billing`: the browser flow, end to end. Run `npm run build` first.
