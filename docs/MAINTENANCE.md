# Maintenance and updates

*Addresses: Mr. Ian F. Bautista — "Maintenance/Updates" and "Validation of
accurate area measurement".*

---

## 1. What is deployed, and how to tell

The footer is rendered on the server with the version and commit. Read the
bottom of any page: `v1.1.0 · a7385ea`.

- **Version** comes from `package.json`.
- **Commit** is the first seven characters of `VERCEL_GIT_COMMIT_SHA`, or `dev`
  for a local build.
- **`live catalog`** appears only when the Supabase backend is active.

`GET /api/health` returns `{"status":"ok"}` and is the endpoint to point an
uptime checker at.

## 2. Routine schedule

| When | Task | How |
| --- | --- | --- |
| Every change | Run the suite before pushing | `npm test` — 50 tests, must be green |
| Every change | Check the diff renders at 390 px | Open the planner and catalogue on a phone or a 390 px window |
| Monthly | Check dependency advisories | `npm audit` (the app has no runtime npm dependencies; this covers tooling) |
| Monthly | Confirm the CDN pins still resolve | Load a page and watch the console for `THREE.js unavailable` / `Supabase unavailable` |
| Quarterly | Re-run the accuracy validation (§5) | The protocol below |
| Quarterly | Review the store application queue | `SUPABASE.md` §5 |
| Before each defence or demo | Full pass: tests, both AR paths on a real phone, a fresh sign-up | — |

## 3. Making a change safely

1. Work on a branch; never commit straight to `main` (Vercel deploys `main`).
2. `npm test` must pass. If you changed the schema, `npm run test:db` needs a
   local Postgres — see `SUPABASE.md`.
3. `npm run build`, then `npm start` and check the pages. For anything touching
   the planner or the portal, run `npm run check:planner` and
   `npm run check:portal` against it — a green build does not exercise either.
4. Push. Vercel builds a preview URL for the branch; open it on a phone.
5. Merge to `main` only after the preview behaves.

**Bump `package.json` version** on anything a user would notice, so the footer
stamp changes with it. Record it in `CHANGELOG.md`.

## 4. The pinned third-party code

Two libraries load from a CDN at fixed versions. Both have a fallback, so a CDN
outage degrades the app instead of breaking it.

| Library | Pin | Used for | If it fails |
| --- | --- | --- | --- |
| three.js | `0.170.0` | Loading and rendering the `.glb` | AR falls back to a box at true scale |
| supabase-js | `2` | Database, auth, storage | The app serves the bundled catalogue |

three.js is a normal dependency now, so upgrade it with npm and re-run the AR
checks rather than editing a CDN URL. After any bump, run
`npm run check:planner` and place a piece on a real Android device — a
three.js major version can change material and colour-space behaviour, which is
exactly the class of bug that made the armchair render black once before.

## 5. Validation of measurement accuracy

**This is the protocol the panel's comment asks for. The mathematics are
already proven; what remains is field data.**

### What is already proven

`tests/geometry.test.js` checks the measurement mathematics against shapes
whose answers are known in advance, not against the app's own output:

| Check | Expected | Status |
| --- | --- | --- |
| 1 m square | 1.00 m² | exact |
| 4 × 3 m room | 12.00 m² | exact, either walking direction |
| L-shaped room (4 × 4 with a 2 × 2 bite) | 12.00 m² | exact |
| Triangle, 4 m base × 3 m height | 6.00 m² | exact |
| Perimeter of a 4 × 3 m room | 14.00 m | exact |
| Floor height and tracking jitter | must not change the area | confirmed |
| Self-crossing outline | rejected, not reported | confirmed |
| Point tapped 75 cm above the floor | flagged as not flat | confirmed |
| Two scans 16.7% apart | rejected | confirmed |
| Two scans 2.5% apart | accepted, averaged | confirmed |

An end-to-end scan through a simulated WebXR session reads a 4 × 3 m floor as
**12.0 m²**, and a confirmatory scan 1% larger reconciles to 12.12 m² — the
mean, as specified.

### What still has to be measured on site

The above proves the app computes correctly from the points it is given. It
does **not** prove ARCore hands it accurate points on a real floor. Run this
before claiming the ±5% figure:

**Protocol.** Pick three rooms: one bright with a textured floor, one with plain
tile, one dim. In each, mark a rectangle with tape and measure it with a steel
tape measure. Then, with the phone at normal holding height:

1. Measure the long side with the app's **clearance** mode, three times.
2. Measure the whole rectangle with **floor area** mode, three times.
3. Record every reading, not just the good ones.

**Table to fill in** (`measured − reference ÷ reference × 100`; the app's
`measurementError()` does this arithmetic):

| Room | Light | Floor | Reference | AR run 1 | AR run 2 | AR run 3 | Mean | Error % |
| --- | --- | --- | --- | --- | --- | --- | --- | --- |
| | | | | | | | | |

**Pass criterion.** Mean error within ±5% in the bright, textured room. Record
the other two as the documented limits of the method rather than as failures —
knowing where it stops working is part of the result.

**Device and version to record with the table:** phone model, Android and
Chrome version, ARCore version, and the build stamp from the footer.

## 6. Common problems

| Symptom | Likely cause | Fix |
| --- | --- | --- |
| Catalogue empty, console shows `Supabase unavailable` | CDN blocked or keys wrong | Check `SUPABASE_URL` / `SUPABASE_ANON_KEY` in Vercel; the app is serving the bundled catalogue meanwhile |
| Model renders black | three.js upgrade changed material handling | See §4; the vertex-colour guard in `loadScaledModel` |
| "Place in your room" gives the camera preview on Android | No ARCore, or the page is not HTTPS | WebXR needs a secure context and ARCore |
| Owner sees "your store is in review" forever | Account not linked to a store | `SUPABASE.md` §5 |
| Inventory edits return 503 | Supabase not configured; the JSON catalogue is read-only on Vercel | Configure Supabase |
| Area scan keeps asking to rescan | Points not on one plane, or the two scans disagree | Bright, textured floor; tap only the floor |

## 7. Handover checklist

Before the project changes hands:

- [ ] Vercel and Supabase accounts transferred, or the new maintainer added as
      an owner.
- [ ] `SUPABASE_URL` and `SUPABASE_ANON_KEY` re-issued if anyone who should no
      longer have access has seen them.
- [ ] Database password rotated; a fresh backup downloaded (§`SUSTAINABILITY.md`).
- [ ] Store addresses and contact numbers replaced with the real ones.
- [ ] Demo accounts in `lib/handler.js` removed or their passwords changed.
- [ ] `FURNISHAR_JWT_SECRET` set to a fresh random value.
- [ ] The accuracy validation table (§5) filled in and attached.
