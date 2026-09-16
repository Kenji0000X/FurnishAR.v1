# Changelog

Notable changes, newest first. Versions follow the footer build stamp.

## Unreleased — two portals, and a wall between them

- **A platform console at `/admin`.** Store sign-ups are now vetted before a
  shop exists: the operator sees the applicant's store name, contact email,
  phone and what they intend to list, sets the address the shop will live at,
  and approves or rejects with a note. Approving is one transaction — it creates
  the store, links the account as owner, closes the application and records the
  decision — so a half-approved store cannot happen.
- **The wall is in the database.** `supabase/migrations/0002_platform_admin.sql`
  adds `platform_admins`, an `is_platform_admin()` helper, an append-only
  `admin_audit`, and policies that keep the sign-up queue invisible to store
  owners and to the public. `platform_admins` has no insert policy on purpose:
  promotion needs database credentials, so nobody can promote themselves through
  the app. `tests/admin.test.js` proves each rule by connecting as the wrong
  person and being refused.
- **A server-side gate in front of it** (`lib/auth.js`): admin requests are
  refused at the API boundary, so an anonymous request for the sign-up queue
  never reaches Postgres, and a non-admin gets a 403 rather than an empty list
  that reads like an empty queue. Identity is re-checked with Supabase on every
  request and never cached, so removing an admin takes effect immediately.
  Filing an application stays public — that is the sign-up form.
- `npm run check:admin` drives a real browser: a signed-out visitor and a
  signed-in store owner are both refused and shown no applicant's email or phone
  number; the operator sees the queue, is asked to confirm, and the approval is
  recorded.
- The browser checks now kill the whole `next start` process group and refuse to
  run when something else holds their port. A leftover server from a previous
  run had been answering, which made a fresh build look broken.

## Unreleased — the database connection restored, with a reachability gate

- Online store sign-up works again: the portal selects the Supabase backend
  when `/api/sb/status` reports one, creates the account, and files the
  `store_applications` row. The manual-email message is now only the fallback.
- **The backend is chosen on reachability, not just configuration.**
  `prepare()` calls `/api/sb/status?probe=1`, so a `SUPABASE_URL` pointing at a
  deleted project falls back to the manual message — naming the reason —
  instead of letting every sign-in and sign-up return 502. That was the exact
  production failure.
- Kept two fixes made directly on main that a plain restore would have lost:
  the `.env` reader now tolerates a BOM and CRLF endings, and `proxyRest` no
  longer puts the publishable key in `Authorization` (it is an API key, not a
  JWT — the same correction already made for the auth endpoints).
- `dist/supabase.js` stays deleted: it carried the old project's publishable
  and secret keys as literal strings.

## Superseded — the database connection removed

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
