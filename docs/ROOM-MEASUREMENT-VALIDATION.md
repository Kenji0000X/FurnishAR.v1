# Room measurement validation

FurnishAR measures rooms four ways. This is the protocol for finding out how
accurate each one really is, **against a tape measure**. Until these tables are
filled, no accuracy figure may be claimed for any method.

## Repeatability is not accuracy

The tracked room scan and the floor-area scan both require two scans that
agree within 5%. That is a **repeatability** check: the same hand, the same
phone, the same tracker gave the same answer twice. Two scans with the same
systematic error agree perfectly. Real-world accuracy is only known from the
comparison below.

## Methods

| Method | Where | What produces the number |
|---|---|---|
| WebXR | Planner → Scan with your camera (Android Chrome with ARCore) | Hit-test corners, each from a 450 ms window of hits (median, outliers rejected), floor height checked per corner, two agreeing scans |
| Tilt | Measure without AR → Aim with phone | Camera angle from the full device orientation and screen rotation, calibrated for the session, × holding height: d = h · tan θ |
| Photo | Measure without AR → Photo reference | Four corners of a known rectangle → homography → distance on that wall's plane |
| Manual | Measure without AR → Tape measure | Typed figures in m / cm / ft / in |

## AI does not produce any of these numbers

The on-device AI check (`docs/AI-DEVICE-COMPATIBILITY.md`) can recommend
level C, "AI-assisted measurement", and it reads scene quality: too dark,
blurred, featureless, moving too fast, floor out of view. That is
**guidance**. None of the four methods above takes a length, an area or a
floor position from an AI model, and none may until a trained model has been
validated with the tables below. In particular:

- a monocular model's depth is relative, not metric, and is never reported as
  a distance;
- WebXR's hit test stays the authority on where the floor is. AI may only
  *reject* a hit it is confident is not floor, never create one
  (`combineFloorEvidence`).

When filling the tables, note the scene verdicts `/diagnose` reported
("Lighting", "Tracking conditions"). They are how guidance and accuracy will
later be related.

## Distances

Mark each distance on the floor with tape. Measure it with a steel tape. Take
three readings with each method.

| Device | Method | Tape measurement | FurnishAR run 1 | Run 2 | Run 3 | Mean | Absolute error | Error % | Tracking conditions | Lighting | Confidence reported |
|---|---|---|---|---|---|---|---|---|---|---|---|
| | WebXR | 1.00 m | | | | | | | | | |
| | WebXR | 2.00 m | | | | | | | | | |
| | WebXR | 3.00 m | | | | | | | | | |
| | WebXR | 4.00 m | | | | | | | | | |
| | Tilt | 1.00 m | | | | | | | | | |
| | Tilt | 2.00 m | | | | | | | | | |
| | Tilt | 3.00 m | | | | | | | | | |
| | Tilt | 4.00 m | | | | | | | | | |
| | Photo | 1.00 m | | | | | | | | | |
| | Photo | 2.00 m | | | | | | | | | |
| | Photo | 3.00 m | | | | | | | | | |
| | Photo | 4.00 m | | | | | | | | | |
| | Manual | 1.00 m | | | | | | | | | |
| | Manual | 2.00 m | | | | | | | | | |
| | Manual | 3.00 m | | | | | | | | | |
| | Manual | 4.00 m | | | | | | | | | |

`Error % = |measured − reference| / reference × 100`
(`measurementError()` in `public/geometry.js` does this arithmetic.)

## A known rectangular room

Measure the room's length and width with a steel tape, and its height if a
method reports it.

| Device | Method | Tape L × W (× H) | FurnishAR L × W (× H) | Absolute error L / W | Error % L / W | Scans agreed within | Tracking conditions | Lighting | Confidence reported |
|---|---|---|---|---|---|---|---|---|---|
| | WebXR | | | | | | | | |
| | Tilt | | | | | | | | |
| | Photo | | | | | | | | |
| | Manual | | | | | | | | |

Record for every row: the phone model, OS and browser version, the holding
height used (tilt), the reference object used (photo), whether the tilt
method was calibrated, and the build stamp from the footer.

## If a method is off, find out why

If a 3.00 m wall reads 2.60 m, **do not** multiply every answer by 3 / 2.6.
The thresholds and constants all live in `lib/spatial/measure-config.mjs`, and
none of them is a scale factor. Check, in order:

1. **Tilt:** the holding height actually used (it scales every distance); the
   calibration (was the phone upright when calibrated?); the roll (the tilt
   method refuses past 10°); the angle itself — `/diagnose` shows the event
   rate, and a slow sensor lags.
2. **Heading:** a room outline needs a steady compass. `/diagnose` shows how
   many readings were rejected as jumps. Near steel frames, meter boxes or
   appliances, use single distances or photo instead.
3. **WebXR:** the spread each corner was captured with (a corner that moved
   more than 3 cm is refused); lighting and floor texture; whether local-floor
   was granted (see the report).
4. **Photo:** the reference's real size; how square the photo was (the skew
   check); whether the measured line is on the SAME plane as the reference.
5. **Manual:** the unit selected.

Calibration may remove a constant sensor offset (the tilt calibration does,
capped at 8°). It must never become a fudge factor tuned to one room.

## Thresholds to calibrate from this data

All in `lib/spatial/measure-config.mjs`, all currently uncalibrated starting
points: the hit sampling window and spread limit, the floor normal tilt, the
floor height tolerance, the room-size limits, the aim roll limit and steadiness
limit, and the photo skew and extrapolation limits. When the tables above are
filled, adjust them there, with the data cited in the comment.
