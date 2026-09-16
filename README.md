# FurnishAR

Browser-native furniture planning for Mamburao retailers. It includes a searchable catalog, responsive product previews, an Android WebXR placement entry point with a camera/screen fallback, two-point space measurement, clearance checks, and a role-scoped owner inventory portal.

## Start locally

Use Node.js 20 or newer, then run:

```powershell
npm run dev
```

Open [http://localhost:3000](http://localhost:3000). `localhost` is treated as a secure context by Chrome, so it is suitable for testing camera/WebXR features. For a phone, deploy via HTTPS; WebXR will not start on a plain HTTP IP address.

## The two portals

| | for | what it does |
| --- | --- | --- |
| `/portal` | a store owner | their own shop only: products, prices, stock, 3D models |
| `/admin` | the platform operator | vets sign-ups before a store exists, and can see every store and every decision |

A store owner is admin of their own shop and nothing else; nobody gets a public
shop without being checked first. Both walls are in the database, not the
interface — see [SUPABASE.md §5](SUPABASE.md#5-make-yourself-the-superadmin) for
how to make yourself the operator and what stops everyone else.

With no database connected, `/admin` says so and does nothing: applications live
in Supabase.

## Demo owner accounts

Sign-in uses these accounts. They are defined in `lib/handler.js` and must be
removed or changed before any real launch.

| Store | Email | Password |
| --- | --- | --- |
| S&C Variety Store | `owner@furnishar.ph` | `furnishar` |
| Tiampion Buildings | `tiampion@furnishar.ph` | `furnishar` |
| Sanros General Merchandise | `sanros@furnishar.ph` | `furnishar` |

## Data, and the database

There is no database. The catalogue is `data/catalog.json`, the shops are in
`lib/catalog.mjs`, the 3D models are files in `public/models/`, and sign-in uses
the demo accounts above. No external service, no API key, nothing to configure.

The Supabase integration was removed. **[docs/DATABASE-LATER.md](docs/DATABASE-LATER.md)**
records what the app does without one, what was kept (the schema and its
row-level-security tests), and what reconnecting would involve.

The practical limit: Vercel's filesystem is read-only, so owners cannot add or
edit furniture on the deployed site — the API says so rather than pretending to
save. Editing the catalogue means editing `data/catalog.json` and pushing.

Store sign-ups are closed: with no database there is nothing to create an
account in, so the portal says so and gives an email address instead of
appearing to register someone.

`npm run test:db` still checks the retained schema and every access rule against
a real Postgres, including that one shop can never read or write another's
furniture. It skips itself when no Postgres is running.

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

This is a Next.js app, so Vercel builds and serves it directly — no rewrites or
output directory to configure. Pages are server-rendered (product pages are
generated statically at build time), and `/api/*` is a Route Handler serving the
bundled catalogue and the demo sign-in. The only environment variable is
`FURNISHAR_JWT_SECRET`, which signs owner sessions and is required in
production.

In **Vercel → Project → Settings → Environment Variables**, set `FURNISHAR_JWT_SECRET` to a long random value, then redeploy. The bundled JSON catalog is read-only on Vercel, so catalog viewing and login work there, while product changes intentionally return a clear service message until the catalog is migrated to a persistent database or Vercel KV. Local development retains file-backed CRUD.
