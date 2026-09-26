# GCash via PayMongo

FurnishAR takes two payment methods: **PayPal** (0009–0011) and **GCash**,
processed by **PayMongo** (0016). GCash is a PayMongo *payment method*, not a
separate integration: FurnishAR authenticates to PayMongo with PayMongo's own
keys and asks for `payment_method_types: ["gcash"]`. **There is no GCash API
key**, and nothing here ever asks for one.

The provider added in 0015 was replaced by PayMongo in 0016; migration 0015 is kept only as history.

Google sign-in stays the identity for buyers and stores. A GCash phone number
is never an identity, and a buyer never "connects" GCash to FurnishAR: they
authorise one payment on PayMongo's hosted page. FurnishAR never sees or stores
a GCash number, PIN, OTP or password.

Code: `lib/money.js`, `lib/paymongo.js`, `lib/providers/paymongo.js`,
`lib/orders.js` (checkout, `verify`, `refund`), `lib/paymongo-webhook.js`,
`app/api/paymongo/webhook/route.js`, migration `0016_paymongo_gcash.sql`.
DFD: P10 ↔ PayMongo (`docs/FURNISHAR-DFD-V2.md`).

## 1. Who receives the money

A PayMongo Checkout Session pays the PayMongo account that owns the keys —
FurnishAR's. Each store is set up by an admin in one of two ways
(`store_payment_accounts`, provider `paymongo`):

| Settlement | Who receives the payment | FurnishAR's 10% | The store's share |
|---|---|---|---|
| `platform` (default) | FurnishAR's PayMongo account, less PayMongo's processing fee | **Held** (`fee_mode = platform_held`): accrued and held by FurnishAR, never reported as "collected" | **Owed** to the store; paid out by FurnishAR and recorded (`store_remittances`) |
| `split` | PayMongo Split Payments sends the product share to the store's child merchant | **Expected** (`fee_mode = provider_split`) until reconciled against PayMongo's records | Settled by PayMongo, less any processing fee PayMongo deducts |

`split` is offered only when `PAYMONGO_SPLIT_MODE=split` **and** the store has
a PayMongo child-merchant id. Split Payments must be activated by PayMongo for
FurnishAR's account, and each store must be registered as a child merchant
under FurnishAR (the *merchant relationship*). Until both are true, every
store uses `platform`.

The amounts shown to a store never promise its exact net: PayMongo's
processing fee is recorded per payment (`payments.processing_fee`, from the
payment's `fee`) and shown separately in Billing.

## 2. Setting a store up

1. Admin → Billing → the store's **GCash…** button.
2. Choose **On — FurnishAR receives and pays the shop** (`platform`), or,
   when split is available, **On — PayMongo splits to the shop's child
   merchant** and enter the child-merchant id.
3. **Save GCash Setup** calls `admin_set_paymongo_account()`, which checks
   `is_platform_admin()` and writes an audit row (`paymongo.enabled` /
   `paymongo.disabled`).

The store sees **GCash via PayMongo** in its portal billing:

| Shown | Meaning |
|---|---|
| Available | Buyers can pay this store with GCash |
| Pending setup | GCash is on for FurnishAR, but not yet for this store (or split is chosen but not activated) |
| Not enabled | GCash is not switched on for FurnishAR |

The portal reads only safe booleans (`providers[].gcashEnabled`,
`splitEnabled`, `sandbox`). No key ever reaches the browser.

## 3. The payment, step by step

1. **Buyer chooses** `○ PayPal` / `○ GCash — Secure payment via PayMongo`.
   Only the methods the store accepts *and* this server has switched on are
   offered (`/api/sb/orders/providers` → `store_payment_providers()`).
2. **The server decides the money.** `begin_payment(order, env, 'paymongo')`
   returns the stage (full / deposit / balance), the amount and FurnishAR's
   fee from the database. Anything the browser sends as a price, total, payee
   or fee mode is ignored.
3. **Centavos in one place.** `lib/money.js` converts pesos to centavos
   without floating point: ₱10,000 → subtotal `10000.00`, fee `1000.00`,
   total `11000.00` → **1100000** centavos.
4. **Checkout Session** — `POST /v1/checkout_sessions` with the **secret
   key**: two line items (the piece and "FurnishAR service fee (10%)") that
   add up to exactly what is due, `payment_method_types: ["gcash"]`,
   `reference_number` = FurnishAR's reference (`<order ref>-<F|D|B><8 hex>`),
   `metadata.reference`, and success / cancel URLs:
   `/account/payment/return?provider=paymongo&ref=…&result=success|cancel`.
   In split mode, `split_payment.recipients` names the child merchant.
5. **Attempt recorded before the buyer leaves** —
   `server_record_payment_attempt()` with the session id, reference, amount,
   fee, fee mode, payee (`furnishar-paymongo`, or the child merchant) and
   method `gcash`. Stock is **not** decremented here; the 30-minute hold from
   order creation stands.
6. **Buyer pays in GCash** on PayMongo's page.
7. **Return is not proof.** `/account/payment/return` asks the server
   (`verify`), which checks the reference belongs to this buyer (RLS),
   re-reads the session from PayMongo with the secret key, and judges it
   (`judgeSession`):

   | Verdict | What happens |
   |---|---|
   | paid, exact amount and PHP | `record_capture()` — idempotent on PayMongo's payment id; emails once |
   | paid, other amount | recorded as PayMongo reports it, **unapplied**; admins told to refund |
   | paid, other currency | not recorded; admins told |
   | pending | nothing yet; the webhook finishes it |
   | failed | attempt marked declined |
   | expired / cancelled | attempt marked cancelled |

8. **Webhook is authoritative** for payments the buyer never returned from
   (closed tab, lost signal): the same settlement runs from the signed event.

Switching methods is safe: each attempt is recorded separately, and
`record_capture()` applies money only while the order still owes that stage.
A late second payment (PayPal after GCash, or the reverse) is recorded as
unapplied and refunded — an order is never paid twice.

Order states (`pending_payment`, `paid`, `deposit_paid`, …) stay separate
from attempt states (`CREATED`, `PENDING`, `DECLINED`, `CANCELLED`, …).

## 4. Webhooks

URL: `https://<site>/api/paymongo/webhook`. Events:
`checkout_session.payment.paid`, `payment.paid`, `payment.failed`,
`payment.refunded`, `payment.refund.updated`.

1. **Signature** — `Paymongo-Signature: t=<unix>,te=<sig>,li=<sig>`;
   `sig = HMAC-SHA256(PAYMONGO_WEBHOOK_SECRET, "<t>.<raw body>")`. The `te`
   value is checked in test mode, `li` in live mode, with a constant-time
   comparison. Timestamps older than 5 minutes are refused (replays).
   Nothing is read from an unverified body.
2. **Mode** — a live event never settles a test-mode server, nor the reverse.
3. **Once** — `server_claim_webhook_event('paymongo:<event id>')`; a
   redelivery answers `{ duplicate: true }`.
4. **Only a prompt** — the session is re-read from PayMongo before anything is
   recorded (§3 step 7). A body claiming "paid" is not believed.

200 = do not resend (processed, duplicate, or not ours); 400 = unverified or
malformed; 500 = retry; 503 = PayMongo not configured.

## 5. Refunds

Admin → Billing → **Refunds…** on a store with GCash sales lists its GCash
payments. **Refund through PayMongo** calls the `refund` action, which:

- checks `is_platform_admin()`;
- reads the payment under RLS and refuses more than what is left (centavos);
- `POST /v1/refunds { amount, payment_id, reason: requested_by_customer, notes }`;
- records it with `server_record_refund()` (PayMongo's refund id and status)
  only when PayMongo reports `succeeded`; a `pending` refund is recorded by
  the `payment.refund.updated` webhook.

GCash refunds usually reflect within the day. For split payments PayMongo
shares the refund proportionally between the parties; FurnishAR does not guess
the split of a refund — reconcile it from PayMongo's records.

PayPal refunds are unchanged (issued in PayPal, recorded by webhook; 0011).

## 6. Environment variables

Server only. **None is ever a `NEXT_PUBLIC_` variable**, and none is ever
logged or sent to the browser.

| Variable | Value | Notes |
|---|---|---|
| `PAYMONGO_ENV` | `test` (default) or `live` | Anything but an explicit `live` is test. Maps to the database's `sandbox` / `live`. |
| `PAYMONGO_SECRET_KEY` | `sk_test_…` / `sk_live_…` | Must match `PAYMONGO_ENV`. Mark **Sensitive** on Vercel. |
| `PAYMONGO_PUBLIC_KEY` | `pk_test_…` / `pk_live_…` | Checked for the right prefix; the hosted checkout needs no key in the browser. |
| `PAYMONGO_WEBHOOK_SECRET` | the webhook's signing secret (`whsk_…`) | Required: without it GCash is not offered. Sensitive. |
| `PAYMONGO_GCASH_ENABLED` | `true` once GCash is activated on the PayMongo account | Default off. |
| `PAYMONGO_SPLIT_MODE` | `disabled` (default) · `accrual` · `split` | `split` only after PayMongo activates Split Payments and child merchants exist. |
| `PAYMONGO_API_BASE` | — | Test harness only; accepted only for `http://127.0.0.1` / `localhost`. |

`PAYMENT_RECORDER_SECRET` (existing) is required too. GCash is offered only
when the keys match the mode, the webhook secret is set, GCash is enabled, and
the recorder secret is set. Admin → Billing names configuration problems in
words (a public key in the secret field, a live key in test mode, …) and never
shows a key.

## 7. Setup and test procedure

1. **PayMongo dashboard** (test mode): Developers → API keys → copy the test
   secret key (`sk_test_…`) and public key (`pk_test_…`). Confirm **GCash** is
   listed as an activated payment method.
2. **Webhook**: Developers → Webhooks → create one for
   `https://<site>/api/paymongo/webhook` with the events in §4. Copy its
   signing secret.
3. **Vercel → Project → Settings → Environment Variables** (Production, and
   Preview if wanted): `PAYMONGO_SECRET_KEY` (Sensitive),
   `PAYMONGO_PUBLIC_KEY`, `PAYMONGO_WEBHOOK_SECRET` (Sensitive),
   `PAYMONGO_GCASH_ENABLED=true`, `PAYMONGO_ENV=test`. Redeploy.
4. Apply migration `0016_paymongo_gcash.sql`.
5. `/admin/billing` → the **GCash via PayMongo** panel should read
   "Configured · FurnishAR receives GCash payments · PayMongo Test Mode" with
   no problems listed.
6. Set one test store to GCash (§2), buy with **GCash**, authorise with
   PayMongo's GCash test flow, and check: "Payment received", the receipt
   ("Paid via GCash · PayMongo"), the store's "GCash Sales Owed to You", and
   admin "Held from GCash Sales" / "PayMongo Processing Fees".
7. Cancel a checkout: "Payment cancelled — Nothing was charged".
8. Refund it from Admin → Billing → Refunds….

Never put keys in the repository, in a `NEXT_PUBLIC_` variable, or in chat.

## 8. Verify before live

The session that wrote this could not open PayMongo's documentation
(developers.paymongo.com and api.paymongo.com were blocked by its network
policy). The names below come from PayMongo's public documentation as indexed
by search. **Confirm each against the PayMongo docs and dashboard before
setting `PAYMONGO_ENV=live`.**

| Item | What the code assumes | Where |
|---|---|---|
| Base URL, auth | `https://api.paymongo.com`, HTTP Basic with the secret key and an empty password | `lib/paymongo.js` |
| Checkout API version | `POST /v1/checkout_sessions` (PayMongo recommends v2 for new features; the v2 shape was not verified) | `createCheckoutSession()` |
| Checkout body | `data.attributes { line_items[{ name, amount, currency, quantity }], payment_method_types, success_url, cancel_url, reference_number, description, send_email_receipt, show_description, show_line_items, metadata }` | `createCheckoutSession()` |
| Checkout response | `data.id` (`cs_…`), `data.attributes.checkout_url` | same |
| Retrieve | `GET /v1/checkout_sessions/{id}` → `attributes.payments[]`, each with `attributes { amount, fee, net_amount, currency, status, livemode, source.type, billing.email }` | `getCheckoutSession()`, `summarisePayment()` |
| Payment statuses | `paid`, `failed`, `pending` | `judgeSession()` |
| Webhook header | `Paymongo-Signature: t=,te=,li=`, HMAC-SHA256 of `t.body` | `verifyWebhookSignature()` |
| Webhook event shape | `data.id`, `data.attributes { type, livemode, data }` | `parseEvent()` |
| Event names | `checkout_session.payment.paid`, `payment.paid`, `payment.failed`, `payment.refunded`, `payment.refund.updated` | `lib/paymongo-webhook.js` |
| Refunds | `POST /v1/refunds { amount, payment_id, reason, notes }`; reasons `duplicate`, `fraudulent`, `requested_by_customer`, `others`; statuses `pending`, `succeeded`, `failed` | `createRefund()` |
| Split Payments | `split_payment { recipients[{ merchant_id, split_type: 'fixed', value }] }` — the value's unit (centavos assumed), whether `transfer_to` is required, and how the platform's remainder is defined | `splitFor()` |
| Reference rules | length and characters allowed in `reference_number` (ours ≤ 51, `[A-Za-z0-9-]`) | `referenceFor()` |
| Processing fee | that `fee` on the payment is PayMongo's processing fee in centavos | `summarisePayment()` |

## 9. Going live, in order

1. PayMongo account verified for live payments; GCash activated in live.
2. Everything in §8 confirmed.
3. Live keys (`sk_live_…`, `pk_live_…`) and a live webhook (its own secret) —
   set on Vercel, `PAYMONGO_ENV=live`. Redeploy.
4. Admin panel shows no problems and no "Test Mode" chip.
5. One small real GCash purchase and refund, end to end.
6. Split: only after PayMongo activates it and each child merchant is
   registered — then `PAYMONGO_SPLIT_MODE=split` and the per-store setting.

## 10. Tests

- `tests/paymongo-server.test.js` — money helper, config (missing / test /
  wrong or live keys / GCash disabled), checkout (reference, centavos,
  success / cancel URLs, client totals ignored, fee line, split), verify
  (paid, pending, failed, cancelled, wrong amount or currency, other buyer's
  reference), webhooks (valid, bad / stale / wrong-mode signature, duplicate,
  refunds), admin-only refunds, email wording, PayPal unchanged.
- `tests/paymongo-db.test.js` — 0016 against Postgres: no earlier provider left,
  admin-only setup, the ₱10,000 example, payee and fee-mode enforcement,
  paid once with the fee held and stock unchanged, PayPal ↔ GCash switching,
  payouts, refunds, custom deposit + balance fees, disabling.
- `scripts/check-billing.mjs` — the whole path in a browser against a
  stand-in PayMongo (signed webhooks included).

## Sources

- PayMongo Checkout API, Webhooks (signature verification), Refunds and
  Split Payments documentation at developers.paymongo.com and
  docs.paymongo.com, as indexed by search in September 2026.
