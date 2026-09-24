# Camera, sensors and room data: what stays on the phone

| Data | Processed where | Stored | Transmitted |
|---|---|---|---|
| Camera frames (tracked AR, aim, photo) | On the phone, in the browser | Never | Never |
| A photo taken for the photo method | On the phone, in memory | Not stored; gone when the measuring screen closes | Never |
| WebXR poses, hit points, planes, depth | On the phone | Never | Never |
| Motion sensor readings, calibration | On the phone | Calibration lives only for the open session | Never |
| The measured room (length, width, height, area) | On the phone | In the planner's page state; the last floor-area / clearance figures in this browser's localStorage for a day | Never |
| Measuring unit, measure mode | On the phone | localStorage | Never |
| /diagnose results and the technical report | On the phone | Never | Only if the person copies the report and sends it themselves |

The technical report is an allowlist (`diagnosticReport` in
`lib/spatial/capabilities.mjs`). A browser has no access to IMEI, serial
number, ICCID, MEID or MAC addresses; the report also refuses any field with
such a name, so a future change cannot add one by accident. It contains the
user agent (which may include the phone's model name), viewport, camera
resolution, WebXR results, frame and hit counts and sensor rates.

Protected 3D models are the only AR data fetched from the server, through
the signed-URL flow (`/api/sb/model`), unchanged by this work.
