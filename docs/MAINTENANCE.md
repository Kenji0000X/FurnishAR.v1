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

`GET /api/health` returns `{"status":"ok"}` and is the endpoint to point an
uptime checker at.

## 2. Routine schedule

| When | Task | How |
| --- | --- | --- |
| Every change | Run the suite before pushing | `npm test` — 50 tests, must be green |
| Every change | Check the diff renders at 390 px | Open the planner and catalogue on a phone or a 390 px window |
| Monthly | Check dependency advisories | `npm audit` — four runtime dependencies: Next, React, React DOM, three.js |
| Quarterly | Re-run the accuracy validation (§5) | The protocol below |
| Before each defence or demo | Full pass: tests, both AR paths on a real phone, a fresh sign-up | — |

## 3. Making a change safely

1. Work on a branch; never commit straight to `main` (Vercel deploys `main`).
2. `npm test` must pass. If you changed the schema, `npm run test:db` needs a
   local Postgres — see `docs/DATABASE-LATER.md`.
3. `npm run build`, then `npm start` and check the pages. For anything touching
   the planner or the portal, run `npm run check:planner` and
   `npm run check:portal` against it — a green build does not exercise either.
4. Push. Vercel builds a preview URL for the branch; open it on a phone.
5. Merge to `main` only after the preview behaves.

**Bump `package.json` version** on anything a user would notice, so the footer
stamp changes with it. Record it in `CHANGELOG.md`.

## 4. The pinned third-party code

three.js is pinned at `0.170.0` in `package-lock.json` and ships with the
deployment; nothing is fetched from a CDN at run time. If it fails to load at
all, AR falls back to drawing the piece as a box at true scale.

Upgrade it with npm and re-run the AR
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

### Furniture shown at its real size in AR

**What is already proven.** The store owner's width × depth × height is the
size. `tests/model-scale.test.js` and `tests/units.test.js` show that a model
exported in metres, centimetres or millimetres is scaled to exactly that size
(30 × 30 × 40 cm becomes 0.30 × 0.30 × 0.40 m); that the scale is one uniform
factor, never stretched per axis; that a model whose proportions differ by
more than 3% is refused; and that the scaled model's bounds are re-measured
within 2% before it is shown. `scripts/check-model-form.mjs` checks the same
in the portal, in a real browser.

That proves the scene is built at the right size. It does **not** prove a
phone's AR tracking shows it at that size; ARCore and ARKit estimate the
floor and the camera's distance, and that estimate is where error comes from.

**Protocol.** Use a real object whose size you can measure (a stool, a box),
listed with its measured dimensions and a matching model. In a bright room
with a textured floor:

1. Put the real object on the floor. Measure its width, depth and height with
   a steel tape. That is the reference.
2. Open the product in AR on the phone and place the model beside it.
3. Measure the virtual piece against a tape laid on the floor beside it, or
   with the planner's clearance tool, for each of width, depth and height.
4. Repeat twice more, re-placing the model each time. Record every reading.

**Table to fill in** (`observed − expected ÷ expected × 100`):

| Device | OS | Browser | Axis | Expected | Observed 1 | Observed 2 | Observed 3 | Mean | Error % |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| | | | Width | | | | | | |
| | | | Depth | | | | | | |
| | | | Height | | | | | | |

**Pass criterion.** Mean error within ±5% on each axis. Record the phone model,
OS version, browser version and the build stamp from the footer with the table.

**What may be claimed.** Until this table is filled in: "Displayed using the
furniture's verified real-world dimensions." Not "exact", not "accurate to the
millimetre": the app controls the size of the scene, the phone's tracking
controls how that scene lines up with the room.

**Also time it on a phone.** In headless Chromium with no GPU, the portal's
preview of a 60 MB / 870 000-triangle model took about 55 s to read and first
draw, and a 100 MB model about 93 s. A phone with a real GPU should be far
faster. Record how long a large model takes to show in the portal on a
mid-range phone before relying on it.

## 6. Common problems

| Symptom | Likely cause | Fix |
| --- | --- | --- |
| Model renders black | three.js upgrade changed material handling | See §4; the vertex-colour guard in `loadScaledModel` |
| "Place in your room" gives the camera preview on Android | No ARCore, or the page is not HTTPS | WebXR needs a secure context and ARCore |
| Inventory edits return 503 on the deployed site | Vercel's filesystem is read-only, so `data/catalog.json` cannot be written | Edit the file and push, or reconnect a database (`docs/DATABASE-LATER.md`) |
| Area scan keeps asking to rescan | Points not on one plane, or the two scans disagree | Bright, textured floor; tap only the floor |

## 7. Handover checklist

Before the project changes hands:

- [ ] Vercel account transferred, or the new maintainer added as an owner.
- [ ] Any Supabase keys that were ever committed rotated before that project is
      reused (`docs/DATABASE-LATER.md`).
- [ ] Store addresses and contact numbers replaced with the real ones.
- [ ] Demo accounts in `lib/handler.js` removed or their passwords changed.
- [ ] `FURNISHAR_JWT_SECRET` set to a fresh random value.
- [ ] The accuracy validation table (§5) filled in and attached.
