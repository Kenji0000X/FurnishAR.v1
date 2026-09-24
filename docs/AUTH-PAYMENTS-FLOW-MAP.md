# Authentication, payments and email — current flow map

Written before the Google sign-in and PayPal marketplace change (migration
0011). It records the flow as it was, what was wrong or missing, and what the
change does about each gap. The DFD (`FURNISHAR-DFD-V2.md`) stays the source
of truth. This file explains how the DFD got to where it is now.

## 1. Authentication as it was (P1)

| Step | Code | Notes |
|---|---|---|
| Buyer sign-up | `app/login/LoginChooser.js` → `signUpBuyer()` (`public/supabase.js`) → `POST /api/sb/auth/signup` → `proxyAuth` (`lib/supabase-proxy.js`) → GoTrue `/auth/v1/signup` | The name and municipality travel as metadata. The 0006 trigger `create_buyer_from_signup` writes the `buyers` row in the same transaction as the account. |
| Store sign-up | `app/portal/Portal.js` `SignupPanel` → `signUp()` → GoTrue sign-up, then a **second** browser write: `POST /api/sb/rest/store_applications` | The application is linked **by email only**. The second write can fail after the account already exists. |
| Sign-in | `signIn()` → `POST /api/sb/auth/login` → GoTrue password grant | The session (access and refresh tokens) is kept in `sessionStorage`. The publishable key stays on the server. |
| Role | `my_role()` (0006): admin → owner → buyer → otherwise `pending` | Any signed-in account with no row came back as `pending`, even one that never applied. |
| Admin | `platform_admins` + `is_platform_admin()` (0003). The `/admin` gate and `lib/auth.js` `guardAdminRequest` | Nothing a browser sends can create an admin. |
| Intended destination | `lib/auth-intent.js` (sessionStorage) and `?next=` in `LoginChooser.safeNext` | Same-origin paths only. `\`, control characters, `//` and schemes are refused. |

**Gaps.** There was no Google sign-in. There was no onboarding for an account
that has an identity but no role: it fell into "your store is in review".
Store applications had no link to the account id.

## 2. Payments as they were (P10)

| Step | Code | Notes |
|---|---|---|
| Store payout | Portal → `orders/store-billing` → `save_store_billing` → `store_payout.paypal_email` | The shop typed an email address. Nothing checked that it was a PayPal account able to receive money. |
| Checkout | `PurchasePanel` → `orders/checkout` → `create_stock_order` → `begin_payment` → `paypal.createOrder({ payee: { email_address } })` | The price and the 10% fee come from the database. |
| Return | `/account?paypal=return&token=` → `orders/capture` → re-read the PayPal order → compare it with `begin_payment` → capture → `record_capture` (secret-gated) | This is idempotent on the capture id, and PayPal-Request-Id is fixed for the capture. |
| Fee | `payments.platform_fee` = amount × rate / (1 + rate), accrued, settled by hand (`fee_settlements`, `record_fee_settlement`) | Custom orders: the deposit was 50% of the total. The fee inside each stage was re-derived by proportion, so the rounding was not deterministic. |
| Pending capture | Not recorded, with no follow-up | There were no webhooks. |
| Refunds | Done by hand in the shop's PayPal account. Nothing was recorded. | |

**Gaps.**
- There was no seller onboarding, so an email payee was never verified.
- There was no platform-fee split and no truthful label saying which fee mode was active.
- There were no webhooks, no refund accounting and no explicit attempt states.

## 3. Email as it was (P10 → Email Service)

`lib/notify.js` sends through Gmail (App Password), or through Resend when
Gmail is not set. It covers order events only. A send never throws. There were
no account, application or payment-setup emails.

## 4. What 0011 and the server change do

| Gap | Change |
|---|---|
| No Google sign-in | `GET /api/sb/auth/google` starts a PKCE flow on the server; the code verifier lives in an httpOnly cookie. `/auth/callback` sends the code to `POST /api/sb/auth/exchange`, which drops Google's provider tokens before returning the session. |
| No onboarding | `my_role()` now answers `onboarding` for an account with no role and no open application. `/onboarding` asks "What will you use FurnishAR for?". A buyer is asked only for a municipality (`complete_buyer_onboarding`). A shop fills in the application (`submit_store_application`, linked by `auth.users.id`). |
| Email-only application link | `store_applications.applicant_user_id`. Approval prefers it and falls back to the email for older applications. |
| Unverified payee | `store_payment_accounts` holds the PayPal Partner Referrals onboarding, the merchant id and the status read back from PayPal. Checkout requires `CONNECTED`. The legacy email is kept as a record only. |
| Fee mode | `PAYPAL_FEE_MODE`: `platform_split` only when the partner is configured and the seller granted the partner-fee permission. Otherwise `accrual`, and the fee is shown as owed until it is settled. A fee is "collected" only when PayPal's capture breakdown reports it. |
| Rounding | The fee is computed once. The deposit carries half of it, rounded, and the balance carries the rest. |
| No webhooks | `POST /api/paypal/webhook`: signature verified with PayPal, processed once per event id, covering capture completed/denied/pending, refunds and reversals, onboarding and capability changes. |
| No refund accounting | `payment_refunds`, split into the seller portion and the platform portion. |
| Emails | New events for the account, the application, PayPal connection and refunds. Reminders come from a cron route with a cooldown and never from a page load. |
