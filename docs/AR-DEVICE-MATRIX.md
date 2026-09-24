# AR device matrix

What each tested phone was **observed** to do. A cell is filled only from a
physical test. Anything not yet tested says **NOT TESTED** — including cells
that the rest of the codebase would let you guess.

How to fill a row: open `/diagnose` on the phone, in the browser named in the
row. Run **Run the AR check** (point at the floor, move slowly), then **Check
the camera and motion sensors** (hold up, turn slowly). Open **Technical
details**, tap **Copy technical report**, and paste the report under the table.
The report holds no hardware identifiers.

| Device | OS | Browser | Context | WebXR advertised | Session opened | Hit test | Surface hits | Plane detection | Depth | Tilt sensor | Heading quality | Camera | Recommended mode | Notes |
|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|
| Infinix X6728 (HOT 60i) | Android — version NOT TESTED | Chrome — version NOT TESTED | Normal browser | Yes | Yes | Granted | Yes (furniture placed in the room) | May not be granted | Not available through WebXR (the hardware supports ARCore Depth) | NOT TESTED | NOT TESTED | Works | Tracked AR | The most functional tested device. Needs hit-test only; placement must not depend on planes or depth. |
| TECNO KI5k (Spark 10C) | Android — NOT TESTED | NOT TESTED | Normal browser | NOT TESTED | Does not reliably start | NOT TESTED | NOT TESTED | NOT TESTED | NOT TESTED | NOT TESTED | NOT TESTED | Camera APIs available | Photo + tape measure (aim if the sensor check passes) | Must not be treated like the Infinix. |
| vivo 1906 (Y11) | Android — NOT TESTED | NOT TESTED | Normal browser | NOT TESTED | Not reliable / not available | NOT TESTED | NOT TESTED | NOT TESTED | NOT TESTED | NOT TESTED | NOT TESTED | Works | Photo + tape measure (aim if the sensor check passes) | Needs the non-WebXR path. |
| iPhone 12 | iOS — NOT TESTED | Safari — NOT TESTED | Normal browser | No (Safari has no WebXR AR) | Not applicable | Not applicable | Not applicable | Not applicable | Not applicable | NOT TESTED | NOT TESTED | NOT TESTED | Quick Look for furniture; photo, tape (and aim if reliable) for the room | Placement needs a protected USDZ per product. |
| Any of the above in Messenger | NOT TESTED | Messenger in-app browser | Embedded webview | NOT TESTED | NOT TESTED | NOT TESTED | NOT TESTED | NOT TESTED | NOT TESTED | NOT TESTED | NOT TESTED | NOT TESTED | Open in Chrome / Safari first | FurnishAR now shows the hand-off before trying AR. |

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

`Error % = |reported − real| / real × 100`.

Nothing in this repository may say "works across devices" until this table is
filled in from real phones.

## Pasted reports

<!-- One fenced JSON block per phone, from /diagnose → Copy technical report. -->
