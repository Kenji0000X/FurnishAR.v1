# Changelog

Notable changes, newest first. Versions follow the footer build stamp.

## Unreleased — the database connection removed

- **The Supabase integration was removed.** The app runs entirely on files:
  `data/catalog.json`, the shops in `lib/catalog.mjs`, models in
  `public/models/`, and the demo sign-in in `lib/handler.js`. No external
  service, no API key, and `FURNISHAR_JWT_SECRET` is the only environment
  variable left.
- Removed: the server-side proxy, the `/api/sb/*` routes, the browser client,
  the credential loading, the connection checker, and `@supabase/supabase-js`.
  Four runtime dependencies remain: Next, React, React DOM, three.js.
- Store sign-ups are closed and say so, rather than appearing to create an
  account there is nowhere to put.
- Kept, but not wired up: `supabase/migrations/0001_init.sql`, `supabase/seed.sql`
  and the 14 row-level-security tests in `tests/db.test.js`. See
  `docs/DATABASE-LATER.md` for what reconnecting would involve.
- Known limit this reintroduces: Vercel's filesystem is read-only, so owners
  cannot edit furniture on the deployed site. The API says so instead of
  pretending to save.

## 1.1.0 — panel comments applied

**Measurement**
- Floor area scanning: tap three or more corners, close the outline, and the
  area is computed from the shoelace formula on the floor plane.
- Every reading is validated twice — two independent scans must agree within
  5%, and the tapped points are checked for flatness so a tap that landed on
  furniture cannot inflate the result.
- A crossed outline is rejected instead of being reported as an area.
- The fit verdict now answers against floor area as well as linear clearance,
  reporting the piece's footprint and its share of the measured floor.
- 18 tests validate the mathematics against shapes with known answers.

**Interface**
- Plan view in the verdict card: the measured space and the piece's footprint
  drawn to scale, with the piece flagged when it does not fit.
- Measurement mode switch (clearance / floor area) in the planner.

**Convenience**
- Shareable links to a product (`?product=…`), with copy-to-clipboard and the
  native share sheet where available.
- The last measurement is remembered for a day, so comparing several pieces
  does not mean re-measuring the same doorway.
- Installable on a phone: web manifest, icons, standalone display.

**Business**
- Subscription tiers shown in the store portal, with current usage against the
  freemium cap.

**Maintenance**
- Version and commit stamped into every build and shown in the footer.
- `docs/REQUIREMENTS.md`, `docs/MAINTENANCE.md`, `docs/SUSTAINABILITY.md`,
  `docs/BUSINESS-PLAN.md`.

**Fixed**
- The dev server's file allowlist did not include `geometry.js`,
  `manifest.webmanifest` or the icons, so they 404'd outside Vercel.

## 1.0.0 — pilot

- Catalogue, WebXR placement with a control tray, camera-preview fallback,
  two-point clearance measurement, owner portal, Supabase backend with
  per-store row level security and 3D model upload.
