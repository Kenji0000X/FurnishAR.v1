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
| Frames for the scene-quality reading (lighting, blur, texture, motion) | On the phone: a 160-pixel greyscale copy in a canvas, for about half a second | Never; the canvas is discarded after the check | Never |
| The AI check (runtime and test model) | On the phone: ONNX Runtime Web on WebGPU or WASM | The browser's HTTP cache may keep the downloaded runtime and model | **Downloaded** from FurnishAR's own origin, only after a tap. Nothing is uploaded. |
| The AI benchmark's input | On the phone | Never | Never. It is a synthetic tensor, not a camera frame. |
| AI results (backend, timings, level, scene verdicts) | On the phone | Never | Only inside the technical report, if the person sends it themselves |

The technical report is an allowlist (`diagnosticReport` in
`lib/spatial/capabilities.mjs`). A browser has no access to IMEI, serial
number, ICCID, MEID or MAC addresses; the report also refuses any field with
such a name, so a future change cannot add one by accident. It contains the
user agent (which may include the phone's model name), viewport, camera
resolution, WebXR results, frame and hit counts and sensor rates.

Protected 3D models are the only AR data fetched from the server, through
the signed-URL flow (`/api/sb/model`), unchanged by this work.

**On-device AI (2026-09-26).** AI runs on the phone or not at all.
- There is no cloud vision call.
- No camera frame is uploaded; `npm run check:ai` fails if the scene check
  makes any request that is not a GET.
- The AI adds no identifier to the report and fingerprints nothing: it
  records how fast a model ran, not who ran it.

See `docs/AI-DEVICE-COMPATIBILITY.md`.
