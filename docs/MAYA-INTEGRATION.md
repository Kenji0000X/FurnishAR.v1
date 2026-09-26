# Maya integration

Maya Checkout as FurnishAR's second payment provider, beside PayPal, in the
same orders, payments, fee and email system. Written 2026-09-26 with
`supabase/migrations/0015_payment_providers.sql`, `lib/maya.js`,
`lib/providers/`, `lib/orders.js` and `lib/maya-webhook.js`.

**Status: sandbox-ready, not live.**
- Not configured on Vercel (no `MAYA_*` variables).
- 0015 is not applied to production.
- Tested against a fake Maya only.
- Payment Facilitator is **not** enabled.

## 1. Who receives the money

This is the one place Maya differs from PayPal, and every screen, email and
report says it the same way.

| | Money lands in | FurnishAR's 10% | The shop's share | `fee_mode` |
|---|---|---|---|---|
| **PayPal** | the shop's own PayPal account | owed by the shop (`accrual`), or taken by PayPal and reported (`platform_split`) | already the shop's | `accrual` / `platform_split` |
| **Maya, platform collect** (default) | **FurnishAR's** Maya merchant account (the owner of the API keys) | already FurnishAR's: recorded as **collected** | **owed to the shop** by FurnishAR, paid out and recorded as a remittance | `platform_collect` |
| **Maya, PayFac** (only if Maya enables it) | the shop's Maya sub-merchant | owed by the shop (`accrual`), or expected from Maya's settlement (`provider_settlement`) | already the shop's | `accrual` / `provider_settlement` |

Two consequences:

- **With platform collect, FurnishAR holds buyer money for the shop.** That
  is a real obligation. It shows as "Owed to Shops (Maya)" in admin billing
  and as "Maya Sales Owed to You" in the store portal. It goes down only when
  an admin records a payout (`record_store_remittance`).
- **`provider_settlement` is never "collected".** Maya does not report a
  per-payment split to FurnishAR, so the fee stays "expected via Maya
  settlement" until someone reconciles it against Maya's settlement report.

## 2. Setting a store up

There is no "Connect Maya" button. Maya does not offer shops self-service
onboarding into a platform's account. Instead, an administrator opens
**Admin → Billing → Maya…** for a store and chooses one of these:

- **On — FurnishAR collects and pays the shop** (`platform_collect`). Nothing
  is needed from the shop.
- **On — Maya settles to the shop (PayFac)**. Offered only when
  `MAYA_PAYFAC_ENABLED=true`. It needs the shop's sub-merchant ID, city and
  4-digit postal code exactly as Maya registered them.
- **Off**.

`admin_set_maya_account()` checks `is_platform_admin()` and writes the
`store_payment_accounts` row for (store, environment, `maya`). Each change is
recorded in `admin_audit` as `maya.enabled` or `maya.disabled`. The store's
portal then shows **Maya · Set up by FurnishAR** and says where the money
goes.

## 3. The payment, step by step

All amounts, the fee and the payee come from the database. The browser names
a product, an order and a method (`paypal` | `maya`), nothing else.

1. **Choose.** The product page asks `GET /api/sb/orders/providers?store=…`.
   The server intersects `store_payment_providers()` (what the shop is set
   up for, in this server's environment) with the providers this server has
   keys for. Only those methods are offered.
2. **Start.** `POST /api/sb/orders/checkout` or `/pay` with
   `provider: 'maya'`:
   1. `begin_payment(order, env, 'maya')` gives the stage, the amount, the
      fee share and the store's Maya setup;
   2. the server creates a reference, `<order ref>-<F|D|B><8 hex>`, e.g. `7F3A9C21B0-Fa1b2c3d4`;
   3. it calls **Create Checkout with the PUBLIC key**: total, a `subtotal`
      and `serviceCharge` breakdown, one item, the reference as
      `requestReferenceNumber`, and success/failure/cancel URLs;
   4. it records the attempt (`server_record_payment_attempt`, recorder
      secret) before the buyer leaves: checkout id, reference, payee
      (`furnishar-platform` or the sub-merchant) and `fee_mode`. The
      database refuses a payee or fee mode that does not match the store's
      setup.
3. **Pay on Maya.** The buyer pays on Maya's page. FurnishAR never sees their
   card or Maya credentials.
4. **Return.** Maya sends the buyer to
   `/account/payment/return?provider=maya&ref=…&result=…`:
   1. the page removes the reference from the address bar and calls
      `POST /api/sb/orders/verify`;
   2. the server checks the reference is an attempt on the caller's own order
      (RLS read);
   3. it **re-reads the payment from Maya with the SECRET key**
      (`GET /payments/v1/payment-rrns/{ref}`);
   4. it acts on what Maya says, never on `result=`.
5. **Record.** Only `PAYMENT_SUCCESS` for exactly the attempt's amount and
   currency is recorded as paid:
   - `record_capture(…, p_provider => 'maya')` is idempotent on Maya's
     payment id;
   - it refuses a capture whose provider differs from the attempt's;
   - a Maya payment with no attempt is refused.
6. **Emails.**
   - The receipt says "Paid via Maya".
   - The shop's email says "Payment was confirmed through Maya", where the
     money is, and (platform collect) the share owed to them.
   - Admins get the fee notice.

**Other outcomes.**
- **Wrong amount:** recorded as Maya reports it and not applied. The order
  does not move, and the shop and admins are told FurnishAR will refund it.
- **Failed:** the attempt is marked `DECLINED`. The webhook, not the return,
  emails the buyer "Maya did not complete your payment", once.
- **Cancelled, or no payment:** the attempt is marked `CANCELLED`, and the
  page says nothing was charged.

## 4. Webhooks

`POST /api/maya/webhook` (`lib/maya-webhook.js`). Maya's webhooks are **not
signed**, so the body is never believed. The handler:
1. checks the source address against `MAYA_WEBHOOK_ALLOWED_IPS`, if set
   (Vercel's `x-forwarded-for`);
2. takes only the `requestReferenceNumber` from the body;
3. requires the reference to be a recorded Maya attempt; otherwise it answers
   200 and does nothing;
4. re-reads the payment from Maya with the secret key;
5. claims `maya:<payment id>:<status>` in `payment_webhook_events`, so a
   redelivery is a no-op;
6. settles exactly as the return does.

A 500 asks Maya to retry. A claim left unfinished can be taken again after
ten minutes (0011).

Register this URL in Maya Manager for the payment success, failed and expired
events: `https://<site>/api/maya/webhook`.

## 5. Environment variables

Server only; none is ever a `NEXT_PUBLIC_` variable.

| Variable | Value | Notes |
|---|---|---|
| `MAYA_ENV` | `sandbox` (default) or `production` | Maps to the database's `sandbox` / `live`. |
| `MAYA_PUBLIC_KEY` | `pk-…` | Create Checkout only. |
| `MAYA_SECRET_KEY` | `sk-…` | Reading payments. Never logged, never sent to the browser. |
| `MAYA_PAYFAC_ENABLED` | `true` only after Maya enables PayFac | Default off. |
| `MAYA_FEE_MODE` | `accrual` (default) or `provider_settlement` | PayFac stores only. |
| `MAYA_WEBHOOK_ALLOWED_IPS` | comma-separated addresses | Optional; Maya publishes its webhook source addresses. |
| `MAYA_API_BASE` | — | Test harness only; accepted only for `http://127.0.0.1` / `localhost`. |

`PAYMENT_RECORDER_SECRET` (existing) is required too. Maya is offered only
when both keys and the recorder secret are set. Admin → Billing shows
configuration problems in words, for example a public key that looks like a
secret key. It never shows the keys themselves.

## 6. Verify before live

The session that wrote this could not open Maya's documentation (blocked by
its network policy). The names below come from Maya's public documentation
as indexed by search. **Each must be confirmed against
developers.maya.ph / Maya Manager before production.**

| Item | What the code assumes | Where |
|---|---|---|
| Base URLs | `https://pg-sandbox.paymaya.com`, `https://pg.paymaya.com` | `lib/maya.js` `BASES` |
| Auth | HTTP Basic, key as user name, empty password | `basicAuth()` |
| Create Checkout | `POST /checkout/v1/checkouts`, public key → `{ checkoutId, redirectUrl }` | `createCheckout()` |
| Checkout body | `totalAmount { value, currency, details { subtotal, serviceCharge } }`, `buyer { firstName, lastName, contact { email } }`, `items[] { name, quantity, code, amount { value }, totalAmount { value } }`, `redirectUrl { success, failure, cancel }`, `requestReferenceNumber`, `metadata` | `createCheckout()` |
| Reference rules | length limit and allowed characters of `requestReferenceNumber` (ours is 20 characters: the 10-character order reference, `-`, the stage letter and 8 hex digits) | `referenceFor()` |
| Read payments | `GET /payments/v1/payment-rrns/{rrn}` with the secret key → an array; 404 when none | `paymentsForReference()` |
| Payment fields | `id`, `status`, `isPaid`, `amount` (string), `currency`, `requestReferenceNumber`, `receiptNumber`, `buyer.contact.email` | `summarise()` |
| Status names | success `PAYMENT_SUCCESS`; failed `PAYMENT_FAILED`, `PAYMENT_EXPIRED`, `PAYMENT_CANCELLED`, `VOIDED`, `AUTH_FAILED`; pending `PENDING_TOKEN`, `PENDING_PAYMENT`, `FOR_AUTHENTICATION`, `AUTHENTICATING`, `PAYMENT_PROCESSING`, `AUTHORIZED` | `summarise()` |
| Webhook body | the payment resource, or the checkout resource, both carrying `requestReferenceNumber` | `referenceOf()` |
| Webhook signing | none (so every webhook is re-read) | `lib/maya-webhook.js` |
| Webhook retries | non-2xx retried, up to 4 attempts | — |
| PayFac metadata | `metadata.subMerchantRequestReferenceNumber`, `metadata.pf { smi, smn, mci, mpc, mco }` | `createCheckout()` |

The whole flow must then be run once in Maya's sandbox with Maya's test cards
(success, failure, cancel), and the webhook delivery checked in Maya Manager.

## 7. Refunds

Maya refunds are **not automated**. A Maya payment that must be returned (an
unapplied payment, a cancelled order) is refunded in **Maya Manager** by
FurnishAR, because with platform collect the money is in FurnishAR's
account, not the shop's. Recording that refund in FurnishAR's database (as
0011 does from PayPal's refund webhooks) is a follow-up. Until then, the
admin notes the refund against the order.

## 8. PayFac

**Not enabled, and FurnishAR does not claim to be a payment facilitator.**
The code path exists, and is tested, so that enabling it is configuration
rather than a rewrite. It stays off until:

1. Maya confirms Payment Facilitator for FurnishAR's account in writing, and
   whether Maya deducts FurnishAR's share at settlement;
2. each shop is registered with Maya as a sub-merchant, with its ID, city and
   postal code recorded through Admin → Billing;
3. `MAYA_PAYFAC_ENABLED=true` is set, with `MAYA_FEE_MODE` matching the
   agreement.

Until then every Maya payment is platform collect, and the copy says so.

## 9. Going live, in order

1. Apply `0015_payment_providers.sql` to the production Supabase project
   (after 0014, which is also not applied yet).
2. Set `MAYA_PUBLIC_KEY` and `MAYA_SECRET_KEY` for **sandbox** on Vercel;
   leave `MAYA_ENV` unset.
3. Register the webhook URL in the Maya sandbox.
4. Enable Maya for one test store in Admin → Billing.
5. Pay, fail and cancel once each with Maya's sandbox test cards. Confirm the
   order, receipt, emails, webhook log (`payment_webhook_events`) and admin
   figures.
6. Only then: production keys, `MAYA_ENV=production`, the production webhook
   URL, and a decision on who pays shops out, and how often.

## 10. Tests

| Command | Proves |
|---|---|
| `node --test tests/maya-db.test.js` | admin-only setup; payee and fee mode enforced; cross-provider refusal; duplicates; wrong amount unapplied; owed-to-store and payouts; PayFac with provider settlement; turning Maya off closes checkout |
| `node --test tests/maya-server.test.js` | public key to create, secret key to read; checkout never trusts the browser; verify, failed and cancelled states; ownership of the reference; webhook re-read, idempotency and IP allowlist; provider-aware emails |
| `npm run check:billing` | in a real browser, PayPal end to end as before, plus a Maya-only shop paid through a fake Maya, the return page, a webhook redelivery, a cancelled return, the receipt and admin billing |

The database tests need a local Postgres (`FURNISHAR_TEST_PG`).
