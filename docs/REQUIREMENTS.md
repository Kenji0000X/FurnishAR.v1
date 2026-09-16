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

**In scope.** Browser-based AR placement on Android Chrome with ARCore; camera
preview fallback elsewhere; room measurement (clearance and floor area); a
per-store catalogue with 3D model upload; owner accounts and a store
application queue; subscription tiers.

**Out of scope for the pilot.** Payments and checkout, delivery logistics,
multi-language UI, iOS ARKit Quick Look (needs a USDZ per product), and
automatic 3D scanning of furniture by the store.

## 3. Functional requirements

The AR and measurement functions named below (`startNativeAR`, `bindTray`,
`captureNativePoint`, `reconcileReadings`, …) live in `app/plan/ar-engine.js`
since the Next.js port; the measurement mathematics are in `public/geometry.js`.

| ID | Requirement | Implemented in | Verified by |
| --- | --- | --- | --- |
| FR-1 | A shopper can browse a catalogue of furniture from local stores, filtered by category, store, width and colour. | `app/page.js` (server-rendered), `app/CatalogSection.js` `matches` | `tests/api.test.js` catalogue endpoint; browser pass at 1280 and 390 px |
| FR-2 | A product shows real dimensions, price, description and the store's contact details. | `app/furniture/[slug]/page.js` | Browser pass (product dialog) |
| FR-3 | A shopper can place a product in their room at true scale using WebXR. | `startNativeAR`, `loadScaledModel` | `tests/geometry.test.js` (scaling maths); mocked WebXR session — 150+ frames, no errors |
| FR-4 | Where WebXR is unavailable, the app degrades to an untracked camera preview rather than failing. | `startCameraFallback` | Browser pass with a faked camera |
| FR-5 | A placed model can be moved, rotated 360°, resized and reset. | `arTransform`, `bindTray` | Browser pass: yaw 47°, scale 122° in a live session |
| FR-6 | A shopper can measure a **clearance** between two points and get a fit verdict. | `captureNativePoint`, `fitAgainstClearance` | `tests/geometry.test.js` "fit against a linear clearance" |
| FR-7 | A shopper can measure a **floor area** from three or more points and get a fit verdict against the piece's footprint. | `captureAreaPoint`, `closeAreaOutline`, `fitAgainstArea` | `tests/geometry.test.js` (8 area cases); end-to-end scan of a 4 × 3 m floor reading 12.0 m² |
| FR-8 | A measurement is accepted only when two independent scans agree within 5%. | `reconcileReadings` | `tests/geometry.test.js` "the panel's 5% rule"; end-to-end rejection at 32% |
| FR-9 | A store owner can sign up, creating an account and an application for review. | Schema only — `store_applications`. **Not active**: sign-ups are closed while there is no database. | `tests/db.test.js` "the sign-up form is open to the public but its queue is not" (schema level) |
| FR-10 | An owner can add, edit and remove **their own** products only. | Schema only — RLS on `products`. **Not active**: the demo API scopes edits to the signed-in owner's store, but the database rules are what enforce it. | `tests/db.test.js` cross-store read/write/delete cases |
| FR-11 | An owner can upload a `.glb` model, stored under their own store's folder. | Schema only — storage policies. **Not active**: models are committed to `public/models/`. | `tests/db.test.js` "storage: a store can only write under its own folder" |
| FR-12 | A shopper can share a link to a specific piece. | `app/furniture/[slug]/page.js` — a real URL per piece, plus `ProductActions` for the share sheet | Browser pass: link copied and re-opened the dialog |
| FR-13 | The catalogue updates without a refresh when a store publishes. | **Not implemented** — there is no live backend to publish to. | — |

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
| NFR-8 | **Security** — the browser never holds a privileged key. | No keys at all | The app makes no third-party calls; there is nothing to hold |
| NFR-9 | **Maintainability** — the system can be understood and changed by someone new. | Documented + tested | 50 automated tests; `docs/MAINTENANCE.md` |
| NFR-10 | **Measurement accuracy** — AR readings within ±5% of a tape measure. | ±5% | Geometry proven exact against known shapes; **field validation against a tape measure is still outstanding** (see §6) |

## 5. Constraints and assumptions

- WebXR immersive AR with hit-test is available only on Android Chrome with
  ARCore. iOS Safari has no WebXR; those users get the camera preview.
- The camera preview is **not** tracked. Its ruler is an estimate scaled from
  the product's own on-screen size, and is labelled as such in the interface.
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
2. **No live backend (FR-9, FR-10, FR-11, FR-13).** The schema and its access
   rules are verified against a real Postgres, but the app is not connected to
   a database: the catalogue is a committed file and owners cannot edit it on
   the deployed site. See `docs/DATABASE-LATER.md`.
3. **iOS AR.** Requires a `.usdz` per product. The field exists; no files yet.
4. **Store addresses** are placeholders and must be replaced before launch.
