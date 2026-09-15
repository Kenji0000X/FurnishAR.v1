# FurnishAR

Browser-native furniture planning for Mamburao retailers. It includes a searchable catalog, responsive product previews, an Android WebXR placement entry point with a camera/screen fallback, two-point space measurement, clearance checks, and a role-scoped owner inventory portal.

## Start locally

Use Node.js 20 or newer, then run:

```powershell
npm.cmd run local
```

Open [http://localhost:4173](http://localhost:4173). `localhost` is treated as a secure context by Chrome, so it is suitable for testing camera/WebXR features. For a phone, deploy via HTTPS; WebXR will not start on a plain HTTP IP address.

## Demo owner accounts

These belong to the bundled-catalogue mode, which is what runs when no Supabase
project is configured.

| Store | Email | Password |
| --- | --- | --- |
| S&C Variety Store | `owner@furnishar.ph` | `furnishar` |
| Tiampion Buildings | `tiampion@furnishar.ph` | `furnishar` |
| Sanros General Merchandise | `sanros@furnishar.ph` | `furnishar` |

## Live database (Supabase)

Supply a Supabase project URL and publishable key and the app switches to a real
backend: Supabase Auth accounts, per-store furniture protected by row level
security, 3D model uploads into Storage, and a catalogue that updates live in
every open browser. Leave them unset and it keeps the bundled catalogue and the
demo sign-in above, unchanged.

The dashboard's Next.js snippets (`@supabase/ssr`, `utils/supabase/server.ts`,
`next/headers`) do **not** apply here — this project has no framework. All it
needs are the two values; `npm run check:supabase` verifies them.

**[SUPABASE.md](SUPABASE.md)** is the full runbook — creating the project,
running `supabase/migrations/0001_init.sql`, the storage bucket, the
environment variables, and how to approve a shop owner's application.

Store owners sign themselves up in the portal. That creates an account and a
`store_applications` row; the account owns nothing until an admin links it to a
store, so a new sign-up sees a "your store is in review" screen rather than an
empty dashboard.

`npm run test:db` checks the schema and every access rule against a real
Postgres, including that one shop can never read or write another's furniture.

## Panel feedback & roadmap

### Earlier panel requests

| Reviewer | Request | Implementation | Status |
| --- | --- | --- | --- |
| Leonard Flores (RECO) | Subscription tiers | `plan` per store (freemium: 8-product cap; premium: unlimited + featured). Enforced by database triggers, not by the UI. | ✅ Done |
| Ian F. Bautista (Panel) | Maintenance audit trail | Products stamped with `updatedAt`; the dashboard shows "last updated" per row. | ✅ Done |
| Ian F. Bautista (Panel) | Measurement validation | A confirmatory scan is required; readings must agree within 5% or the app asks for a rescan. | ✅ Done |
| Vina A. Atienza (Panel) | Store profiles | Address, contact number and hours per store, shown in every product dialog. Addresses are still placeholders — **replace before launch**. | ✅ Done |

### Latest panel comments

| Reviewer | Comment | What was done | Evidence |
| --- | --- | --- | --- |
| Leonard Flores (RECO) | Usage convenience | Shareable product links, native share / copy to clipboard, and the last measurement remembered for a day. | Browser pass: link copied, deep link reopens the piece, measurement survives a new visit |
| Leonard Flores (RECO) | Visualization: Design | Interface rebuilt on a documented system (minimalism + a pinch of brutalism + glass on the z-axis only); a to-scale plan view added to the fit verdict. | [`BRAND.md`](BRAND.md); 0 contrast failures, 0 under-size targets |
| Leonard Flores (RECO) | Consider mobile view | Verified at 390 px: no horizontal scroll, every control ≥ 44 px on touch. Installable to the home screen. | Automated audit; web manifest served and parsed |
| Leonard Flores (RECO) | Requirements Analysis | Requirements, stakeholders, constraints and a traceability matrix — each requirement tied to the code that implements it and the test that proves it. | [`docs/REQUIREMENTS.md`](docs/REQUIREMENTS.md) |
| Leonard Flores (RECO) | Startup idea: business plan, Freemium/Premium | Tiers, pricing rationale, unit economics, break-even and risks. Shown in the portal with live usage against the cap. | [`docs/BUSINESS-PLAN.md`](docs/BUSINESS-PLAN.md) |
| Ian F. Bautista (Panel) | Maintenance/Updates | Version and commit stamped into every build and shown in the footer; routine schedule, upgrade procedure, troubleshooting table and handover checklist. | [`docs/MAINTENANCE.md`](docs/MAINTENANCE.md); `CHANGELOG.md` |
| Ian F. Bautista (Panel) | Validation of accurate area measurement | **Floor area scanning added** (three or more points, shoelace on the floor plane), validated by a second scan within 5% and a flatness check on the tapped points. Mathematics tested against shapes with known answers. | 18 tests in `tests/geometry.test.js`; an end-to-end scan of a 4 × 3 m floor reads 12.0 m². **Field validation against a tape measure is still outstanding** — protocol in [`docs/MAINTENANCE.md`](docs/MAINTENANCE.md) §5 |
| Vina A. Atienza (Panel) | System Sustainability | Failure behaviour, running costs against free-tier limits, maintainability, backups, handover — and an explicit list of what is not sustainable yet. | [`docs/SUSTAINABILITY.md`](docs/SUSTAINABILITY.md) |

## AR notes

The **Place in your room** action checks for WebXR immersive AR with hit-test support and requests a session only after the user chooses it. Android Chrome + ARCore is the pilot target. Browsers without that capability fall back to an untracked camera preview, and browsers without a camera fall back to manual measurement controls.

**Control tray.** Both the WebXR and camera-preview paths share one transform (offset, heading, scale) driven by a glass tray docked at the bottom of the AR view: a move pad (left / right / closer / away), rotate left and right, a **360°** toggle that turns the piece continuously (one revolution every 12 seconds), scale down/up, reset, and the place button. Buttons nudge on tap and glide while held, at a fixed rate per second so the speed does not depend on frame rate. Move directions follow the viewer's heading, so "left" is always screen-left. Touch gestures (drag, pinch, twist) write into the same transform, so the tray and the gestures never disagree.

**Real-time measurement.** In a WebXR session the reading updates every frame: before the first tap it shows phone-to-surface distance, and after point A it shows the live span to wherever the reticle is pointing, feeding the planner's clearance field and fit verdict as the phone moves. The confirmatory second scan and the 5% agreement check still apply before a reading is accepted. In camera preview, where nothing is tracked, dragging across the screen measures against the product's own on-screen scale; that reading is labelled an estimate.

**Interface.** The AR layer is built from translucent glass panels over the live camera — a top identity bar, a size chip pinned to the model's own screen position, a centred measurement readout, a one-line hint, and the tray. Nothing sits in the middle of the frame, so the furniture is never covered.

## Deploying on Vercel

This project now exposes the API through `api/index.js`, a Vercel serverless-function handler. Vercel serves `index.html`, `styles.css`, and `client.js` from the `dist` output and rewrites all `/api/*` requests to that handler. The function configuration explicitly bundles the seed catalog. `local.js` is excluded from deployments and only starts the local development server.

In **Vercel → Project → Settings → Environment Variables**, set `FURNISHAR_JWT_SECRET` to a long random value, then redeploy. The bundled JSON catalog is read-only on Vercel, so catalog viewing and login work there, while product changes intentionally return a clear service message until the catalog is migrated to a persistent database or Vercel KV. Local development retains file-backed CRUD.
