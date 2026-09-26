# Audit before the AI device check and Maya (2026-09-26)

Phase 1 of the "AI-assisted device compatibility + Maya" brief: what the
documentation says, what the code does, and which one is right. Nothing in
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
| 7 | `BILLING.md` / `AUTH-PAYMENTS-FLOW-MAP.md`: "every payment goes **directly to the shop's own PayPal account**; FurnishAR never holds buyer money". | True for PayPal. **Not true for Maya** without PayFac: a Maya Checkout pays the merchant that owns the API keys, i.e. FurnishAR. | Both, per provider. | The Maya section (and `MAYA-INTEGRATION.md`) says who receives the money in each Maya mode. |
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
| Maya Checkout can pay each shop like PayPal does | Maya Checkout settles to the merchant owning the API keys. Settlement to a store needs Maya **PayFac** (sub-merchant metadata), which Maya enables per account. | Two truthful Maya modes: **platform collect** (default: FurnishAR's Maya account receives the whole payment and owes the store its share) and **PayFac** (only when `MAYA_PAYFAC_ENABLED=true` and the store has a sub-merchant id). See `MAYA-INTEGRATION.md`. |
| Maya has a self-service "Connect Maya" like PayPal | Nothing in Maya's public documentation describes seller self-onboarding into a platform's Maya account. Sub-merchants are arranged with Maya. | No "Connect Maya" button. An administrator enables Maya per store, and the portal shows "Set up by FurnishAR". |
| Maya webhooks are signed | Maya's documentation describes webhook payloads equal to the payment resource, retries (up to 4 attempts) and IP allowlisting, not an HMAC signature. | The webhook body is never trusted. Every delivery is verified by re-reading the payment from Maya with the secret key, and processed once. |
| Maya's current documentation can be read from this session | `developers.maya.ph` and `pg-sandbox.paymaya.com` are blocked by this session's network policy. Field names were taken from Maya's documentation as indexed by search. | Every Maya field name is listed in `MAYA-INTEGRATION.md` §"Verify before live". Only the tests run here, against a fake Maya. |
