# AI-assisted device compatibility

How `/diagnose` decides which FurnishAR experience a phone gets, and what the
on-device AI in it can and cannot claim. Written 2026-09-26 with the code in
`lib/spatial/capabilities.mjs` and `lib/spatial/ai/`. Device results live in
`AR-DEVICE-MATRIX.md`; this file describes the mechanism only.

## 1. The rule

**AI is a capability with levels, not a verdict about the phone.** A phone does
not "support AI". It runs a given model at a measured speed on a measured
backend. Everything in the recommendation is measured on that phone in that
browser. Nothing is inferred from the model name, RAM, chipset or camera.

**AI never overrides WebXR.** Whether tracked AR works is proven only by an
AR session that opens and hits real surfaces (the AR check). AI can add
guidance on top of tracked AR, or make the non-tracked methods better. It
never turns "tracked AR failed" into "tracked AR works".

**AI never produces a metric measurement.** Distances and areas come from
WebXR hit tests, the orientation-sensor maths, the photo homography with a
known reference, or a tape measure (`ROOM-MEASUREMENT-VALIDATION.md`). The
AI output is guidance, like "too dark" or "hold still", that the person acts
on. It is not a number FurnishAR reports as a size.

**On the phone only.** The runtime and model are downloaded; nothing is
uploaded. No camera frame leaves the phone, and the benchmark does not use
the camera at all (§4).

## 2. The recommendation (levels A–E)

`recommendExperience(facts, assessment)` is pure: the same facts always give
the same answer, and `tests/experience-router.test.js` pins each branch.

| Level | Name | Given when (all measured) |
|---|---|---|
| A | Tracked AR+ | An AR session opened and hit surfaces, tracking held for ≥ 90% of checked frames, **and** real-time AI, or planes, or depth was observed. |
| B | Tracked AR | An AR session opened and hit surfaces, or the browser offers tracked AR and the check has not run yet (reported as unconfirmed). |
| C | AI-assisted measurement | No tracked AR; the camera works, the tilt sensor is usable, and AI runs in real time. |
| D | Photo measurement | No tracked AR; the camera works. |
| E | Manual | No usable camera. A tape measure is also the most accurate method on any phone. |

Two hand-offs come first: an in-app browser (Messenger and similar) is told to
open Chrome, and an insecure address is told to use https. iPhone never gets
A/B (Safari has no WebXR AR). Furniture opens in AR Quick Look when the piece
has a USDZ, and the room gets C/D/E like any other phone.

Every recommendation carries a **reason** and a **fallback** (the next level
down), both shown at the top of `/diagnose`.

## 3. Technology

| Choice | Why |
|---|---|
| **ONNX Runtime Web 1.30.0** (`onnxruntime-web`, MIT, pinned exactly) | Runs the same `.onnx` file on WebGPU or WebAssembly, in any modern browser, with no server. |
| **WebGPU first, WASM fallback** | WebGPU is used only if `navigator.gpu.requestAdapter()` returns an adapter **and** a session actually runs an inference on it. Any failure falls through to WASM (CPU, SIMD). If both work, the faster *measured* backend is kept: on some phones the CPU path wins. |
| **Served from our own origin** | `tools/copy-ort-assets.mjs` copies the runtime into `public/ort/` before `dev` and `build` (the folder is git-ignored). It is imported with `webpackIgnore`, so it is never part of a Next.js bundle. |
| **Single-threaded WASM** | Threads need the page to be cross-origin isolated (COOP/COEP headers), which the site does not set: every cross-origin resource, such as posters from Supabase Storage, would then need its own CORP header. Budget phones gain little from threads at this model size anyway. |

### What it costs to download

Nothing, until someone taps **Check AI camera capability** on `/diagnose`.
`npm run check:ai` proves that browsing the home page, collection, portal and
`/diagnose` itself requests none of these files. It also proves no Next.js
chunk contains ONNX Runtime.

| File | Size | gzip | When |
|---|---|---|---|
| `ort.wasm.min.mjs` + `ort-wasm-simd-threaded.mjs` | 74 KB | 25 KB | WASM path |
| `ort-wasm-simd-threaded.wasm` | 14.2 MB | 3.66 MB | WASM path |
| `ort.webgpu.min.mjs` + asyncify glue | 119 KB | 40 KB | only when a GPU adapter exists |
| `ort-wasm-simd-threaded.asyncify.wasm` | 26.8 MB | 6.58 MB | only when a GPU adapter exists |
| `ai/furnishar-bench-v1.onnx` | 4.3 MB | 3.96 MB | always, for the check |

Compressed in transit, a phone without WebGPU downloads about 7.6 MB
(18.5 MB uncompressed). A phone with a GPU adapter downloads the GPU build
(about 10.6 MB with the model); if the GPU turns out slower than real time,
the WASM build is measured too, about 14 MB in all. The button says "about
8 MB … up to 15 MB" before the tap.

## 4. The benchmark model — what it is and is not

`public/ai/furnishar-bench-v1.onnx` is produced by
`scripts/build-ai-bench-model.py`, which is deterministic (seed 20260926):
- a synthetic network with the shape and arithmetic of a small MobileNet-width
  segmentation model: depthwise-separable convolutions at 192 × 192 input,
  about 285 M multiply-adds;
- ONNX opset 17, 4.3 MB.

**It is a performance probe, not a scene model.** Its weights are random. It
tells us how fast this phone's runtime can run a model of that size. It cannot
recognise a floor or a wall, and nothing may present its output as one.
`floorConfidence` and `wallConfidence` in the report therefore stay `null`
("not tested").

A trained segmentation model was not available to this project: the build
environment could not reach any model host, and no trained weights are in the
repository. Adding one means:
1. add an entry to `AI_MODELS` in `lib/spatial/ai/config.mjs` with
   `kind: 'segmentation'`, its labels and its licence;
2. keep it under about 5 MB so the single-frame level stays realistic;
3. validate its floor mask against recorded frames from the test phones
   before any UI uses it.

`combineFloorEvidence()` already defines the rule for that day:
- WebXR's hit is the authority;
- AI can only *reject* a hit it is confident is not floor;
- AI never creates a floor hit.

## 5. The measurement and its levels

`runBenchmark()` (in `lib/spatial/ai/benchmark.mjs`):
1. runs 2 untimed warm-up inferences (shader compilation, first allocation);
2. then times 12 inferences on a synthetic deterministic tensor;
3. reads each output back, which forces a GPU to finish;
4. reports load, warm-up, average and p95 (nearest rank) latency and an fps
   estimate;
5. then disposes of the tensors and releases the session.

| Level | Rule | Used for |
|---|---|---|
| `ai-gpu` | p95 ≤ 100 ms on WebGPU | live guidance |
| `ai-realtime` | p95 ≤ 100 ms on WASM | live guidance |
| `ai-single-frame` | p95 ≤ 1500 ms | analysing one captured photo |
| `ai-none` | slower, or no runtime | none; the non-AI methods remain |

The limits:
- **100 ms**: live guidance runs 5–15 times a second, never every camera
  frame, and 10 per second needs a p95 of 100 ms.
- **1.5 s**: the longest wait that still reads as "working" after a tap.

Both are starting points, to be tuned from the device matrix. The p95 is used,
not the mean, because the slow inferences are the ones that make guidance lag.

**Thermal back-off.** `AdaptiveCadence` keeps the median of the first five
latencies as a baseline:
- when the recent median reaches 1.5× that baseline, it doubles the interval
  (at most once per four samples);
- at 2.5×, it stops live AI so single-frame analysis can be offered instead.

Timeouts:
- 8 s for a single inference;
- 45 s for download plus session creation.

**Failures are reported in words.** `classifyAiError()` maps each failure to
one of: model download failed, model unsupported, WebGPU failed to start,
WASM failed to start, out of memory, inference timed out, or AI unavailable.
The ONNX Runtime error text is never shown to the person.

Measured here, for scale only: headless desktop Chromium without a GPU
reached WASM, average ≈ 38 ms, p95 ≈ 55 ms (`ai-realtime`). A native
single-thread x86 run of the same model took 5.7 ms. **No phone has been
measured**; see `AR-DEVICE-MATRIX.md`.

## 6. Scene quality — no model needed

`lib/spatial/ai/scene.mjs` judges a few camera frames using classical measures
on a 160-pixel luminance copy (`lib/spatial/ai/camera-scene.mjs`). The frames
live in a canvas for the length of the check and are then discarded.

| Verdict | Measure | Starting threshold |
|---|---|---|
| Lighting: dark | mean luminance, share of near-black pixels | mean < 45, or > 60% near-black |
| Lighting: overexposed | share of clipped pixels | > 25% |
| Motion blur | variance of the Laplacian | < 60 |
| Featureless surface | share of pixels with edge gradient ≥ 24 | < 4% |
| Moving too fast | mean frame-to-frame luminance difference | > 18 |
| Floor out of view | camera angle from straight down (orientation sensor) | > 80° |

Guidance shows at most two sentences, for example "More light, please" or
"Hold the phone still". The thresholds are uncalibrated starting points, to
be tuned from recorded frames of the test phones, not from one room.

## 7. Privacy

- Nothing is uploaded. `check:ai` fails if the scene check sends any request
  that is not a GET, and the AI check only fetches the runtime and the model
  from FurnishAR's own origin.
- The report is allowlisted (`REPORT_KEYS` in `capabilities.mjs`). It holds
  measured facts only: no IMEI, serial number, ICCID, MEID, MAC address,
  advertising id or camera frame. `check:ai` fails if any of those names
  appear.
- No fingerprinting: the facts are what `/diagnose` measured, recorded only
  when the person copies the report.

## 8. Checks

| Command | Proves |
|---|---|
| `node --test tests/experience-router.test.js` | every A–E branch, the hand-offs, iPhone, the fallbacks |
| `node --test tests/ai-benchmark.test.js` | percentile, timeouts, the level rules, error wording, thermal back-off |
| `node --test tests/ai-scene.test.js` | each scene verdict from synthetic frames; WebXR stays the floor authority |
| `npm run check:ai` | lazy loading, real inferences in a browser, the WASM fallback, a failed download failing soft, scene quality from a fake camera, no uploads |
| `npm run check:diagnose` | the `/diagnose` page, its rows and the recommendation |

## 9. Not yet done

- **No phone has run the AI check.** Every AI cell in the device matrix is
  NOT TESTED, the Redmi 14C row included.
- **No trained floor/wall model.** Floor and wall confidence stay null (§4).
- **The measurement pages do not use AI guidance yet.** `/diagnose`
  recommends level C, and the planner's aim and photo methods work without
  AI. Live AI guidance inside the planner waits for the device measurements,
  so it does not ship to phones it would slow down.
