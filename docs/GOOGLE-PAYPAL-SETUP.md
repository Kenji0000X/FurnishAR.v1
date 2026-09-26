# Google sign-in, PayPal marketplace payments and email — setup

Migration `supabase/migrations/0011_google_paypal_marketplace.sql`. DFD: P1, P7, P8, P10 (see
`FURNISHAR-DFD-V2.md`, note 10). The flow before this change is recorded in
`AUTH-PAYMENTS-FLOW-MAP.md`.

**Two account systems, not one.**
- **Google is the FurnishAR identity.** It signs you in through Supabase Auth, and your key is `auth.users.id`.
- **PayPal is the payment provider.**
  - A shop connects a PayPal *seller* account, identified by its merchant id.
  - A buyer uses PayPal only on PayPal's own page, for one payment, and never connects it to FurnishAR.
- Neither account is the other's key.
- A Google login never grants admin. Admin rights come only from `platform_admins`.

Real Google accounts may be used while PayPal stays in the sandbox.

## 1. Environment variables

These are server-only (Vercel → Settings → Environment Variables). Never use a `NEXT_PUBLIC_` name for any of them.

| Variable | Required | What it is |
|---|---|---|
| `SUPABASE_URL`, `SUPABASE_PUBLISHABLE_KEY` | yes | As before. Never the secret or service_role key. |
| `SITE_URL` | yes | For example `https://furnisharv1.vercel.app`. This is where Google and PayPal send people back. |
| `PAYPAL_ENV` | no | Defaults to `sandbox`. Only the exact value `live` makes it live; any other value is sandbox and shows up as a configuration problem. |
| `PAYPAL_CLIENT_ID`, `PAYPAL_CLIENT_SECRET` | yes | The **partner** REST app's credentials. |
| `PAYPAL_SELLER_ONBOARDING` | no | `merchant_id` (default) or `partner_referrals`. See §3. |
| `PAYPAL_PARTNER_MERCHANT_ID` | for `partner_referrals` only | FurnishAR's own PayPal merchant id. |
| `PAYPAL_PARTNER_ATTRIBUTION_ID` | for `platform_split` | The BN code PayPal gives a partner. |
| `PAYPAL_FEE_MODE` | no | `accrual` (the default) or `platform_split`. |
| `PAYPAL_PLATFORM_FEE_RATE` | no | Must be `0.10`. The database's `platform_fee_rate()` is what is charged, and any other value is reported as a problem. |
| `PAYPAL_WEBHOOK_ID` | recommended | The id of the webhook you create in the PayPal app. Without it, webhooks are refused. |
| `PAYMENT_RECORDER_SECRET` | yes | 32+ random characters. Its SHA-256 is stored in `billing_private.secrets` (see `BILLING.md`). Every server-only database function checks it. |
| `CRON_SECRET` | for reminders | 16+ random characters. Vercel Cron sends it as `Authorization: Bearer …`. |
| `PAYPAL_REMINDER_COOLDOWN_HOURS` | no | Default 72. The minimum gap between payment-setup reminder emails to one shop. |
| `PAYPAL_REMINDER_MAX` | no | Default 3. The most reminders one shop ever receives. |
| `GMAIL_USER`, `GMAIL_APP_PASSWORD` | for email | A Gmail account and its App Password (see `BILLING.md`). |
| `RESEND_API_KEY`, `EMAIL_FROM` | alternative | Used only when the Gmail pair is not set. |

Nothing above ever reaches a browser. `/api/sb/orders/config` reports only whether each feature is on, the environment and the fee mode. `/api/sb/payments/admin` (admins only) adds the list of configuration problems, still without any values.

## 2. Google sign-in (Supabase Auth)

1. **Google Cloud Console** → APIs & Services → OAuth consent screen:
   - User type: External.
   - Scopes: only `openid`, `.../auth/userinfo.email` and `.../auth/userinfo.profile`. FurnishAR asks for nothing else.
2. **Credentials** → Create OAuth client ID → Web application:
   - Authorised JavaScript origins: your `SITE_URL`, plus `http://localhost:3000` for development.
   - Authorised redirect URI: `https://<project-ref>.supabase.co/auth/v1/callback`. This is Supabase's address, not FurnishAR's.
3. **Supabase dashboard** → Authentication → Providers → Google:
   - Enable it and paste the client ID and secret.
   - The Google client secret lives in Supabase, never in this app.
4. **Supabase** → Authentication → URL Configuration:
   - Site URL: `SITE_URL`.
   - Redirect URLs: `https://<your-site>/auth/callback` and `http://localhost:3000/auth/callback`. Add preview URLs only if you need them.

### How the flow works

1. The **Continue with Google** button calls `GET /api/sb/auth/google`.
   - The server makes a PKCE verifier and keeps it in an httpOnly cookie (`fa_oauth`, scoped to `/api/sb/auth`, 10 minutes).
   - It asks Supabase for Google's URL and redirects there.
2. Google hands back to Supabase, which sends the browser to `/auth/callback?code=…`.
3. The callback page sends the code to `POST /api/sb/auth/exchange`.
   - The server trades the code and the cookie's verifier for a session.
   - It drops Google's `provider_token` and `provider_refresh_token`; FurnishAR keeps no Google tokens.
   - It clears the cookie and returns the session with the safe `next`.
4. `my_role()` decides where to go:
   - admin → `/admin`
   - owner or pending → `/portal`
   - buyer → `next` or `/account`
   - no role yet → `/onboarding`

Failures return to `/login` (or `/portal` for the store intent) with `?oauth_error=`, which is shown as a sentence:

| Failure | What the person sees |
|---|---|
| Cancelled at Google | `auth.google-cancelled` |
| Google not enabled in Supabase | `auth.google-unavailable` (the server checks before redirecting, so the person never lands on a Supabase JSON error page) |
| Missing code | `auth.google-failed` |
| Flow older than 10 minutes | `auth.google-expired` |
| The same callback opened twice | `auth.google-used`. If the tab is already signed in, it simply continues. |
| Network failure | `auth.network` |
| Account has no role yet | `/onboarding` |

`next` goes through the same rule everywhere: a same-site path; no `//`, `\` or control characters; never `/api/` or `/auth/callback`.

### Onboarding (`/onboarding`)

"What will you use FurnishAR for?"
- **Shopping:** asks only for the municipality. The name comes from Google, and there is no second password. `complete_buyer_onboarding` writes the `buyers` row, and a `buyer_welcome` email goes out.
- **I run a store:** store name, contact number, what they list. `submit_store_application` stores the **account id** (`applicant_user_id`) as well as the email. The applicant gets `store_application_received`, and every admin gets `store_application_admin_notice`.
  - Approval links the store by account id, falling back to the email for older applications. The applicant gets `store_approved`, with a "Connect PayPal" link, or `store_rejected`.
- The database refuses to re-onboard an admin, owner, applicant or buyer. Nothing on this path writes `platform_admins`.

### Existing password accounts (identity-linking decision)

Supabase links identities automatically by email:
- When someone signs in with Google using the same email as an existing, **confirmed** email/password account, the Google identity joins that same `auth.users` row.
  - The id, the role and every order stay the same, and no duplicate account is created.
- If the existing account's email was **never confirmed**, Supabase removes the unconfirmed identity when Google links. This prevents pre-account takeover, and Google's verified email becomes the way in.

FurnishAR relies on that behaviour and does not add a linking UI of its own. Manual linking stays off. A person whose Google email differs from their password account's email ends up with two separate accounts. Merging them is a manual support task: pick one and move the store membership or buyer row in SQL. It is not done automatically.

## 3. PayPal (sandbox first)

In developer.paypal.com → Sandbox:
1. **Partner account.** Your business sandbox account. Its merchant id is `PAYPAL_PARTNER_MERCHANT_ID`.
   - Create a REST app under it; that gives `PAYPAL_CLIENT_ID` and `PAYPAL_CLIENT_SECRET`.
   - For `platform_split`, ask PayPal to enable the app for the Partner Referrals / platform-fee features and to issue a BN code (`PAYPAL_PARTNER_ATTRIBUTION_ID`). Until PayPal enables it, keep `PAYPAL_FEE_MODE=accrual`.
2. **Seller accounts.** One sandbox business account per test shop. The shop owner connects it from **Portal → Billing → Connect PayPal**:
   - The server starts Partner Referrals with a tracking id that names the store (`fa-<store id>-<random>`).
   - The owner signs in on PayPal's page and returns to `/portal?paypal_onboarding=return#billing`.
   - The server then asks PayPal for the merchant id behind **our** tracking id and reads that merchant's integration. The query string PayPal appended is not trusted.
3. **Buyer accounts.** Personal sandbox accounts, used only on PayPal's checkout page.

### How a shop connects: `PAYPAL_SELLER_ONBOARDING`

| Mode | How it works | Needs from PayPal |
|---|---|---|
| **`merchant_id`** (default) | In Portal → Billing, the owner pastes their **PayPal Merchant ID** (PayPal → Account Settings → Business information; in the sandbox it's the Business account's **Account ID**). The server first checks the owner through the database. Then it asks PayPal to create a ₱1.00 order payable to that ID; the order is never approved or captured, so nothing is charged. PayPal refuses an ID that doesn't exist or can't receive money, and the shop is then told why. Only an accepted ID becomes `CONNECTED`. **Check Status** re-runs the check. The owner can **Disconnect**, and an admin can disconnect any shop from `/admin/billing`. | Nothing beyond a normal REST app |
| `partner_referrals` | PayPal-hosted seller onboarding (Connect PayPal → sign in on PayPal → back). The status is read from PayPal's merchant-integration API. | PayPal must enable Partner Referrals for the app. Without it, the call returns `403 NOT_AUTHORIZED`. |

Trade-offs of `merchant_id`:
- **No `platform_split`.** Only a seller who went through Partner Referrals can grant the partner fee, so the 10% always accrues.
- **No automatic seller-status updates.** A PayPal restriction shows up at the next Check Status or as a failed capture. The admin can disconnect a shop.

`PAYPAL_PARTNER_MERCHANT_ID` is needed only for `partner_referrals`.

### Seller status (`store_payment_accounts.onboarding_status`)

| Status | Meaning | Can take payments |
|---|---|---|
| `NOT_CONNECTED` | Never started | no |
| `ONBOARDING_STARTED` | Link issued, not finished | no |
| `PENDING` | PayPal email not confirmed | no |
| `CONNECTED` | Permissions granted, email confirmed, payments receivable | **yes** |
| `LIMITED` / `DISABLED` | PayPal limited the account | no |
| `ERROR` | Permissions missing or revoked, or the merchant is already used by another store | no |
| `PAYMENTS_NEED_ATTENTION` | PayPal says payments are not receivable | no |

- A shop takes online orders (stock checkout **and** custom requests) only when `CONNECTED` in the current `PAYPAL_ENV`.
- Product pages say "finishing its PayPal setup" instead of showing a button the server would refuse.
- `store_payout.paypal_email` stays as a legacy or manual record only.
- **Impact on existing shops:** shops that previously typed a PayPal email stop taking new online orders until they connect. That is the rule. PayPal orders already approved before the migration can still be captured; they are checked against the legacy email.

### The 10% fee

**The rule.**
- fee = 10% of the subtotal; buyer total = subtotal + fee. For example: ₱10,000 + ₱1,000 = **₱11,000**.
- PayPal's own processing fees are separate. They come out of the seller's share and are PayPal's, not FurnishAR's.
- For custom orders the fee is computed once, at quote time:
  - the deposit carries half of it, rounded (`deposit_fee`);
  - the balance carries the rest, so the stages add up exactly.
  - Example: ₱333.33 → fee ₱33.33 = ₱16.67 at deposit + ₱16.66 at balance.

**The mode (`PAYPAL_FEE_MODE`).**
- **`accrual`** (default). The buyer pays the shop in full. The fee is recorded per payment, shown as owed, and settled in `/admin/billing` (`fee_settlements`, `record_fee_settlement`).
- **`platform_split`**. Attempted per payment only when the partner ids are set **and** that seller granted the partner-fee permission.
  - The order carries `payment_instruction.platform_fees`.
  - The fee counts as **collected** only when PayPal's capture `seller_receivable_breakdown.platform_fees` reports exactly that amount. Otherwise the payment is recorded as accrual.

The admin and store billing pages say which mode is in force.

### Webhooks

In the PayPal app → Webhooks → Add webhook:
- URL: `https://<your-site>/api/paypal/webhook`
- Events: `PAYMENT.CAPTURE.COMPLETED`, `.PENDING`, `.DENIED`, `.DECLINED`, `.REFUNDED`, `.REVERSED`, `MERCHANT.ONBOARDING.COMPLETED`, `MERCHANT.PARTNER-CONSENT.REVOKED`, `CUSTOMER.MERCHANT-INTEGRATION.CAPABILITY-UPDATED`, `CUSTOMER.MERCHANT-INTEGRATION.SELLER-EMAIL-CONFIRMED`, `CUSTOMER.MERCHANT-INTEGRATION.PRODUCT-SUBSCRIPTION-UPDATED`
- Copy the webhook id into `PAYPAL_WEBHOOK_ID`.

How deliveries are handled:
- Every delivery is verified with PayPal's `verify-webhook-signature`, and the certificate URL must be on paypal.com.
- Each event id is processed once (`payment_webhook_events`); a half-finished one may retry after 10 minutes.
- A capture event re-reads the whole PayPal order and must match the recorded `payment_attempts` row.
- Refunds record the seller and platform portions (`payment_refunds`).
- Seller events re-read the merchant from PayPal.

### Reminders

- `vercel.json` runs `GET /api/cron/payment-reminders` daily at 01:00 UTC (09:00 in Manila), guarded by `CRON_SECRET`.
- It also runs `GET /api/cron/model-notices` daily at 01:20 UTC (migration 0013): it emails a shop's owners once when one of its 3D models has gone 335 days unused. A model can be deleted by an admin only 30+ days after that email went; without `CRON_SECRET`, `PAYMENT_RECORDER_SECRET` and a working email sender no notice is sent, and so no model ever becomes deletable.
- It emails each approved shop that is still not connected (`paypal_connection_required`), no more often than `PAYPAL_REMINDER_COOLDOWN_HOURS` and at most `PAYPAL_REMINDER_MAX` times.
- A reminder counts only if the email was actually sent.
- Page loads never send email. The portal shows one "Finish payment setup" banner, which can be dismissed for the session.

### Email events

All emails go through the one service in `lib/notify.js`: Gmail first, Resend as the fallback.

| Group | Events |
|---|---|
| Account | `buyer_welcome` |
| Store application | `store_application_received`, `store_application_admin_notice`, `store_approved`, `store_rejected` |
| PayPal connection | `paypal_connection_required`, `paypal_connected`, `paypal_connection_problem` (also sent to the admins) |
| Orders and payments | existing order events, `payment_failed`, `refund_completed` |
| Platform fee | `platform_fee_recorded` (admins). It says "accrued" unless PayPal reported collecting the fee. |

A failed email never changes or reverses a payment.

## 4. Testing

| What | Command |
|---|---|
| Database rules (local Postgres) | `node --test tests/marketplace.test.js tests/billing.test.js` |
| Server (fake PayPal and Supabase) | `node --test tests/marketplace-server.test.js tests/orders.test.js` |
| Browser, end to end | `npm run build && npm run check:billing` |

The end-to-end check covers:
- a Google sign-in and buyer onboarding that returns to the product;
- PayPal connect → Connected;
- a masked merchant id;
- the sandbox marker;
- checkout to the merchant id;
- no split claimed in accrual mode;
- the admin fee-mode panel;
- a shop that is not connected showing no checkout.

### Test matrix

| # | Case | Covered by |
|---|---|---|
| 1 | First Google sign-in → onboarding; buyer asked only for the municipality | marketplace.test, check:billing |
| 2 | Google never grants admin; an admin cannot re-onboard | marketplace.test |
| 3 | Store application linked by id; approval after an email change | marketplace.test |
| 4 | Open redirect (`next=https://…`, `//`, `\`) refused | marketplace-server.test |
| 5 | Google tokens never reach the browser; code used once; cookie required; expiry | marketplace-server.test, check:billing |
| 6 | Provider disabled → a readable error | marketplace-server.test |
| 7 | A shop that is not connected cannot take orders; live never pays a sandbox seller | marketplace.test, billing.test, check:billing |
| 8 | Seller status mapping; one merchant per store | marketplace-server.test, marketplace.test |
| 9 | ₱10,000 + 10% = ₱11,000; deposit and balance add up to the fee | marketplace.test |
| 10 | Browser price, fee or merchant ignored; a mismatch is never captured | orders.test |
| 11 | platform_split only when configured and granted; "collected" only from PayPal's report | orders.test, marketplace.test |
| 12 | Webhook signature, idempotency, retry on failure | marketplace-server.test, marketplace.test |
| 13 | Refund portions, idempotent | marketplace.test, marketplace-server.test |
| 14 | Reminder cooldown and cap; counted only when sent | marketplace.test, marketplace-server.test |
| 15 | Every email event renders safely | marketplace-server.test |

Still to do on real sandbox accounts, because it cannot be proved offline: a real Partner Referrals onboarding, a real capture with `platform_fees` on an app PayPal has enabled for it, and a real webhook delivery. Record the results here before switching `PAYPAL_ENV=live`.

## 5. Final audit (section 72)

| Rule | Where it holds |
|---|---|
| Google = identity, PayPal = payment provider | `lib/oauth.js` (identity only), `store_payment_accounts` (merchant id), no shared keys |
| Store must connect before taking online payments | `store_accepts_payments()` in `create_stock_order`, `create_custom_request`, `begin_payment` |
| Buyers don't connect PayPal | Checkout sends them to PayPal's page for one payment; nothing is stored |
| The browser never decides price, fee, seller, payee or status | `begin_payment` → `payment_attempts` → `matchesAttempt` → `record_capture` (secret-gated) |
| "Collected" only when PayPal reports it | `record_capture` mode logic; `platform_fee_recorded` wording; admin billing |
| Accrual kept when the split is unavailable | `validateConfig`, `feeModeFor` |
| Email failure never reverses a payment | `notify.sendEmail` never throws; `announce` catches errors |
| Google never grants admin | Only `platform_admins`; onboarding refuses admins; tests 2 and 3 |
| Secrets stay server-side | Only server env vars; config endpoints report booleans; Google tokens stripped; PKCE verifier in an httpOnly cookie |
| Not stored | Google or PayPal passwords, funding details, card numbers, provider tokens |
