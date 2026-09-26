# AR device matrix

What each tested phone was **observed** to do. A cell is filled only from a
physical test. Anything not yet tested says **NOT TESTED** — including cells
that the rest of the codebase would let you guess.

How to fill a row: open `/diagnose` on the phone, in the browser named in the
row. Run **Run the AR check** (point at the floor, move slowly), then **Check
the camera and motion sensors** (hold up, turn slowly), then **Check AI camera
capability** (on Wi-Fi: it downloads the AI runtime and a 4.3 MB test model).
Note the **Recommended FurnishAR mode** at the top (A–E). Open **Technical
details**, tap **Copy technical report**, and paste the report under the
table. The report holds no hardware identifiers (no IMEI, serial number,
ICCID, MEID or MAC address) and no camera frame.

Recommended mode levels (`lib/spatial/capabilities.mjs`, `recommendExperience`):
**A** tracked AR plus AI scene guidance · **B** tracked AR · **C** AI-assisted
measurement (aim/photo, with scene guidance) · **D** photo measurement ·
**E** manual (tape measure). The level is computed from the measured facts on
that phone, never from its model name.

| Device | OS | Browser | Context | WebXR advertised | Session opened | Hit test | Surface hits | Plane detection | Depth | Tilt sensor | Heading quality | Camera | Recommended mode | Notes |
|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|
| Infinix X6728 (HOT 60i) | Android — version NOT TESTED | Chrome — version NOT TESTED | Normal browser | Yes | Yes | Granted | Yes (furniture placed in the room) | May not be granted | Not available through WebXR (the hardware supports ARCore Depth) | NOT TESTED | NOT TESTED | Works | Tracked AR | The most functional tested device. Needs hit-test only; placement must not depend on planes or depth. |
| TECNO KI5k (Spark 10C) | Android — NOT TESTED | NOT TESTED | Normal browser | NOT TESTED | Does not reliably start | NOT TESTED | NOT TESTED | NOT TESTED | NOT TESTED | NOT TESTED | NOT TESTED | Camera APIs available | Photo + tape measure (aim if the sensor check passes) | Must not be treated like the Infinix. |
| vivo 1906 (Y11) | Android — NOT TESTED | NOT TESTED | Normal browser | NOT TESTED | Not reliable / not available | NOT TESTED | NOT TESTED | NOT TESTED | NOT TESTED | NOT TESTED | NOT TESTED | Works | Photo + tape measure (aim if the sensor check passes) | Needs the non-WebXR path. |
| iPhone 12 | iOS — NOT TESTED | Safari — NOT TESTED | Normal browser | No (Safari has no WebXR AR) | Not applicable | Not applicable | Not applicable | Not applicable | Not applicable | NOT TESTED | NOT TESTED | NOT TESTED | Quick Look for furniture; photo, tape (and aim if reliable) for the room | Placement needs a protected USDZ per product. |
| Redmi 14C | Android — NOT TESTED | NOT TESTED | NOT TESTED | NOT TESTED | NOT TESTED | NOT TESTED | NOT TESTED | NOT TESTED | NOT TESTED | NOT TESTED | NOT TESTED | NOT TESTED | NOT TESTED | Added to the test list 2026-09-26. Nothing about it is known yet; do not assume it behaves like any phone above. |
| Any of the above in Messenger | NOT TESTED | Messenger in-app browser | Embedded webview | NOT TESTED | NOT TESTED | NOT TESTED | NOT TESTED | NOT TESTED | NOT TESTED | NOT TESTED | NOT TESTED | NOT TESTED | Open in Chrome / Safari first | FurnishAR now shows the hand-off before trying AR. |

## On-device AI (added 2026-09-26)

From `/diagnose` → **Check AI camera capability** and the scene reading of
**Check the camera and motion sensors**. Every cell is NOT TESTED: no phone
has run the AI check yet. Headless desktop Chromium (no GPU) measured WASM,
average ≈ 38 ms, p95 ≈ 55 ms on the test model; that is a desktop CPU and
says nothing about any phone.

| Device | Browser | WebGPU adapter | AI backend used | Model load (ms) | Warm-up (ms) | Average (ms) | p95 (ms) | AI level | Scene: lighting / blur / texture | Recommended level (A–E) | Notes |
|---|---|---|---|---|---|---|---|---|---|---|---|
| Infinix X6728 (HOT 60i) | NOT TESTED | NOT TESTED | NOT TESTED | NOT TESTED | NOT TESTED | NOT TESTED | NOT TESTED | NOT TESTED | NOT TESTED | NOT TESTED | |
| TECNO KI5k (Spark 10C) | NOT TESTED | NOT TESTED | NOT TESTED | NOT TESTED | NOT TESTED | NOT TESTED | NOT TESTED | NOT TESTED | NOT TESTED | NOT TESTED | |
| vivo 1906 (Y11) | NOT TESTED | NOT TESTED | NOT TESTED | NOT TESTED | NOT TESTED | NOT TESTED | NOT TESTED | NOT TESTED | NOT TESTED | NOT TESTED | |
| iPhone 12 | NOT TESTED | NOT TESTED | NOT TESTED | NOT TESTED | NOT TESTED | NOT TESTED | NOT TESTED | NOT TESTED | NOT TESTED | NOT TESTED | |
| Redmi 14C | NOT TESTED | NOT TESTED | NOT TESTED | NOT TESTED | NOT TESTED | NOT TESTED | NOT TESTED | NOT TESTED | NOT TESTED | NOT TESTED | |

AI levels (`lib/spatial/ai/config.mjs`): **ai-gpu** p95 ≤ 100 ms on WebGPU ·
**ai-realtime** p95 ≤ 100 ms on WASM · **ai-single-frame** p95 ≤ 1500 ms ·
**ai-none** slower, or the runtime could not start. The test model is a
synthetic benchmark (`docs/AI-DEVICE-COMPATIBILITY.md`), so the level says how
fast the phone runs a model of that size, not how well it sees floors.

Source of the filled cells: the field notes in the task brief of 2026-09-24,
which summarise the tests recorded in the Google Drive folder "system furnish
requirements". The recordings themselves still have to be reviewed against
this table (see `docs/FIELD-EVIDENCE-FINDINGS.md`).

## Re-test after this change

For each phone, record:

| Device | Browser / context | AR mode selected | Session result | Hit-test result | Surface result | Measurement method | Known real measurement | Reported measurement | Error % | UI problems |
|---|---|---|---|---|---|---|---|---|---|---|
| Infinix X6728 | | | | | | | | | | |
| TECNO KI5k | | | | | | | | | | |
| vivo 1906 | | | | | | | | | | |
| iPhone 12 | | | | | | | | | | |
| Redmi 14C | | | | | | | | | | |

`Error % = |reported − real| / real × 100`.

Nothing in this repository may say "works across devices" until this table is
filled in from real phones.

## Pasted reports

<!-- One fenced JSON block per phone, from /diagnose → Copy technical report. -->
