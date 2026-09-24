# Field evidence and findings — AR, measurement, diagnostics

Evidence source: the Google Drive folder **"system furnish requirements"**
(read-only; nothing in it was modified).

## Status of the evidence review

The folder holds 16 screenshots and 3 screen recordings (listed below). **None
of them could be viewed from the development session**: the session's
network policy blocks `drive.google.com`, and the Drive connector returns
files only as base64 text, which could not be turned back into images
reliably (an attempt produced a corrupt JPEG). So:

- **OBSERVED** below is what the task brief of 2026-09-24 reports from these
  tests. It has not been checked against the files themselves.
- **CONFIRMED IN CODE** is what reading and running this repository proves.
- **INFERRED** is what the observation probably means.

To finish the review: allow `drive.google.com` and
`drive.usercontent.google.com` in the environment's network settings, or
commit the files to a branch, then map each finding to its file in the
"Evidence file" column.

| File | Type | Size |
|---|---|---|
| 45336a1d-9e6a-4657-9b1f-a069dab92aad.mp4 | video | 15.3 MB |
| 914982e0-adeb-404c-8372-0e055435d7bd.mp4 | video | 5.3 MB |
| 3c684aca-c149-4d2c-9c07-a733f6252997.mp4 | video | 4.1 MB |
| f0b230b3-d753-4f12-94b9-a157e375fca6.jpg | image | 97 KB |
| bf7494a2-9b9b-4983-b905-77897bfe76dc.jpg | image | 96 KB |
| 66855395-af96-4454-9c40-517d727163cc.jpg | image | 80 KB |
| 091eec59-de5f-49db-9e9b-11bc152a2cf9.jpg | image | 72 KB |
| 12998f33-7859-43cd-8baa-994844f239bf.jpg | image | 71 KB |
| 2240faf2-99ef-420d-901a-c433a3da9ba1.jpg | image | 71 KB |
| 005aaabf-bceb-49f6-a02e-76b711358a94.jpg | image | 63 KB |
| 3e641002-ac98-4dc0-bb54-122576155777.jpg | image | 48 KB |
| e48bdfbd-09d8-422d-b407-b2f99ae0a436.jpg | image | 46 KB |
| a063b345-9398-41e0-989c-4cb7bfa1a0c1.jpg | image | 44 KB |
| 814584124_1065753019600897_9066944326399212917_n.jpg | image | 41 KB |
| 296ac6af-d8a1-4858-8654-6d5e2ade8530.jpg | image | 39 KB |
| 813633866_2608416806296824_9158997921718825900_n.jpg | image | 38 KB |
| 5ff14da0-235d-4282-b0c6-1f06c8b7e503.jpg | image | 36 KB |
| 02dbb9b6-3a41-4396-a2a6-7dd27a56f8fb.jpg | image | 30 KB |
| c5215734-fc87-4787-8426-a43596a3f945.jpg | image (720 × 1600, a phone screenshot) | 23 KB |

The two files named `8136…_n.jpg` and `8145…_n.jpg` look like Messenger
downloads, which fits the brief's note that some tests ran in Messenger's
browser. That is an inference from the names only.

## Findings

Each: device / test · observed · expected · likely cause · related code ·
confidence · fix. Confidence is about the root cause, not the observation.

**F1. "AR not supported" on phones where the browser only refused a session**
- Device / test: TECNO KI5k, vivo 1906; /diagnose and the planner.
- Observed: tracked AR "does not reliably start".
- Expected: a refusal is reported as a refusal, with possible causes, and the photo and tape methods are offered.
- Confirmed in code: both `Diagnostics.js` and `startNativeAR` sent up to five `requestSession` calls from one tap, depth-sensing first. Only the first runs with the tap's user activation, so the rest could fail for that reason alone. The page then stated "Google Play Services for AR is missing" as fact.
- Likely cause: unknown between runtime, device profile, browser and the depth request. The code could not tell them apart, and still cannot without a device.
- Confidence: high that the reporting was wrong; unknown for the device cause.
- Fix: one minimal request (hit-test required, depth never), refusal classified in `lib/spatial/capabilities.mjs`, and a minimal retry only from a new tap. Tests: `check-diagnose.mjs`, `check-tracked-ar.mjs`.

**F2. Placement on the working phone blocked or painted over**
- Device / test: Infinix X6728, placement.
- Observed: a large red/coral overlay covering the camera when the surface was not trusted.
- Expected: only the reticle changes; the room stays visible.
- Confirmed in code: `setModelSurfaceState` replaced every mesh of the piece with a coral material at 0.66 opacity. Flatness was decided by "any horizontal plane anywhere in the session", or else by 10 frames of steady Y, which a wall also has.
- Confidence: high.
- Fix: the coral material is removed. `evaluateTarget` judges the current hit from its normal (the hit pose's +Y), its height stability and the established floor; unknown orientation reads as uncertain. The reticle has four states. Tests: `hit-sampler.test.js`, `check-tracked-ar.mjs`.

**F3. Depth and planes treated as if needed**
- Device / test: Infinix X6728.
- Observed: plane detection may not be granted, and depth is not exposed, yet tracking works.
- Confirmed in code: the first session request carried a depth-sensing dictionary.
- Confidence: high.
- Fix: depth is never requested; planes are asked for optionally, only for room scans. Placement needs hit-test only.

**F4. Room corners from one frame**
- Device / test: tracked room scan.
- Observed (brief): room results not trustworthy.
- Confirmed in code:
  - the corner was `state.latestHitPose` at the tap;
  - the floor was taken as the minimum Y of all taps;
  - the floor tolerance was 25 cm;
  - "Use this room" was enabled once 3 or more corners were closed.
- Confidence: high.
- Fix:
  - each corner comes from a 450 ms window (median after MAD rejection);
  - a floor reference with a 6 cm tolerance;
  - acceptance checks (corners, closed, simple, steady, floor, size);
  - a second agreeing scan, reported as repeatability.
- Tests: `hit-sampler.test.js`, `check-planner.mjs`.

**F5. Aim measurements jumping**
- Device / test: non-AR aim method.
- Observed (brief): wildly changing values.
- Confirmed in code: the camera angle was `DeviceOrientationEvent.beta`. It is correct only in unrolled portrait; in landscape `beta` is about 0 while the camera points at the horizon.
- Confidence: high that this is a real error. Whether it caused the specific field readings needs the recordings.
- Fix: `lib/spatial/orientation.mjs` builds the full rotation plus the screen angle, adds a session calibration, and refuses readings rolled past 10°. Tests: `orientation.test.js` and the landscape check in `check-measure.mjs`.

**F6. Room outline from an unreliable compass**
- Device / test: non-AR aim, indoors.
- Confirmed in code: the outline was built even when the heading was flagged unreliable.
- Fix: the outline requires a heading judged "good"; single distances still work.

**F7. Photo scale off-square**
- Device / test: photo method.
- Confirmed in code: a two-point pixels-to-metres ratio.
- Fix: a four-corner reference rectangle, a homography, and a per-point uncertainty, with zoom, pan, undo, reset and retake. Tests: `homography.test.js`, `check-measure.mjs`.

**F8. Manual 90 / 100 / 600 accepted as metres**
- Device / test: Type (manual) mode.
- Observed: a giant room was built.
- Confirmed in code: the fields were metres only, with no validation.
- Confidence: high.
- Fix: unit choice (m, cm, ft, in) with conversion, sanity ranges, a unit suggestion, and a confirm step. Tests: `room-units.test.js`, `check-measure.mjs`.

**F9. Untracked preview presented as AR**
- Device / test: phones without WebXR.
- Confirmed in code:
  - the copy said "Use the tray to move, turn and resize";
  - it offered "Placed" and "Reset to true scale";
  - a raw-`beta` "surface" gate blocked placement.
- Fix: the preview is labelled "Untracked preview", has no Place step and makes no true-scale claim. Room measurement is not attempted in it.

**F10. Different sizes on the header and the AR chip**
- Observed: the product header and the floating AR dimensions disagreed.
- Confirmed in code: in the build before `9b82c6f` (the one deployed on main), the chip read `product.modelBounds` while the header read `product.dimensions`. After `9b82c6f` both read the dimensions, but each surface still formatted them its own way.
- Confidence: high.
- Fix: one formatter everywhere (`formatDimensions`, plus `formatFootprint` for the plan). Tests: `dimension-consistency.test.js` and the cross-page check in `check-tracked-ar.mjs`.

**F11. Messenger's browser**
- Observed: some tests ran in the Messenger in-app browser.
- Confirmed in code: there was no embedded-browser detection.
- Fix: detection, and an "Open FurnishAR in your browser for camera tracking" notice with a Chrome intent (Android) or Safari hand-off (iOS), shown before any AR attempt.

**F12. Fallback box as the product**
- Confirmed in code: a product-coloured box was drawn at the product's size when the model was missing.
- Fix: removed. The model-load reason is shown instead.
