# Audit before the AI device check and GCash payments (2026-09-26)

Phase 1 of the "AI-assisted device compatibility" brief and the payment
update that followed it (GCash via PayMongo, 0016): what the documentation
says, what the code does, and which one is right. Nothing in
this file is a new claim about a phone; device facts stay in
`AR-DEVICE-MATRIX.md` and `FIELD-EVIDENCE-FINDINGS.md`.

## 1. Documentation against the code

| # | Documentation says | Current code does | Source of truth | Documentation update |
|---|---|---|---|---|
| 1 | `REQUIREMENTS.md` §2: payments and checkout are **out of scope** for the pilot. | Migrations 0009–0011: orders, PayPal checkout and capture, seller onboarding, webhooks, refunds, a 10% fee, receipts and delivery (`lib/orders.js`, `lib/payments.js`, `lib/paypal.js`, `app/billing/*`). | The code, which is approved and deployed. | §2 moves payments, delivery and receipts into scope; FR-14…FR-19 cover them. |
| 2 | `REQUIREMENTS.md` §2: iOS AR Quick Look is **out of scope**. | `app/plan/ar-engine.js` opens a protected USDZ in AR Quick Look (`rel="ar"`), and `capabilities.mjs` routes iPhone to `NATIVE_IOS_QUICK_LOOK`. | The code. The product intentionally supports iPhone this way. | In scope. The remaining gap is that few products have a USDZ, not that the path is missing. |
| 3 | `REQUIREMENTS.md` FR-9, FR-10, FR-11, FR-13: "Schema only — **Not active**", "no live backend". | Supabase is live: sign-up, the application queue, owner CRUD under RLS, model upload to a private bucket, and catalogue revalidation are all running. | The code and the live database. | Mark them implemented, with the verifying tests. |
| 4 | `REQUIREMENTS.md` NFR-8: "The app makes no third-party calls; **no keys at all**". | The server holds the Supabase publishable key, the PayPal secret, the payment-recorder secret and the email credentials. The browser holds none (`lib/supabase-proxy.js` refuses a secret key). | The code. | Restate as "the **browser** never holds a privileged key", which is what is actually enforced and tested. |
| 5 | `REQUIREMENTS.md` known gaps 2–3 and NFR-9 cite `docs/DATABASE-LATER.md` and "50 automated tests". | `DATABASE-LATER.md` no longer exists; the suite has 440+ tests. | The code. | Drop the dead reference and the stale count. |
| 6 | `BILLING.md` "Each shop": the shop types a **PayPal email**. | Since 0011 checkout requires a CONNECTED seller account (Merchant ID link, or Partner Referrals); the email is a legacy record only. | The code (the file's own banner already says so). | Replace the section rather than leaving a banner over wrong steps. |
| 7 | `BILLING.md` / `AUTH-PAYMENTS-FLOW-MAP.md`: "every payment goes **directly to the shop's own PayPal account**; FurnishAR never holds buyer money". | True for PayPal. **Not true for GCash via PayMongo** without Split Payments: a PayMongo Checkout Session pays the account that owns the API keys, i.e. FurnishAR. | Both, per provider. | `PAYMONGO-GCASH-INTEGRATION.md` §1 says who receives the money in each GCash settlement mode. |
| 8 | `FRAMEWORK.md` §1: "the app now holds no keys at all". | See 4. | The code. | A note, since this file is historical. |
| 9 | `PRIVACY-AR.md`: camera frames are processed on the phone and never transmitted. | Still true. The new AI check keeps it true: the model and runtime are downloaded, but nothing is uploaded. | Both agree. | Add the AI rows: frames analysed on the phone; the benchmark uses a synthetic tensor, not a camera frame. |
| 10 | `AR-DEVICE-MATRIX.md` lists four phones. The brief adds a **Redmi 14C**. | No test of a Redmi exists anywhere in the repository or the notes. | Neither: it is untested. | New row, every cell NOT TESTED. |
| 11 | `FIELD-EVIDENCE-FINDINGS.md`: the Drive recordings were **never viewed** (blocked egress). | Unchanged. This session's network policy still blocks `drive.google.com`. | The file is accurate about its own limits. | None. The observations stay "as reported". |
| 12 | The brief lists `npm run check:diagnose`, `check:measure`, `check:tracked-ar`. | All three exist in `package.json`. | — | — |

## 2. What exists, briefly

**AR and measurement (kept).**
- `lib/spatial/capabilities.mjs` is the single, pure capability router: facts in, one decision out.
- `assessCapabilities()` separates advertised from verified WebXR, handles the in-app browser, iOS and insecure context before anything else, and orders the measurement methods (tracked scan, aim room, aim distance, photo, manual).
- Every fix in `FIELD-EVIDENCE-FINDINGS.md` F1–F12 is in the code and covered by `check-diagnose`, `check-tracked-ar` and `check-measure`.

**Device check (kept, extended).** `/diagnose` runs two tapped checks:
- one minimal WebXR request (hit-test required, depth never), and 6 s of frames;
- the camera plus 4 s of orientation, with a heading-glitch verdict.

It produces an allowlisted report with no hardware identifiers. There is **no** AI dimension, **no** scene-quality reading, and the headline is a state, not an experience level.

**Payments (kept).** Payments go through P10:
- `create_stock_order` / `create_custom_request`
- `begin_payment` gives what is due now, the fee share and the payee
- the server creates the PayPal order and records the attempt (`payment_attempts`)
- the buyer returns, or a webhook arrives
- the server re-reads PayPal and compares it with the attempt
- `record_capture`, which is idempotent on the capture id and allocates the fee per stage

Emails go through `lib/notify.js`. The fee is computed once per order; the deposit carries half of it and the balance the rest.

Everything is PayPal-shaped in four places:
- `payments.provider` and `store_payment_accounts.provider` are both `check (provider = 'paypal')`;
- `store_accepts_payments()` means "PayPal connected";
- `begin_payment` refuses a store without PayPal;
- `notify.js` says "Paid via PayPal" and "the money is in your PayPal account".

## 3. Premises checked before building

| Premise in the brief | Finding | Consequence |
|---|---|---|
| ONNX Runtime Web can run in the browser, lazily | `onnxruntime-web` 1.30.0 is on npm; its WASM build is roughly 11–25 MB per variant, and only one downloads. | Adopted, loaded only on `/diagnose` after a tap. Measured sizes are in `AI-DEVICE-COMPATIBILITY.md`. |
| A floor/wall segmentation model can be shipped | This session cannot reach Hugging Face or any model host, and no trained segmentation weights exist in the repository. | The runtime and benchmark are real. The benchmark model is a fixed synthetic workload, **not** a scene model. Scene quality (light, blur, texture, motion) is classical computer vision that needs no model. Floor/wall confidence stays **Not tested** until a trained model is added through the manifest. |
| WebGPU works on the test phones | Unknown. Nothing in the repository or the notes measured it. | Detected at runtime (`navigator.gpu.requestAdapter()`) and proven by a real inference; WASM is the fallback. Never inferred from the phone model. |
| GCash needs its own API key | GCash is a payment method of PayMongo. FurnishAR authenticates with PayMongo's test/live keys and asks for `payment_method_types: ["gcash"]`. | No GCash key anywhere. `PAYMONGO_SECRET_KEY` (server only), `PAYMONGO_PUBLIC_KEY`, `PAYMONGO_WEBHOOK_SECRET`, `PAYMONGO_ENV` (test by default). |
| A PayMongo checkout can pay each shop like PayPal does | A Checkout Session settles to the PayMongo account owning the keys. Paying a store directly needs PayMongo **Split Payments**, activated per account, with the store registered as a child merchant. | Two truthful modes: **platform** (default: FurnishAR's PayMongo account receives the payment, holds the 10% and owes the store its share) and **split** (only when `PAYMONGO_SPLIT_MODE=split` and the store has a child-merchant id; the fee is *expected* until reconciled). |
| Stores or buyers "connect GCash" | Nothing in PayMongo's model does that: the buyer authorises one payment on PayMongo's page. | No "Connect GCash" button. An administrator enables GCash per store; no GCash number, PIN or OTP is ever asked for or stored. |
| PayMongo webhooks are signed | Yes: `Paymongo-Signature` with a timestamp and test/live HMAC-SHA256 signatures. | Signature, timestamp (5 min) and mode are verified on the raw body; each event is processed once; the checkout session is still re-read before anything is recorded. |
| PayMongo's current documentation can be read from this session | `developers.paymongo.com`, `docs.paymongo.com` and `api.paymongo.com` are blocked by this session's network policy. Field names were taken from PayMongo's documentation as indexed by search. | Every assumed field is listed in `PAYMONGO-GCASH-INTEGRATION.md` §8 "Verify before live". Only the tests run here, against a stand-in PayMongo. |
