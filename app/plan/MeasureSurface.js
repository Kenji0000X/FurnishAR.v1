'use client';

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import {
  distanceFromTilt, heightFromTilt, floorPointFromAim,
  surfacesFromCorners, projectFloorPoint
} from '../../lib/spatial/clinometer.mjs';
import { wallsToCorners } from '../../lib/spatial/photo-scale.mjs';
import { REFERENCE_RECTANGLES, referencePlane, measureOnPlane } from '../../lib/spatial/homography.mjs';
import { roomDimensions } from '../../lib/spatial/room.mjs';
import { HeadingTracker, TiltTracker } from '../../lib/spatial/heading.mjs';
import { Steadiness } from '../../lib/spatial/smoothing.mjs';
import { cameraPose, applyCalibration, calibrationFrom } from '../../lib/spatial/orientation.mjs';
import { AIM } from '../../lib/spatial/measure-config.mjs';
import {
  ROOM_UNITS, manualRoom, convertRoomFields, formatRoomLength
} from '../../lib/spatial/room-units.mjs';
import {
  gradeMeasurement, formatMeasurement, METHOD, CONFIDENCE_COPY
} from '../../lib/spatial/confidence.mjs';

/**
 * Measuring a room on a phone that cannot run tracked AR.
 *
 * Where WebXR is missing (TECNO KI5k, vivo 1906, every iPhone, any in-app
 * browser) there is no world tracking, and nothing here pretends otherwise.
 * What is left is real measurement by other means, offered according to what
 * THIS phone's sensors actually do:
 *
 *   Aim with phone   The camera's angle from straight down, from the FULL
 *                    device orientation (alpha, beta, gamma and the screen
 *                    rotation — lib/spatial/orientation.mjs), calibrated for
 *                    this phone, plus the holding height, gives the distance to
 *                    the floor point under the crosshair. A room OUTLINE also
 *                    needs a steady compass; without one, single distances
 *                    only.
 *   Photo reference  Four corners of a rectangle of known size fix the
 *                    perspective of one wall (a homography); lines on that
 *                    wall are then measured in metres. One wall per photo.
 *   Tape measure     Typed figures in a chosen unit, checked for sense. The
 *                    most accurate method, and said to be.
 *
 * Every number carries the method that produced it. All three end in
 * roomDimensions(), the same function the AR path uses.
 */

/* Named here rather than inline so the SVG, the pills and the stylesheet
   cannot drift apart. Gold for things measured directly, violet for things
   derived from them — which is the distinction the reference apps draw and
   the one that actually matters when you are checking a number. */
const GOLD = '#f2c14e';
const VIOLET = '#7b6bd9';

const m2cm = m => `${Math.round(m * 100)} cm`;
const fmt = (n, unit, digits = 2) => (n == null ? '—' : `${n.toFixed(digits)} ${unit}`);

/* ------------------------------------------------------------------ pills -- */

function EdgePill({ x, y, children }) {
  /* The gold edge label. Width is estimated from the text length rather than
     measured: getBBox() forces a synchronous layout on every orientation
     event, which on a mid-range phone is the difference between a readout
     that tracks the crosshair and one that lags behind it. */
  const w = String(children).length * 7.4 + 14;
  return (
    <g transform={`translate(${x} ${y})`}>
      <rect x={-w / 2} y={-10} width={w} height={20} rx={10} fill={GOLD} />
      <text x={0} y={4} textAnchor="middle" className="ms-edge-text">{children}</text>
    </g>
  );
}

function StatPills({ x, y, rows }) {
  return (
    <g transform={`translate(${x} ${y})`}>
      {rows.map((row, i) => {
        const w = row.length * 7.2 + 18;
        return (
          <g key={row} transform={`translate(0 ${i * 24})`}>
            <rect x={-w / 2} y={-11} width={w} height={22} rx={11} fill={VIOLET} opacity="0.92" />
            <text x={0} y={4} textAnchor="middle" className="ms-stat-text">{row}</text>
          </g>
        );
      })}
    </g>
  );
}

/* ------------------------------------------------------------- floor plan -- */

/**
 * The outline so far, seen from above.
 *
 * This is the part that makes the measuring feel live: every tap adds a
 * vertex and every edge carries its own length, so the room is legible
 * before it is finished rather than only at the end.
 */
function FloorPlan({ corners, closed, room, width = 320, height = 240 }) {
  const pad = 46;
  const pts = corners;
  if (!pts.length) {
    return (
      <svg className="ms-plan" viewBox={`0 0 ${width} ${height}`} role="img"
        aria-label="Floor plan, nothing measured yet">
        <text x={width / 2} y={height / 2} textAnchor="middle" className="ms-plan-empty">
          Corners appear here as you tap them
        </text>
      </svg>
    );
  }

  /*
     Turn the outline so its longest wall lies across the screen.

     Bearings are measured relative to whichever corner was tapped first, so
     the raw outline sits at whatever angle the person happened to be facing.
     A true 4 x 3 room tapped from the middle comes out as a diamond: correct
     to the centimetre and much harder to read than the same rectangle lying
     flat. Rotating by the longest edge's angle costs nothing — no dimension
     depends on the room's bearing — and makes it a floor plan rather than a
     puzzle.
  */
  let best = 0, bestLen = -1;
  for (let i = 0; i < pts.length; i += 1) {
    const a = pts[i], b = pts[(i + 1) % pts.length];
    if (!closed && i === pts.length - 1) break;
    const len = Math.hypot(b.x - a.x, b.z - a.z);
    if (len > bestLen) { bestLen = len; best = Math.atan2(b.z - a.z, b.x - a.x); }
  }
  const cos = Math.cos(-best), sin = Math.sin(-best);
  const spun = pts.map(p => ({ x: p.x * cos - p.z * sin, z: p.x * sin + p.z * cos }));
  const me = { x: 0 * cos - 0 * sin, z: 0 * sin + 0 * cos };

  const xs = spun.map(p => p.x), zs = spun.map(p => p.z);
  const minX = Math.min(...xs), maxX = Math.max(...xs);
  const minZ = Math.min(...zs), maxZ = Math.max(...zs);
  // Scaled per axis against the box it has, so a long thin room uses the
  // width it is given instead of being sized by its longest side alone.
  const scale = Math.min(
    (width - pad * 2) / Math.max(maxX - minX, 0.5),
    (height - pad * 2) / Math.max(maxZ - minZ, 0.5)
  );
  const cx = (minX + maxX) / 2, cz = (minZ + maxZ) / 2;
  const put = p => ({
    x: width / 2 + (p.x - cx) * scale,
    y: height / 2 + (p.z - cz) * scale
  });
  const screen = spun.map(put);
  const middle = put({ x: cx, z: cz });

  // Every edge that exists, plus the closing one only once it is real.
  const edges = [];
  for (let i = 0; i < screen.length - 1; i += 1) edges.push([i, i + 1]);
  if (closed && screen.length > 2) edges.push([screen.length - 1, 0]);

  const stats = [];
  if (room?.length) stats.push(`L = ${m2cm(Math.max(room.length, room.width))}`);
  if (room?.width) stats.push(`W = ${m2cm(Math.min(room.length, room.width))}`);
  if (room?.height) stats.push(`H = ${m2cm(room.height)}`);
  if (room?.floorArea) stats.push(`S = ${room.floorArea.toFixed(2)} m²`);
  if (room?.perimeter) stats.push(`P = ${m2cm(room.perimeter)}`);
  if (room?.volume) stats.push(`V = ${room.volume.toFixed(2)} m³`);

  return (
    <svg className="ms-plan" viewBox={`0 0 ${width} ${height}`} role="img"
      aria-label={`Floor plan with ${pts.length} corners`}>
      {closed && screen.length > 2 && (
        <polygon points={screen.map(p => `${p.x},${p.y}`).join(' ')}
          fill={GOLD} opacity="0.10" />
      )}
      {edges.map(([a, b]) => (
        <line key={`${a}-${b}`} x1={screen[a].x} y1={screen[a].y}
          x2={screen[b].x} y2={screen[b].y} stroke={GOLD} strokeWidth="2" />
      ))}
      {/*
          Edge labels pushed OUTWARD, away from the middle.

          Left at the edge midpoint they collide with the stat stack, and on
          a small room the two sets of pills land on top of each other and
          neither can be read. Offsetting along the outward normal is what
          the reference app does: measured lengths ring the shape, derived
          values sit inside it.
      */}
      {edges.map(([a, b]) => {
        const len = Math.hypot(pts[b].x - pts[a].x, pts[b].z - pts[a].z);
        const mx = (screen[a].x + screen[b].x) / 2;
        const my = (screen[a].y + screen[b].y) / 2;
        const away = Math.hypot(mx - middle.x, my - middle.y) || 1;
        const push = 17;
        return (
          <EdgePill key={`L${a}-${b}`}
            x={mx + ((mx - middle.x) / away) * push}
            y={my + ((my - middle.y) / away) * push}>
            {m2cm(len)}
          </EdgePill>
        );
      })}
      {screen.map((p, i) => (
        <circle key={i} cx={p.x} cy={p.y} r="5" fill="#1b1206" stroke={GOLD} strokeWidth="2.5" />
      ))}
      {/* Where you were standing. Every distance was measured from here, so
          leaving it off would make the outline harder to sanity-check. */}
      <circle cx={put(me).x} cy={put(me).y} r="4" fill={VIOLET} />
      {stats.length > 0 && closed && (
        <StatPills x={width / 2} y={height / 2 - (stats.length - 1) * 12} rows={stats} />
      )}
    </svg>
  );
}

/* ================================================================= surface = */

/** Which way the screen is turned, for turning the device pose into a camera pose. */
function screenAngle() {
  if (typeof window === 'undefined') return 0;
  const a = window.screen?.orientation?.angle;
  if (Number.isFinite(a)) return a;
  return Number.isFinite(window.orientation) ? window.orientation : 0;
}

const METHOD_NAME = {
  aim: 'Aim with phone',
  point: 'Aim with phone',
  photo: 'Photo reference',
  manual: 'Tape measure'
};

const CORNER_NAMES = ['top-left', 'top-right', 'bottom-right', 'bottom-left'];

export default function MeasureSurface({ onUseRoom, onClose }) {
  const [mode, setMode] = useState('choose');
  const [eyeHeight, setEyeHeight] = useState(1.4);
  /*
     Asked before anything is measured, not buried in a settings sheet.

     Every distance is height x tan(theta), so the height is a direct scale
     factor on the WHOLE room: hold the phone at 1.10 m while the app assumes
     1.40 and every wall comes back 27% short, with nothing on screen looking
     wrong. It is the one input that can be silently, uniformly incorrect,
     which is exactly why it gets its own step.
  */
  const [heightConfirmed, setHeightConfirmed] = useState(false);
  const [corners, setCorners] = useState([]);
  const [closed, setClosed] = useState(false);
  const [ceiling, setCeiling] = useState(null);
  const [note, setNote] = useState(null);

  /* ------------------------------------------------------------- probe -- */
  /* What this phone's sensors actually report, measured for a moment when
     the surface opens, so the method list claims only what was observed. */
  const [probe, setProbe] = useState({ done: false, events: 0, rate: 0, xr: null });
  useEffect(() => {
    let events = 0;
    const onOrient = e => { if (Number.isFinite(e.beta)) events += 1; };
    window.addEventListener('deviceorientation', onOrient);
    const started = performance.now();
    let xr = null;
    navigator.xr?.isSessionSupported?.('immersive-ar').then(ok => { xr = ok; }).catch(() => { xr = false; });
    const timer = setTimeout(() => {
      window.removeEventListener('deviceorientation', onOrient);
      const seconds = (performance.now() - started) / 1000;
      setProbe({ done: true, events, rate: events / seconds, xr, needsPermission: typeof window.DeviceOrientationEvent?.requestPermission === 'function' });
    }, 1200);
    return () => { clearTimeout(timer); window.removeEventListener('deviceorientation', onOrient); };
  }, []);

  /* Live sensor state. Kept in a ref as well as in state: the ref is what the
     tap handler reads, so a corner is placed from the angle at the instant of
     the tap rather than from whatever React last rendered. */
  const live = useRef({ tilt: null, bearing: null, roll: 0, events: 0 });
  const [reading, setReading] = useState({ tilt: null, bearing: null, roll: 0, events: 0 });
  const heading = useRef(new HeadingTracker());
  const tiltTrack = useRef(new TiltTracker());
  const [compass, setCompass] = useState({ verdict: 'unknown' });
  const steady = useRef(new Steadiness(30));
  const [settled, setSettled] = useState(false);

  /* Calibration: this session only. `null` until done or skipped. */
  const [calibration, setCalibration] = useState(null);
  const calibrationRef = useRef(null);
  calibrationRef.current = calibration;
  const calSamples = useRef(null);
  const [calibrating, setCalibrating] = useState(false);
  const rate = useRef({ count: 0, since: 0, hz: null });

  const [showPlan, setShowPlan] = useState(false);
  const [pendingA, setPendingA] = useState(null);
  const [segments, setSegments] = useState([]);
  const viewRef = useRef(null);
  const [view, setView] = useState({ w: 0, h: 0 });

  const videoRef = useRef(null);
  const streamRef = useRef(null);
  const [cameraError, setCameraError] = useState(null);

  useEffect(() => {
    const previous = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
    return () => { document.body.style.overflow = previous; };
  }, []);

  /* ------------------------------------------------------------ camera -- */
  const wantsCamera = (mode === 'aim' || mode === 'point') ? heightConfirmed : mode === 'photo';
  useEffect(() => {
    if (!wantsCamera) return undefined;
    let dead = false;
    navigator.mediaDevices?.getUserMedia({ video: { facingMode: { ideal: 'environment' } }, audio: false })
      .then(stream => {
        if (dead) { stream.getTracks().forEach(t => t.stop()); return; }
        streamRef.current = stream;
        if (videoRef.current) videoRef.current.srcObject = stream;
      })
      .catch(err => setCameraError(err?.name === 'NotAllowedError'
        ? 'Camera access was refused for this site.'
        : 'The camera would not open.'));
    return () => {
      dead = true;
      streamRef.current?.getTracks().forEach(t => t.stop());
      streamRef.current = null;
    };
  }, [wantsCamera, mode]);

  /* ------------------------------------------------------- tilt sensor -- */
  const startSensor = useCallback(async () => {
    try {
      const gate = window.DeviceOrientationEvent?.requestPermission;
      if (typeof gate === 'function') {
        const granted = await gate.call(window.DeviceOrientationEvent);
        if (granted !== 'granted') { setNote('Motion access was refused, so aiming cannot work. Use Photo reference or Tape measure.'); return undefined; }
      }
    } catch { /* Android has no gate */ }

    const onOrient = e => {
      /*
         The camera's angle from straight down, from the WHOLE orientation
         and the screen rotation — not beta. beta alone is right only in
         portrait with the phone perfectly unrolled; in landscape it reads
         the horizon as the floor at your feet.
      */
      const raw = cameraPose({ alpha: e.alpha, beta: e.beta, gamma: e.gamma }, screenAngle());
      if (!raw) return;
      if (calSamples.current) calSamples.current.push(raw);
      const pose = applyCalibration(raw, calibrationRef.current);
      const now = performance.now();

      const r = rate.current;
      if (!r.since) r.since = now;
      r.count += 1;
      if (now - r.since >= 1000) { r.hz = (r.count * 1000) / (now - r.since); r.count = 0; r.since = now; }

      const tilt = tiltTrack.current.push(pose.angleFromDown, now);
      /* The line of sight's own bearing. Only the bearing RELATIVE to the
         first reading is used: a drift common to every corner rotates the
         room, which changes no dimension of it. */
      const { bearing } = heading.current.push(Number.isFinite(pose.heading) ? pose.heading : null, now);
      live.current = { tilt, bearing, roll: pose.roll, events: live.current.events + 1, hz: r.hz };
      setReading(live.current);

      steady.current.push(tilt + bearing);
      const spread = steady.current.spread();
      setSettled(steady.current.ready && spread !== null && spread < AIM.maxSteadySpreadDeg);

      if (live.current.events % 20 === 0) setCompass(heading.current.reliability);
    };
    window.addEventListener('deviceorientation', onOrient);
    return () => window.removeEventListener('deviceorientation', onOrient);
  }, []);

  useEffect(() => {
    if (mode !== 'aim' && mode !== 'point') return undefined;
    let off = null;
    let dead = false;
    startSensor().then(fn => { if (dead) fn?.(); else off = fn; });
    return () => { dead = true; if (off) off(); };
  }, [mode, startSensor]);

  function runCalibration() {
    calSamples.current = [];
    setCalibrating(true);
    setNote(null);
    setTimeout(() => {
      const result = calibrationFrom(calSamples.current);
      calSamples.current = null;
      setCalibrating(false);
      if (result.ok) {
        setCalibration(result);
        tiltTrack.current.reset();
        steady.current.reset();
      } else {
        setNote(result.reason);
      }
    }, 700);
  }

  /* --------------------------------------------------------- live shot -- */
  const shot = useMemo(
    () => distanceFromTilt({ eyeHeight, tiltDegrees: reading.tilt }),
    [eyeHeight, reading.tilt]
  );
  const rollBad = Math.abs(reading.roll || 0) > AIM.maxRollDeg;
  const slowSensor = reading.hz != null && reading.hz < AIM.minEventRate;
  /* A room OUTLINE is built from bearings, so it needs a compass that has
     been observed to behave. Distances to single points need none. */
  const outlineAllowed = AIM.headingVerdictsForOutline.includes(compass.verdict);
  const compassKnown = compass.verdict !== 'unknown';

  const room = useMemo(() => {
    if (corners.length < 3 || !closed) return null;
    const r = roomDimensions(surfacesFromCorners(corners, { ceilingHeight: ceiling }), { minFloorArea: 0.5 });
    if (r) r.method = 'aim';
    return r;
  }, [corners, closed, ceiling]);

  useEffect(() => {
    const node = viewRef.current;
    if (!node) return undefined;
    const sync = () => setView({ w: node.clientWidth, h: node.clientHeight });
    sync();
    const ro = new ResizeObserver(sync);
    ro.observe(node);
    return () => ro.disconnect();
  }, [mode, heightConfirmed, calibration]);

  const aiming = shot.distance != null;
  const viewMarks = useMemo(() => {
    if (!view.w || !view.h) return [];
    return corners.map((c, i) => {
      const at = projectFloorPoint({ point: c, eyeHeight, tiltDegrees: reading.tilt, bearingDegrees: reading.bearing });
      return { key: i, visible: at.visible, x: (at.u ?? 0) * view.w, y: (at.v ?? 0) * view.h, distance: at.distance };
    });
  }, [corners, eyeHeight, reading.tilt, reading.bearing, view.w, view.h]);

  const viewSegments = useMemo(() => {
    const out = [];
    const len = (a, b) => Math.hypot(b.x - a.x, b.z - a.z);
    for (let i = 0; i < corners.length - 1; i += 1) {
      const a = viewMarks[i], b = viewMarks[i + 1];
      if (!a?.visible && !b?.visible) continue;
      out.push({ key: `${i}`, a, b, label: m2cm(len(corners[i], corners[i + 1])), live: false });
    }
    if (closed && corners.length > 2) {
      const a = viewMarks[corners.length - 1], b = viewMarks[0];
      if (a?.visible || b?.visible) out.push({ key: 'close', a, b, label: m2cm(len(corners[corners.length - 1], corners[0])), live: false });
    }
    if (!closed && corners.length && aiming && view.w) {
      const last = viewMarks[corners.length - 1];
      const here = floorPointFromAim({ eyeHeight, tiltDegrees: reading.tilt, bearingDegrees: reading.bearing });
      if (last?.visible && here.point) {
        out.push({ key: 'live', a: last, b: { x: view.w / 2, y: view.h / 2 }, label: m2cm(len(corners[corners.length - 1], here.point)), live: true });
      }
    }
    return out;
  }, [corners, viewMarks, closed, aiming, eyeHeight, reading.tilt, reading.bearing, view.w, view.h]);

  const pointDots = useMemo(() => {
    if (!view.w || !view.h) return [];
    const all = [];
    segments.forEach((seg, i) => { all.push(['a' + i, seg.a]); all.push(['b' + i, seg.b]); });
    if (pendingA) all.push(['pending', pendingA]);
    return all.map(([key, p]) => {
      const at = projectFloorPoint({ point: p, eyeHeight, tiltDegrees: reading.tilt, bearingDegrees: reading.bearing });
      return { key, visible: at.visible, x: (at.u ?? 0) * view.w, y: (at.v ?? 0) * view.h };
    });
  }, [segments, pendingA, eyeHeight, reading.tilt, reading.bearing, view.w, view.h]);

  const pointLines = useMemo(() => {
    if (!view.w) return [];
    const byKey = Object.fromEntries(pointDots.map(d => [d.key, d]));
    const out = [];
    segments.forEach((seg, i) => {
      const a = byKey['a' + i], b = byKey['b' + i];
      if (!a?.visible && !b?.visible) return;
      out.push({ key: String(i), a, b, live: false, label: formatMeasurement(seg.metres, { spread: seg.spread }).text });
    });
    if (pendingA && aiming) {
      const a = byKey.pending;
      const here = floorPointFromAim({ eyeHeight, tiltDegrees: reading.tilt, bearingDegrees: reading.bearing });
      if (a?.visible && here.point) {
        const metres = Math.hypot(here.point.x - pendingA.x, here.point.z - pendingA.z);
        out.push({
          key: 'live', a, b: { x: view.w / 2, y: view.h / 2 }, live: true,
          label: formatMeasurement(metres, { spread: Math.hypot(pendingA.spread || 0, here.spread || 0) }).text
        });
      }
    }
    return out;
  }, [segments, pointDots, pendingA, aiming, eyeHeight, reading.tilt, reading.bearing, view.w, view.h]);

  const placedLabels = useMemo(() => {
    const kept = [];
    for (const seg of viewSegments) {
      const mx = (seg.a.x + seg.b.x) / 2;
      const my = (seg.a.y + seg.b.y) / 2;
      if (!Number.isFinite(mx) || !Number.isFinite(my)) continue;
      if (mx < 0 || my < 0 || mx > view.w || my > view.h) continue;
      if (kept.some(k => Math.abs(k.mx - mx) < 76 && Math.abs(k.my - my) < 32)) continue;
      kept.push({ ...seg, mx, my });
    }
    return kept;
  }, [viewSegments, view.w, view.h]);

  /* ------------------------------------------------------------- taps -- */
  const canCaptureAim = aiming && settled && !rollBad;

  function addCorner() {
    if (rollBad) { setNote('Straighten the phone.'); return; }
    if (!outlineAllowed) {
      setNote(compassKnown
        ? 'The compass is unstable here, so a room outline cannot be built by turning. Measure single distances, or use Photo reference or Tape measure for the room.'
        : 'Turn slowly left and right for a moment so the compass can be checked.');
      return;
    }
    const now = live.current;
    const placed = floorPointFromAim({ eyeHeight, tiltDegrees: now.tilt, bearingDegrees: now.bearing });
    if (!placed.point) { setNote(placed.reason); return; }
    setNote(placed.trust === 'coarse' ? placed.reason : null);
    setCorners(list => [...list, { ...placed.point, spread: placed.spread, trust: placed.trust }]);
    setClosed(false);
  }

  function setCeilingFromAim() {
    const now = live.current;
    if (!corners.length) { setNote('Measure at least one corner first — the ceiling needs a distance to work from.'); return; }
    const rise = (now.tilt ?? 0) - 90;
    if (rise <= 2) { setNote('Aim up at the line where the wall meets the ceiling.'); return; }
    const last = corners[corners.length - 1];
    const distance = Math.hypot(last.x, last.z);
    const h = heightFromTilt({ distance, riseDegrees: rise, eyeHeight });
    if (h.height == null) { setNote(h.reason); return; }
    setCeiling(h.height);
    setNote(`Ceiling ${m2cm(h.height)}, give or take ${Math.round(h.spread * 100)} cm.`);
  }

  /*
     Point-to-point. Two ends, both at the angle of the moment they were
     tapped; the length between them needs the bearing between them, so a
     compass observed to be jumping blocks the SECOND end with the reason.
  */
  function addPoint() {
    if (rollBad) { setNote('Straighten the phone.'); return; }
    const now = live.current;
    const placed = floorPointFromAim({ eyeHeight, tiltDegrees: now.tilt, bearingDegrees: now.bearing });
    if (!placed.point) { setNote(placed.reason); return; }
    if (!pendingA) {
      setPendingA({ ...placed.point, spread: placed.spread });
      setNote(null);
      return;
    }
    if (compass.verdict === 'bad') {
      setNote('The compass is jumping, so the angle between the two ends is not known. Move away from metal and try again, or use Photo reference.');
      return;
    }
    const metres = Math.hypot(placed.point.x - pendingA.x, placed.point.z - pendingA.z);
    const spread = Math.hypot(pendingA.spread || 0, placed.spread || 0);
    const { grade, worst } = gradeMeasurement({
      spread,
      steadiness: steady.current.spread(),
      sensorHealth: heading.current.reliability.rejectedFraction,
      method: METHOD.TILT
    });
    setSegments(list => [...list, { a: pendingA, b: placed.point, metres, spread, grade, worst }]);
    setPendingA(null);
    setNote(null);
  }

  function undoPoint() {
    if (pendingA) { setPendingA(null); return; }
    setSegments(list => list.slice(0, -1));
  }

  function undoCorner() {
    setCorners(list => list.slice(0, -1));
    setClosed(false);
    setNote(null);
  }

  function reset() {
    setCorners([]); setClosed(false); setCeiling(null); setNote(null);
    heading.current.reset();
    tiltTrack.current.reset();
    steady.current.reset();
    setSettled(false);
    setCompass({ verdict: 'unknown' });
  }

  /* ------------------------------------------------------------ photo -- */
  /* Reference → photo → four corners → perspective check → two ends →
     result, accepted wall by wall. A photo's scale holds only on the plane
     of its reference, so each wall is its own photo. */
  const [photo, setPhoto] = useState(null);           // { src, width, height }
  const [refId, setRefId] = useState(REFERENCE_RECTANGLES[0].id);
  const [customSize, setCustomSize] = useState({ width: '', height: '' });
  const [refCorners, setRefCorners] = useState([]);
  const [ends, setEnds] = useState([]);
  const [walls, setWalls] = useState([]);
  const [zoom, setZoom] = useState(1);
  const [pan, setPan] = useState({ x: 0, y: 0 });
  const drag = useRef(null);
  const imgRef = useRef(null);

  const reference = REFERENCE_RECTANGLES.find(r => r.id === refId);
  const refWidth = reference.width ?? Number(customSize.width) / 100;
  const refHeight = reference.height ?? Number(customSize.height) / 100;

  function grabFrame() {
    const video = videoRef.current;
    if (!video?.videoWidth) { setNote('The camera is not ready yet.'); return; }
    const canvas = document.createElement('canvas');
    canvas.width = video.videoWidth;
    canvas.height = video.videoHeight;
    canvas.getContext('2d').drawImage(video, 0, 0);
    setPhoto({ src: canvas.toDataURL('image/jpeg', 0.9), width: canvas.width, height: canvas.height });
    setRefCorners([]); setEnds([]); setZoom(1); setPan({ x: 0, y: 0 }); setNote(null);
  }

  /** Screen point to image pixels, through whatever zoom and pan are applied. */
  function toImage(event) {
    const rect = imgRef.current?.getBoundingClientRect();
    if (!rect || !photo) return null;
    return {
      x: ((event.clientX - rect.left) / rect.width) * photo.width,
      y: ((event.clientY - rect.top) / rect.height) * photo.height
    };
  }

  const marks = [...refCorners, ...ends];
  function onPhotoPointerDown(event) {
    const p = toImage(event);
    if (!p) return;
    event.currentTarget.setPointerCapture?.(event.pointerId);
    // Grabbing an existing mark moves it; a fingertip is not a precision cursor.
    const rect = imgRef.current.getBoundingClientRect();
    const pxPerImage = rect.width / photo.width;
    const hit = marks.findIndex(m => Math.hypot(m.x - p.x, m.y - p.y) * pxPerImage < 22);
    drag.current = { startX: event.clientX, startY: event.clientY, pan: { ...pan }, moved: false, mark: hit };
  }
  function onPhotoPointerMove(event) {
    const d = drag.current;
    if (!d) return;
    const dx = event.clientX - d.startX, dy = event.clientY - d.startY;
    if (Math.hypot(dx, dy) > 6) d.moved = true;
    if (!d.moved) return;
    if (d.mark >= 0) {
      const p = toImage(event);
      if (!p) return;
      if (d.mark < refCorners.length) setRefCorners(list => list.map((m, i) => (i === d.mark ? p : m)));
      else setEnds(list => list.map((m, i) => (i === d.mark - refCorners.length ? p : m)));
    } else if (zoom > 1) {
      setPan({ x: d.pan.x + dx, y: d.pan.y + dy });
    }
  }
  function onPhotoPointerUp(event) {
    const d = drag.current;
    drag.current = null;
    if (!d || d.moved) return;
    const p = toImage(event);
    if (!p) return;
    if (refCorners.length < 4) setRefCorners(list => [...list, p]);
    else if (ends.length < 2) setEnds(list => [...list, p]);
  }
  function undoMark() {
    if (ends.length) setEnds(list => list.slice(0, -1));
    else setRefCorners(list => list.slice(0, -1));
  }
  function resetMarks() { setRefCorners([]); setEnds([]); }

  const plane = useMemo(() => (refCorners.length === 4
    ? referencePlane({ corners: refCorners, width: refWidth, height: refHeight })
    : null), [refCorners, refWidth, refHeight]);
  const photoSpan = useMemo(() => (plane?.ok && ends.length === 2
    ? measureOnPlane(plane, ends[0], ends[1])
    : null), [plane, ends]);

  const photoRoom = useMemo(() => {
    if (walls.length < 3) return null;
    const r = roomDimensions(surfacesFromCorners(wallsToCorners(walls.map(w => w.metres)), { ceilingHeight: ceiling }), { minFloorArea: 0.5 });
    if (r) r.method = 'photo';
    return r;
  }, [walls, ceiling]);

  /* ------------------------------------------------------------ manual -- */
  const [unit, setUnit] = useState('m');
  const [typed, setTyped] = useState({ length: '', width: '', height: '' });
  const [confirmed, setConfirmed] = useState(false);
  const manual = useMemo(() => manualRoom(typed, unit, { confirmed }), [typed, unit, confirmed]);

  function changeUnit(next) {
    setTyped(fields => convertRoomFields(fields, unit, next));
    setUnit(next);
    setConfirmed(false);
  }

  const typedRoom = useMemo(() => {
    if (!manual.ready) return null;
    const { length: L, width: W, height: H } = manual.metres;
    const corners4 = [{ x: 0, z: 0 }, { x: L, z: 0 }, { x: L, z: W }, { x: 0, z: W }];
    const r = roomDimensions(surfacesFromCorners(corners4, { ceilingHeight: H > 0 ? H : null }), { minFloorArea: 0.1 });
    if (r) r.method = 'manual';
    return r;
  }, [manual]);

  const activeRoom = mode === 'aim' ? room : mode === 'photo' ? photoRoom : mode === 'manual' ? typedRoom : null;

  /* ------------------------------------------------------------ render -- */
  const aimTip = reading.events === 0
    ? (probe.needsPermission ? 'Allow motion access to aim.' : 'Waiting for the tilt sensor…')
    : rollBad
      ? 'Straighten the phone.'
      : shot.reason
        ? shot.reason
        : !settled
          ? 'Hold still…'
          : null;

  const methods = [
    {
      id: 'aim', title: 'Aim with phone',
      status: probe.events > 0
        ? (probe.rate >= AIM.minEventRate ? 'Motion sensor responding' : 'Motion sensor is slow on this phone')
        : probe.needsPermission ? 'Needs motion access' : probe.done ? 'No motion readings from this phone' : 'Checking…',
      usable: probe.events > 0 || probe.needsPermission,
      blurb: 'Aim at each corner where the floor meets the wall. The room outline needs a steady compass, which is checked as you go.'
    },
    {
      id: 'point', title: 'Aim: single distances',
      status: probe.events > 0 ? 'Motion sensor responding' : probe.needsPermission ? 'Needs motion access' : probe.done ? 'No motion readings' : 'Checking…',
      usable: probe.events > 0 || probe.needsPermission,
      blurb: 'Measure one span along the floor, such as a doorway or the space for a sofa.'
    },
    {
      id: 'photo', title: 'Photo reference',
      status: navigator.mediaDevices?.getUserMedia ? 'Needs the camera' : 'No camera access in this browser',
      usable: Boolean(navigator.mediaDevices?.getUserMedia),
      blurb: 'Photograph a wall with an A4 sheet, a card or a tile on it. One wall per photo.'
    },
    {
      id: 'manual', title: 'Tape measure', status: 'Most accurate', usable: true,
      blurb: 'Type in figures from a tape measure, in the unit you measured in.'
    }
  ];

  const surface = (
    <div className="ms-root" role="dialog" aria-modal="true" aria-label="Measure your room">
      <header className="ms-bar">
        {mode === 'choose'
          ? <h2 className="ms-title">How would you like to measure?</h2>
          : (
            <div className="ms-bar-left">
              <button type="button" className="ms-back" onClick={() => { setMode('choose'); setNote(null); }}>
                <span aria-hidden="true">‹</span> Methods
              </button>
              <span className="ms-method">{METHOD_NAME[mode]}</span>
            </div>
          )}
        <button type="button" className="ms-close" onClick={onClose} aria-label="Close measuring">×</button>
      </header>

      {/* ------------------------------------------------------ CHOOSER */}
      {mode === 'choose' && (
        <div className="ms-stage ms-stage-plain">
          <p className="ms-hint">
            This phone cannot run tracked AR here, or you chose not to. Each method
            below says what this phone was seen to support.
          </p>
          <ul className="ms-methods">
            {methods.map(m => (
              <li key={m.id}>
                <button type="button" className="ms-method-card" disabled={!m.usable}
                  onClick={() => { setMode(m.id); setNote(null); }}>
                  <span className="ms-method-title">{m.title}</span>
                  <span className="ms-method-status">{m.status}</span>
                  <span className="ms-method-blurb">{m.blurb}</span>
                </button>
              </li>
            ))}
          </ul>
          <p className="ms-hint ms-hint-small">
            Numbers keep the name of the method that produced them. A tape measure
            is still the most accurate of all.{' '}
            <a href="/diagnose">Check this phone</a>
          </p>
        </div>
      )}

      {/* ------------------------------------------- AIM: height, calibrate */}
      {(mode === 'aim' || mode === 'point') && !heightConfirmed && (
        <div className="ms-stage ms-stage-plain">
          <h2 className="ms-subhead">How high are you holding the phone?</h2>
          <p className="ms-hint">
            Every distance is this height multiplied by the tangent of the tilt
            angle, so it scales the whole room. Getting it roughly right matters
            more than any other setting here — measure it once with a tape and
            it never needs touching again.
          </p>
          <div className="ms-height-choices">
            {[['Chest height', 1.40], ['Waist height', 1.05], ['Eye level', 1.60]].map(([label, metres]) => (
              <button key={label} type="button"
                className={`ms-chip${Math.abs(eyeHeight - metres) < 0.005 ? ' is-on' : ''}`}
                onClick={() => setEyeHeight(metres)}>
                {label}<br /><small>{metres.toFixed(2)} m</small>
              </button>
            ))}
          </div>
          <label className="ms-height-row">
            Or set it exactly — {eyeHeight.toFixed(2)} m
            <input type="range" min="0.8" max="2" step="0.01" value={eyeHeight}
              onChange={e => setEyeHeight(Number(e.target.value))}
              aria-label="Height you are holding the phone at, in metres" />
          </label>
          <div className="ms-actions">
            <button type="button" className="button button-primary" onClick={() => setHeightConfirmed(true)}>
              Start measuring
            </button>
          </div>
        </div>
      )}

      {(mode === 'aim' || mode === 'point') && heightConfirmed && (
        <div className="ms-view" ref={viewRef}>
          <video ref={videoRef} className="ms-view-video" autoPlay playsInline muted />

          {calibration === null ? (
            /* Calibration: one step, this session only. Removes the constant
               offset this phone's sensors read at "upright"; never a scale. */
            <div className="ms-calibrate">
              <h2 className="ms-subhead">Hold the phone upright and level</h2>
              <p className="ms-hint">
                Stand it straight up, against a door frame or a wall if you can, then tap Calibrate.
                This corrects this phone&apos;s tilt sensor for this session.
              </p>
              <div className="ms-actions">
                <button type="button" className="button button-primary" onClick={runCalibration} disabled={calibrating || reading.events === 0}>
                  {calibrating ? 'Hold still…' : 'Calibrate'}
                </button>
                <button type="button" className="button" onClick={() => setCalibration({ ok: false, skipped: true })}>
                  Skip
                </button>
              </div>
              {note && <p className="ms-hint ms-warn" role="status">{note}</p>}
            </div>
          ) : (
            <>
              <svg className="ms-view-svg" width={view.w} height={view.h} aria-hidden="true">
                {(mode === 'aim' ? viewSegments : pointLines).map(seg => (
                  <line key={`s${seg.key}`} x1={seg.a.x} y1={seg.a.y} x2={seg.b.x} y2={seg.b.y}
                    stroke="#fff" strokeWidth="2.5" strokeLinecap="round"
                    strokeDasharray={seg.live ? '7 7' : undefined} opacity={seg.live ? 0.85 : 1} />
                ))}
                {(mode === 'aim' ? viewMarks : pointDots).filter(m => m.visible).map(m => (
                  <g key={`m${m.key}`}>
                    <circle cx={m.x} cy={m.y} r="8" fill="#fff" />
                    <circle cx={m.x} cy={m.y} r="3.5" fill="rgba(0,0,0,.55)" />
                  </g>
                ))}
                {aiming && (
                  <g>
                    <circle cx={view.w / 2} cy={view.h / 2} r="17" fill="none"
                      stroke={rollBad ? '#ffb020' : '#fff'} strokeWidth="2.5" opacity="0.95" />
                    <circle cx={view.w / 2} cy={view.h / 2} r="3" fill="#fff" />
                  </g>
                )}
                {(mode === 'aim' ? placedLabels : pointLines).map(seg => {
                  if (!seg.label) return null;
                  const w = seg.label.length * 8.2 + 20;
                  const mx = seg.mx ?? (seg.a.x + seg.b.x) / 2;
                  const my = seg.my ?? (seg.a.y + seg.b.y) / 2;
                  if (!Number.isFinite(mx) || !Number.isFinite(my)) return null;
                  return (
                    <g key={`t${seg.key}`}>
                      <rect x={mx - w / 2} y={my - 14} width={w} height={28} rx={14} fill="#fff" opacity={seg.live ? 0.9 : 1} />
                      <text x={mx} y={my + 5} textAnchor="middle" className="ms-view-label">{seg.label}</text>
                    </g>
                  );
                })}
              </svg>

              {/* One instruction, the most urgent. */}
              <p className={`ms-tip${aimTip && aimTip !== 'Hold still…' ? ' is-warn' : ''}`} role="status" aria-live="polite">
                {aimTip
                  ?? (mode === 'aim'
                    ? (compassKnown && !outlineAllowed
                      ? 'Compass is unstable. Move away from metal, or use Photo or Tape measure for the room.'
                      : corners.length === 0
                        ? 'Aim where the wall meets the floor, then tap +'
                        : closed
                          ? 'Outline closed. Aim up at the ceiling for the height.'
                          : `Corner ${corners.length} placed. Turn to the next one`)
                    : (pendingA ? 'Now aim at the other end and tap +' : 'Aim at one end of what you want measured, then tap +'))}
              </p>
              <p className="ms-toast" role="status" aria-live="polite" hidden={!note}>{note}</p>

              {aiming && !rollBad && (
                <p className="ms-distance">
                  <span>To the crosshair</span> {formatMeasurement(shot.distance, { spread: shot.spread }).text}
                </p>
              )}
              <p className="ms-anchor-warn">
                Measured from where you stand. Turn, don&apos;t walk.
                {calibration?.skipped ? ' Not calibrated.' : ''}
                {slowSensor ? ' The motion sensor is slow on this phone.' : ''}
              </p>

              <div className="ms-dock">
                {mode === 'aim' ? (
                  <>
                    <div className="ms-dock-row">
                      <button type="button" className="ms-chip" onClick={undoCorner} disabled={!corners.length}>Undo</button>
                      <button type="button" className="ms-add" onClick={addCorner}
                        disabled={!canCaptureAim || !outlineAllowed} aria-label="Place a corner here">
                        <span aria-hidden="true">+</span>
                      </button>
                      <button type="button" className="ms-chip" onClick={() => setClosed(true)} disabled={corners.length < 3 || closed}>Close</button>
                    </div>
                    <div className="ms-dock-row ms-dock-second">
                      <button type="button" className="ms-chip" onClick={setCeilingFromAim}>
                        {ceiling ? `Ceiling ${m2cm(ceiling)}` : 'Ceiling'}
                      </button>
                      <button type="button" className="ms-chip" onClick={() => setShowPlan(s => !s)}>{showPlan ? 'Hide plan' : 'Plan'}</button>
                      <button type="button" className="ms-chip" onClick={reset}>Reset</button>
                    </div>
                  </>
                ) : (
                  <div className="ms-dock-row">
                    <button type="button" className="ms-chip" onClick={undoPoint} disabled={!segments.length && !pendingA}>Undo</button>
                    <button type="button" className="ms-add" onClick={addPoint} disabled={!canCaptureAim}
                      aria-label={pendingA ? 'Place the far end' : 'Place the first end'}>
                      <span aria-hidden="true">+</span>
                    </button>
                    <button type="button" className="ms-chip" onClick={() => { setSegments([]); setPendingA(null); }} disabled={!segments.length}>Clear</button>
                  </div>
                )}
              </div>

              {mode === 'aim' && showPlan && (
                <div className="ms-plan-sheet">
                  <FloorPlan corners={corners} closed={closed} room={room} />
                  <label className="ms-height-row">
                    Holding height {eyeHeight.toFixed(2)} m
                    <input type="range" min="0.8" max="2" step="0.01" value={eyeHeight}
                      onChange={e => setEyeHeight(Number(e.target.value))}
                      aria-label="Height you are holding the phone at, in metres" />
                  </label>
                </div>
              )}

              {mode === 'point' && segments.length > 0 && (
                <div className="ms-tape">
                  {segments.map((seg, i) => {
                    const shown = formatMeasurement(seg.metres, { spread: seg.spread });
                    return (
                      <div className={`ms-tape-row is-${seg.grade}`} key={i} data-metres={seg.metres.toFixed(3)}>
                        <b>{shown.text}</b>
                        <small>{CONFIDENCE_COPY[seg.grade].label} · tilt + gyroscope{seg.grade !== 'high' && seg.worst ? ` · ${seg.worst}` : ''}</small>
                      </div>
                    );
                  })}
                </div>
              )}
            </>
          )}
        </div>
      )}

      {/* ---------------------------------------------------------- PHOTO */}
      {mode === 'photo' && (
        <div className="ms-stage">
          {!photo ? (
            <>
              <label className="ms-field">
                Reference in the photo
                <select value={refId} onChange={e => setRefId(e.target.value)}>
                  {REFERENCE_RECTANGLES.map(r => <option key={r.id} value={r.id}>{r.label}</option>)}
                </select>
              </label>
              {reference.width === null && (
                <div className="ms-field-row">
                  <label className="ms-field">Its width, cm
                    <input type="number" inputMode="decimal" min="1" value={customSize.width}
                      onChange={e => setCustomSize(c => ({ ...c, width: e.target.value }))} />
                  </label>
                  <label className="ms-field">Its height, cm
                    <input type="number" inputMode="decimal" min="1" value={customSize.height}
                      onChange={e => setCustomSize(c => ({ ...c, height: e.target.value }))} />
                  </label>
                </div>
              )}
              <div className="ms-cam">
                <video ref={videoRef} className="ms-video" autoPlay playsInline muted />
              </div>
              <p className="ms-hint">
                Put the reference flat on the wall you want to measure, get the whole wall
                in the frame, and stand as square to it as you can.
              </p>
              <div className="ms-actions">
                <button type="button" className="button button-primary" onClick={grabFrame}
                  disabled={!(refWidth > 0 && refHeight > 0)}>
                  Take the photo
                </button>
              </div>
            </>
          ) : (
            <>
              <p className="ms-hint" role="status" aria-live="polite">
                {refCorners.length < 4
                  ? `Tap the ${CORNER_NAMES[refCorners.length]} corner of the ${reference.id === 'custom' ? 'reference' : reference.label.split(' (')[0]}. Zoom in for precision; drag a dot to adjust it.`
                  : plane && !plane.ok
                    ? plane.reason
                    : ends.length < 2
                      ? `${plane?.note ? `${plane.note} ` : 'Perspective corrected. '}Now tap each end of what you want measured, on the same wall.`
                      : 'Drag either end to adjust it.'}
              </p>
              <div className="ms-photo-frame">
                <div className="ms-photo-pan"
                  style={{ transform: `translate(${pan.x}px, ${pan.y}px) scale(${zoom})` }}
                  onPointerDown={onPhotoPointerDown} onPointerMove={onPhotoPointerMove}
                  onPointerUp={onPhotoPointerUp} onPointerCancel={() => { drag.current = null; }}>
                  {/* eslint-disable-next-line @next/next/no-img-element */}
                  <img ref={imgRef} src={photo.src} alt="The wall being measured" className="ms-photo" draggable={false} />
                  <svg className="ms-overlay" viewBox={`0 0 ${photo.width} ${photo.height}`} preserveAspectRatio="none" aria-hidden="true">
                    {refCorners.length > 1 && (
                      <polygon points={refCorners.map(p => `${p.x},${p.y}`).join(' ')}
                        fill={refCorners.length === 4 ? 'rgba(123,107,217,.18)' : 'none'}
                        stroke="#7b6bd9" strokeWidth={photo.width / 300} />
                    )}
                    {ends.length === 2 && (
                      <line x1={ends[0].x} y1={ends[0].y} x2={ends[1].x} y2={ends[1].y} stroke="#f2c14e" strokeWidth={photo.width / 260} />
                    )}
                    {marks.map((m, i) => (
                      <circle key={i} cx={m.x} cy={m.y} r={photo.width / 90 / zoom}
                        fill="#1b1206" stroke={i < refCorners.length ? '#7b6bd9' : '#f2c14e'} strokeWidth={photo.width / 300 / zoom} />
                    ))}
                  </svg>
                </div>
              </div>
              <div className="ms-photo-tools">
                <button type="button" className="ms-chip" onClick={() => setZoom(z => Math.max(1, z / 1.5))} disabled={zoom <= 1} aria-label="Zoom out">−</button>
                <button type="button" className="ms-chip" onClick={() => setZoom(z => Math.min(6, z * 1.5))} aria-label="Zoom in">+</button>
                <button type="button" className="ms-chip" onClick={() => { setZoom(1); setPan({ x: 0, y: 0 }); }} disabled={zoom === 1}>Fit</button>
                <button type="button" className="ms-chip" onClick={undoMark} disabled={!marks.length}>Undo point</button>
                <button type="button" className="ms-chip" onClick={resetMarks} disabled={!marks.length}>Reset</button>
              </div>

              {photoSpan?.metres != null && (
                <div className={`ms-result is-${photoSpan.trust}`} role="status">
                  <b>{m2cm(photoSpan.metres)}</b>
                  <span>± {Math.max(1, Math.round(photoSpan.spread * 100))} cm</span>
                  <small>Photo reference · valid only on the wall the reference is on{photoSpan.reason ? ` · ${photoSpan.reason}` : ''}</small>
                </div>
              )}

              <div className="ms-actions">
                <button type="button" className="button button-primary" disabled={photoSpan?.metres == null}
                  onClick={() => { setWalls(w => [...w, { metres: photoSpan.metres, spread: photoSpan.spread }]); setPhoto(null); }}>
                  Accept this wall ({walls.length + 1})
                </button>
                <button type="button" className="button" onClick={() => setPhoto(null)}>Retake</button>
              </div>
            </>
          )}

          {walls.length > 0 && (
            <p className="ms-hint">
              Walls so far, in order: {walls.map(w => m2cm(w.metres)).join(' · ')}.
              A photo cannot see the angle between two walls, so they are joined at right angles.
            </p>
          )}
          {photoRoom && <FloorPlan corners={wallsToCorners(walls.map(w => w.metres))} closed room={photoRoom} />}
        </div>
      )}

      {/* --------------------------------------------------------- MANUAL */}
      {mode === 'manual' && (
        <div className="ms-stage ms-stage-plain">
          <p className="ms-hint">
            A tape measure beats every camera method on accuracy. Choose the unit you
            measured in; it applies to all three sizes.
          </p>
          <div className="ms-units" role="radiogroup" aria-label="Unit">
            {ROOM_UNITS.map(u => (
              <label key={u.id} className={`ms-unit${unit === u.id ? ' is-on' : ''}`}>
                <input type="radio" name="room-unit" value={u.id} checked={unit === u.id} onChange={() => changeUnit(u.id)} />
                <span>{u.short}</span>
              </label>
            ))}
          </div>
          <div className="ms-typed">
            {[['length', 'Length'], ['width', 'Width'], ['height', 'Height (optional)']].map(([key, label]) => {
              const problem = manual.problems[key];
              const metres = manual.metres[key];
              return (
                <label key={key} className={problem ? `has-${problem.level}` : ''}>
                  {label}, in {ROOM_UNITS.find(u => u.id === unit).label}
                  <input type="text" inputMode="decimal" autoComplete="off" value={typed[key]}
                    aria-invalid={problem?.level === 'error' ? 'true' : undefined}
                    aria-describedby={`typed-${key}-note`}
                    onChange={e => { setTyped(t => ({ ...t, [key]: e.target.value })); setConfirmed(false); }} />
                  <small id={`typed-${key}-note`} className="ms-typed-note">
                    {problem ? problem.message : Number.isFinite(metres) && unit !== 'm' ? `= ${formatRoomLength(metres, 'm')}` : ''}
                  </small>
                </label>
              );
            })}
          </div>
          {manual.suggestUnit && (
            <button type="button" className="button button-outline" onClick={() => {
              /* The digits stay, the unit changes: this is reading the same
                 typed numbers in the unit the person meant. */
              setUnit(manual.suggestUnit); setConfirmed(false);
            }}>
              Read these as {ROOM_UNITS.find(u => u.id === manual.suggestUnit).label}
            </button>
          )}
          {manual.confirmable && (
            <label className="ms-confirm">
              <input type="checkbox" checked={confirmed} onChange={e => setConfirmed(e.target.checked)} />
              These sizes are right
            </label>
          )}
          {typedRoom && (
            <FloorPlan
              corners={[
                { x: 0, z: 0 }, { x: manual.metres.length, z: 0 },
                { x: manual.metres.length, z: manual.metres.width }, { x: 0, z: manual.metres.width }
              ]}
              closed room={typedRoom} />
          )}
        </div>
      )}

      {cameraError && (mode === 'photo' || ((mode === 'aim' || mode === 'point') && heightConfirmed)) && (
        <p className="ms-note">{cameraError} Tape measure still works.</p>
      )}

      {mode !== 'choose' && mode !== 'point' && (
        <footer className="ms-foot">
          <div className="ms-summary">
            {activeRoom?.floorArea
              ? <>{fmt(Math.max(activeRoom.length, activeRoom.width), 'm')} × {fmt(Math.min(activeRoom.length, activeRoom.width), 'm')} · {fmt(activeRoom.floorArea, 'm²')}<small className="ms-summary-method">{METHOD_NAME[mode]}</small></>
              : mode === 'aim' && corners.length
                ? <>{corners.length} corner{corners.length === 1 ? '' : 's'} — close the outline to finish</>
                : mode === 'photo' && walls.length
                  ? <>{walls.length} wall{walls.length === 1 ? '' : 's'} — at least 3 for a room</>
                  : <>Nothing measured yet</>}
          </div>
          <button type="button" className="button button-primary" disabled={!activeRoom?.floorArea}
            onClick={() => onUseRoom?.(activeRoom)}>
            Use this room
          </button>
        </footer>
      )}
    </div>
  );

  return typeof document === 'undefined' ? null : createPortal(surface, document.body);
}
