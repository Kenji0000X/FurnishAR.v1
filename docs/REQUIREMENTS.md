# Requirements analysis

*Addresses: Mr. Leonard Flores — "Requirements Analysis".*

Every requirement below states who needs it, what the system must do, and how
that claim is checked. The right-hand column points at the file that implements
it and the test that proves it. A requirement with no verification is marked as
such rather than quietly assumed.

---

## 1. Stakeholders

| Stakeholder | What they need from FurnishAR |
| --- | --- |
| **Shopper** (Mamburao household) | See a piece at true scale in their own room, and know whether it fits, before travelling to a store. |
| **Store owner** (S&C, Tiampion, Sanros) | List furniture with accurate sizes and a 3D model, keep stock current, and be found by nearby shoppers. |
| **Platform operator** (the thesis team, later the business) | Keep the catalogue accurate, onboard new stores, and run the service at a cost the pilot can sustain. |
| **Panel / adviser** | Evidence that the system does what it claims, and that it can be maintained after the defence. |

## 2. Scope

**In scope.**
- Browser-based AR placement on Android Chrome with ARCore; iPhone furniture
  in AR Quick Look when the piece has a USDZ; an untracked preview elsewhere.
- Room measurement (clearance and floor area).
- A device check that recommends one experience level (A–E) from measured
  facts, including an optional on-device AI benchmark and camera
  scene-quality reading (`docs/AI-DEVICE-COMPATIBILITY.md`).
- A per-store catalogue with 3D model upload, owner accounts and a store
  application queue.
- Google sign-in.
- Orders, checkout and payments through PayPal or Maya, delivery or pickup,
  receipts and order emails, and FurnishAR's 10% service fee
  (`docs/BILLING.md`, `docs/MAYA-INTEGRATION.md`).

*Changed 2026-09-26: payments, delivery, receipts and iOS Quick Look were
listed as out of scope while the code already shipped them
(`docs/AUDIT-AI-MAYA-2026-09.md`).*

**Out of scope for the pilot.**
- Multi-language UI.
- Automatic 3D scanning of furniture by the store.
- A trained on-device floor/wall segmentation model.
- Automated Maya refunds.
- Maya Payment Facilitator settlement: the code supports it, but it is not
  enabled.

## 3. Functional requirements

The AR and measurement functions named below (`startNativeAR`, `bindTray`,
`captureNativePoint`, `reconcileReadings`, …) live in `app/plan/ar-engine.js`
since the Next.js port; the measurement mathematics are in `public/geometry.js`.

| ID | Requirement | Implemented in | Verified by |
| --- | --- | --- | --- |
| FR-1 | A shopper can browse a catalogue of furniture from local stores, filtered by category, store, width and colour. | `app/page.js` (server-rendered), `app/CatalogSection.js` `matches` | `tests/api.test.js` catalogue endpoint; browser pass at 1280 and 390 px |
| FR-2 | A product shows real dimensions, price, description and the store's contact details. | `app/furniture/[slug]/page.js` | Browser pass (product dialog) |
| FR-3 | A shopper can place a product in their room at true scale using WebXR. | `startNativeAR`, `loadScaledModel` | `tests/geometry.test.js` (scaling maths); mocked WebXR session — 150+ frames, no errors |
| FR-4 | Where tracked WebXR is unavailable, the experience is chosen from observed capabilities (`lib/spatial/capabilities.mjs`): an untracked 3D preview labelled as such for placement, and aim / photo / tape methods for rooms. An in-app browser is told to open the page in Chrome or Safari first. | `assessCapabilities`, `startCameraFallback`, `MeasureSurface.js` | `tests/capabilities.test.js`; `scripts/check-tracked-ar.mjs`, `check-measure.mjs` |
| FR-5 | A placed model can be moved, rotated and reset. It cannot be resized: it is always the product's listed size. | `arTransform`, `bindTray` | `tests/dimension-consistency.test.js`; `check-tracked-ar.mjs` |
| FR-6 | A shopper can measure a **clearance** between two points and get a fit verdict. | `captureNativePoint`, `fitAgainstClearance` | `tests/geometry.test.js` "fit against a linear clearance" |
| FR-7 | A shopper can measure a **floor area** from three or more points and get a fit verdict against the piece's footprint. | `captureAreaPoint`, `closeAreaOutline`, `fitAgainstArea` | `tests/geometry.test.js` (8 area cases); end-to-end scan of a 4 × 3 m floor reading 12.0 m² |
| FR-8 | A measurement is accepted only when two independent scans agree within 5%. | `reconcileReadings` | `tests/geometry.test.js` "the panel's 5% rule"; end-to-end rejection at 32% |
| FR-9 | A store owner can sign up, creating an account and an application for review. | `store_applications`, `approve_store_application` (live Supabase) | `tests/db.test.js` sign-up queue cases; `tests/admin.test.js` approval cases |
| FR-10 | An owner can add, edit and remove **their own** products only. | RLS on `products`, the store portal (`app/portal`) | `tests/db.test.js` cross-store read/write/delete cases; `npm run check:roles` |
| FR-11 | An owner can upload a `.glb` model, stored under their own store's folder, and only allowed viewers get it. | Private `models` bucket and storage policies; signed access (`grantModelAccess`) | `tests/db.test.js` storage cases; `tests/model-access.test.js`; `npm run check:access` |
| FR-12 | A shopper can share a link to a specific piece. | `app/furniture/[slug]/page.js` — a real URL per piece, plus `ProductActions` for the share sheet | Browser pass: link copied and re-opened the dialog |
| FR-13 | A store's change shows in the catalogue on the next page load. | `revalidateTag('catalog')` after a store's change (0012), a 60 s cache otherwise | `npm run check:posters` (revalidation) |
| FR-14 | A shopper can buy a stocked piece: the price, the 10% fee and the total come from the database, never the browser. | `create_stock_order`, `begin_payment`, `lib/orders.js` | `tests/billing.test.js`; `tests/orders.test.js`; `npm run check:billing` |
| FR-15 | A shopper can request a custom build, accept a quote, and pay a deposit and a balance. | `create_custom_request`, `quote_custom_order`, `mark_order_ready` | `tests/billing.test.js` custom build; `tests/maya-db.test.js` PayFac deposit/balance |
| FR-16 | A shopper chooses PayPal or Maya where the shop takes both; only methods the shop can take are offered. | `lib/providers`, `store_payment_providers` (0015), `PurchasePanel.js` | `tests/maya-server.test.js`; `npm run check:billing` |
| FR-17 | A payment counts only when the server has re-read it from the provider and it matches the recorded attempt; each is recorded once. | `record_capture`, `lib/orders.js`, `lib/payments.js`, `lib/maya-webhook.js` | `tests/billing.test.js`; `tests/maya-db.test.js`; `tests/maya-server.test.js` |
| FR-18 | The shopper gets a receipt, and the shop and shopper get emails for each order event, naming the payment provider. | `lib/notify.js`, `app/billing/ReceiptView.js` | `tests/orders.test.js`; `tests/maya-server.test.js` email wording |
| FR-19 | Delivery or pickup is chosen at checkout and tracked to hand-over. | 0010, `update_delivery_status` | `tests/billing.test.js`; `npm run check:billing` |
| FR-20 | A person can sign in with Google; authentication never grants a role by itself. | `lib/oauth.js`, `/auth/callback`, onboarding | `tests/marketplace-server.test.js`; `tests/marketplace.test.js`; `npm run check:billing` Google section |
| FR-21 | `/diagnose` recommends one experience level (A–E) from measured facts, with a reason and a fallback. | `recommendExperience` in `lib/spatial/capabilities.mjs` | `tests/experience-router.test.js`; `npm run check:diagnose` |
| FR-22 | An optional AI check times a model on the phone (WebGPU or WASM) and reports a level, without uploading anything. | `lib/spatial/ai/` | `tests/ai-benchmark.test.js`; `tests/ai-scene.test.js`; `npm run check:ai` |

## 4. Non-functional requirements

| ID | Requirement | Target | Verified by |
| --- | --- | --- | --- |
| NFR-1 | **Usability** — no interactive control below the WCAG 2.2 minimum; 44 px on touch. | 24 × 24 px desktop, 44 × 44 px coarse pointer | Automated audit: 0 under-size targets at 1280 and 390 px |
| NFR-2 | **Accessibility** — all text meets WCAG AA contrast. | ≥ 4.5:1 normal, ≥ 3:1 large | Automated audit: 0 failures; ratios tabled in `BRAND.md` |
| NFR-3 | **Accessibility** — every control shows a visible focus indicator; dialogs trap and restore focus. | — | Automated audit: focus round-trip confirmed |
| NFR-4 | **Mobile** — usable one-handed on a 390 px screen, installable to the home screen. | No horizontal scroll; valid web manifest | Browser pass; manifest served and parsed |
| NFR-5 | **Performance** — the interface never blocks on the 3D library or the database. | Skeleton within one frame; graceful fallback | Skeleton verified against a 1.5 s throttled response; CDN-failure fallback verified |
| NFR-6 | **Motion** — respects `prefers-reduced-motion`. | All transforms stop | Audit: 0.001 s transitions under reduced motion |
| NFR-7 | **Security** — one store can never read or write another's data. | Enforced in the database, not the UI | `tests/db.test.js`, 14 cases |
| NFR-8 | **Security** — the browser never holds a privileged key. | The server holds the Supabase publishable key, the PayPal and Maya secrets, the payment-recorder secret and the email credentials; the browser holds none | `lib/supabase-proxy.js` refuses a secret key (`tests/env.test.js`); `check:billing` asserts the config the browser sees carries no secret |
| NFR-9 | **Maintainability** — the system can be understood and changed by someone new. | Documented + tested | 500 automated tests (`node --test tests/*.test.js`) plus the `npm run check:*` browser checks; `docs/MAINTENANCE.md` |
| NFR-11 | **Performance** — the on-device AI never costs a shopper who did not ask for it. | Zero AI bytes while browsing | `npm run check:ai` |
| NFR-10 | **Measurement accuracy** — readings within ±5% of a tape measure. | ±5% | Geometry proven exact against known shapes. Two scans agreeing within 5% is enforced, but that is **repeatability, not accuracy**. **Field validation against a tape measure is still outstanding**: `docs/ROOM-MEASUREMENT-VALIDATION.md` |

## 5. Constraints and assumptions

- WebXR immersive AR with hit-test is available only on Android Chrome with
  ARCore, and only where a session actually opens (see `docs/AR-DEVICE-MATRIX.md`).
  iOS Safari has no WebXR: furniture opens in AR Quick Look (USDZ), rooms are
  measured by aim, photo or tape.
- The camera preview is **not** tracked. It has no ruler, no Place step and no
  true-scale claim, and is labelled "Untracked preview".
- AR measurement needs a bright, textured, non-reflective floor. Accuracy
  degrades on plain tile, glass and in low light.
- The pilot assumes each store has at most a few dozen products and that models
  are produced by the team, not by the store.

## 6. Known gaps

These are open, and saying so is part of the analysis:

1. **Field validation of measurement accuracy (NFR-10).** The mathematics are
   proven exact against known shapes, and the 5% agreement rule is enforced,
   but no measurements have yet been taken against a tape measure on a real
   floor with a real phone. `docs/MAINTENANCE.md` §5 gives the protocol and the
   table to fill in. This must be done before the accuracy claim is defended.
2. **iOS AR.** Requires a `.usdz` per product. The path works; few products
   have one yet.
3. **Store addresses** are placeholders and must be replaced before launch.
4. **No phone has run the AI check** (FR-22), and no trained floor/wall model
   exists. See `docs/AR-DEVICE-MATRIX.md`, which includes the Redmi 14C.
5. **Maya is sandbox-ready, not live** (FR-16). Its field names must be
   confirmed against Maya's documentation, and a sandbox run completed, first
   (`docs/MAYA-INTEGRATION.md` §6, §9). With platform collect, FurnishAR
   holds buyer money for shops and must pay them out.
