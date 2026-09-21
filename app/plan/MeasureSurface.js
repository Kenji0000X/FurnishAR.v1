'use client';

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import {
  distanceFromTilt, heightFromTilt, floorPointFromAim, bearingDelta,
  surfacesFromCorners, cornerReadiness, MAX_TILT_DEGREES
} from '../../lib/spatial/clinometer.mjs';
import {
  KNOWN_OBJECTS, scaleFromReference, measure, squareness, wallsToCorners
} from '../../lib/spatial/photo-scale.mjs';
import { roomDimensions } from '../../lib/spatial/room.mjs';

/**
 * Measuring a room on a phone that cannot run AR.
 *
 * ARCore is not available on every Android, and where it is missing there is
 * no WebXR AR and no native fallback either — a native app would sit on the
 * same ARCore. This surface is what is left, and all three of its modes are
 * real measurement rather than AR theatre:
 *
 *   Aim    Live. The tilt sensor plus a height you type gives the distance to
 *          the floor point under the crosshair, updating every frame. Turn on
 *          the spot and tap each corner; the outline builds as you go.
 *   Photo  Freeze a frame, mark something of known size, then measure along
 *          that same plane. One wall per photo.
 *   Type   A tape measure and the keypad. The most accurate of the three and
 *          presented as such, not as the booby prize.
 *
 * All three end in the same place: a corner list, through surfacesFromCorners
 * into roomDimensions — the very function the AR path uses — so the fit
 * check, the placement rules and the results panel work unchanged.
 *
 * The look is lifted from the measuring apps this was asked to resemble
 * (ARuler, Apple's Measure): gold pills on the edges carrying lengths, violet
 * pills stacked in the middle carrying the derived H / S / P / V, a thin gold
 * wireframe with round vertex dots, and a dotted reticle while aiming.
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

export default function MeasureSurface({ onUseRoom, onClose }) {
  const [mode, setMode] = useState('aim');
  const [eyeHeight, setEyeHeight] = useState(1.4);
  const [corners, setCorners] = useState([]);
  const [closed, setClosed] = useState(false);
  const [ceiling, setCeiling] = useState(null);
  const [note, setNote] = useState(null);

  /* Live sensor state. Kept in a ref as well as in state: the ref is what the
     tap handler reads, so a corner is placed from the angle at the instant of
     the tap rather than from whatever React last rendered. */
  const live = useRef({ tilt: null, bearing: null, events: 0 });
  const [reading, setReading] = useState({ tilt: null, bearing: null, events: 0 });
  const baseBearing = useRef(null);

  const videoRef = useRef(null);
  const streamRef = useRef(null);
  const [cameraError, setCameraError] = useState(null);

  /* The page behind must not scroll under the overlay: on a phone a stray
     drag scrolls the planner instead of the tool, and the tool comes back
     somewhere other than where it was left. */
  useEffect(() => {
    const previous = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
    return () => { document.body.style.overflow = previous; };
  }, []);

  /* ------------------------------------------------------------ camera -- */
  useEffect(() => {
    if (mode === 'type') return undefined;
    let dead = false;
    navigator.mediaDevices?.getUserMedia({ video: { facingMode: { ideal: 'environment' } }, audio: false })
      .then(stream => {
        if (dead) { stream.getTracks().forEach(t => t.stop()); return; }
        streamRef.current = stream;
        if (videoRef.current) videoRef.current.srcObject = stream;
      })
      .catch(err => setCameraError(`${err?.name}: ${err?.message}`));
    return () => {
      dead = true;
      streamRef.current?.getTracks().forEach(t => t.stop());
      streamRef.current = null;
    };
  }, [mode]);

  /* ------------------------------------------------------- tilt sensor -- */
  const startSensor = useCallback(async () => {
    try {
      const gate = window.DeviceOrientationEvent?.requestPermission;
      if (typeof gate === 'function') {
        const granted = await gate.call(window.DeviceOrientationEvent);
        if (granted !== 'granted') { setNote('Motion access was refused, so aiming cannot work. Try the Photo or Type mode.'); return; }
      }
    } catch { /* Android has no gate */ }

    const onOrient = e => {
      if (typeof e.beta !== 'number' || e.beta === null) return;
      /*
         beta is the tilt from flat-and-face-up, which is already the angle
         from straight DOWN that the trigonometry wants: 0 is the rear camera
         pointing at the floor beneath you, 90 is pointing at the horizon.
      */
      const tilt = e.beta;
      const alpha = typeof e.alpha === 'number' ? e.alpha : null;
      if (baseBearing.current === null && alpha !== null) baseBearing.current = alpha;
      /* Only the bearing RELATIVE to the first reading is used. An indoor
         magnetometer drifts, but a drift common to every corner rotates the
         whole room, which changes no dimension of it. */
      const bearing = alpha === null ? null
        : bearingDelta(baseBearing.current, alpha);
      live.current = { tilt, bearing, events: live.current.events + 1 };
      setReading(live.current);
    };
    window.addEventListener('deviceorientation', onOrient);
    return () => window.removeEventListener('deviceorientation', onOrient);
  }, []);

  useEffect(() => {
    if (mode !== 'aim') return undefined;
    let off = null;
    startSensor().then(fn => { off = fn; });
    return () => { if (off) off(); };
  }, [mode, startSensor]);

  /* --------------------------------------------------------- live shot -- */
  const shot = useMemo(
    () => distanceFromTilt({ eyeHeight, tiltDegrees: reading.tilt }),
    [eyeHeight, reading.tilt]
  );

  const room = useMemo(() => {
    if (corners.length < 3 || !closed) return null;
    return roomDimensions(surfacesFromCorners(corners, { ceilingHeight: ceiling }), { minFloorArea: 0.5 });
  }, [corners, closed, ceiling]);

  const readiness = cornerReadiness(corners, { closed });

  /* ------------------------------------------------------------- taps -- */
  function addCorner() {
    const now = live.current;
    const placed = floorPointFromAim({
      eyeHeight, tiltDegrees: now.tilt, bearingDegrees: now.bearing
    });
    if (!placed.point) { setNote(placed.reason); return; }
    setNote(placed.trust === 'coarse' ? placed.reason : null);
    setCorners(list => [...list, { ...placed.point, spread: placed.spread, trust: placed.trust }]);
    setClosed(false);
  }

  function setCeilingFromAim() {
    const now = live.current;
    if (!corners.length) { setNote('Measure at least one corner first — the ceiling needs a distance to work from.'); return; }
    // Aimed UP: beta above 90 is a rise above the horizon.
    const rise = (now.tilt ?? 0) - 90;
    if (rise <= 2) { setNote('Aim up at the line where the wall meets the ceiling.'); return; }
    const last = corners[corners.length - 1];
    const distance = Math.hypot(last.x, last.z);
    const h = heightFromTilt({ distance, riseDegrees: rise, eyeHeight });
    if (h.height == null) { setNote(h.reason); return; }
    setCeiling(h.height);
    setNote(`Ceiling ${m2cm(h.height)}, give or take ${Math.round(h.spread * 100)} cm.`);
  }

  function reset() {
    setCorners([]); setClosed(false); setCeiling(null); setNote(null);
    baseBearing.current = null;
  }

  /* ------------------------------------------------------------ photo -- */
  const [photo, setPhoto] = useState(null);
  const [marks, setMarks] = useState([]);
  const [refObject, setRefObject] = useState(KNOWN_OBJECTS[0]);
  const [customMetres, setCustomMetres] = useState(1);
  const [walls, setWalls] = useState([]);
  const canvasRef = useRef(null);

  function grabFrame() {
    const video = videoRef.current;
    if (!video?.videoWidth) { setNote('The camera is not ready yet.'); return; }
    const canvas = document.createElement('canvas');
    canvas.width = video.videoWidth;
    canvas.height = video.videoHeight;
    canvas.getContext('2d').drawImage(video, 0, 0);
    setPhoto(canvas.toDataURL('image/jpeg', 0.85));
    setMarks([]);
  }

  function markAt(event) {
    const box = event.currentTarget.getBoundingClientRect();
    const point = {
      x: ((event.clientX - box.left) / box.width) * 1000,
      y: ((event.clientY - box.top) / box.height) * 1000
    };
    setMarks(list => (list.length >= 4 ? [point] : [...list, point]));
  }

  const refMetres = refObject.metres ?? (Number(customMetres) || 0);
  const photoScale = marks.length >= 2
    ? scaleFromReference({ a: marks[0], b: marks[1], realMetres: refMetres })
    : { metresPerPixel: null, reason: 'Drag along the reference object: tap each end of it.' };
  const photoSpan = marks.length >= 4
    ? measure({
        a: marks[2], b: marks[3],
        metresPerPixel: photoScale.metresPerPixel,
        referencePixels: photoScale.pixels
      })
    : { metres: null };

  const photoRoom = useMemo(() => {
    if (walls.length < 3) return null;
    return roomDimensions(surfacesFromCorners(wallsToCorners(walls), { ceilingHeight: ceiling }), { minFloorArea: 0.5 });
  }, [walls, ceiling]);

  /* ------------------------------------------------------------- type -- */
  const [typed, setTyped] = useState({ length: '', width: '', height: '' });
  const typedRoom = useMemo(() => {
    const L = Number(typed.length), W = Number(typed.width), H = Number(typed.height);
    if (!(L > 0 && W > 0)) return null;
    const corners4 = [
      { x: 0, z: 0 }, { x: L, z: 0 }, { x: L, z: W }, { x: 0, z: W }
    ];
    return roomDimensions(surfacesFromCorners(corners4, { ceilingHeight: H > 0 ? H : null }), { minFloorArea: 0.5 });
  }, [typed]);

  const activeRoom = mode === 'aim' ? room : mode === 'photo' ? photoRoom : typedRoom;

  /* ------------------------------------------------------------ render -- */
  /*
     Rendered into <body> rather than in place.

     .planner-view carries a transform, and a transformed ancestor becomes the
     containing block for position: fixed — so this overlay was laid out
     against the planner section instead of the viewport, came out 2258 px
     tall starting 780 px above the top of the screen, and let the site header
     and the bottom bar show straight through it. No z-index fixes that,
     because the problem is the containing block, not the stacking order.
     A portal takes it out of the transformed subtree entirely.
  */
  const surface = (
    <div className="ms-root" role="dialog" aria-modal="true" aria-label="Measure your room">
      <header className="ms-bar">
        <div className="ms-modes" role="tablist" aria-label="How to measure">
          {[
            ['aim', 'Aim'],
            ['photo', 'Photo'],
            ['type', 'Type']
          ].map(([id, label]) => (
            <button key={id} type="button" role="tab" aria-selected={mode === id}
              className={`ms-mode${mode === id ? ' is-on' : ''}`}
              onClick={() => { setMode(id); setNote(null); }}>
              {label}
            </button>
          ))}
        </div>
        <button type="button" className="ms-close" onClick={onClose} aria-label="Close measuring">×</button>
      </header>

      {/* ------------------------------------------------------------ AIM */}
      {mode === 'aim' && (
        <div className="ms-stage">
          {/* The reticle is absolutely positioned, so it needs a positioned
              parent. Without one it resolved against the page and smeared
              gold streaks the length of the document. */}
          <div className="ms-cam">
            <video ref={videoRef} className="ms-video" autoPlay playsInline muted />
            <svg className="ms-overlay" viewBox="0 0 100 100" aria-hidden="true">
              <circle cx="50" cy="50" r="9" fill="none" stroke={GOLD} strokeWidth="1.2"
                strokeDasharray="4 4" />
              <circle cx="50" cy="50" r="1.6" fill={GOLD} />
            </svg>

            {/* Over the picture, like the app this copies: the number belongs
                next to the thing being aimed at, not in a panel below it. */}
            <div className={`ms-live is-${shot.trust}`}>
              {shot.distance != null ? (
                <>
                  <b>{m2cm(shot.distance)}</b>
                  <span>± {Math.round(shot.spread * 100)} cm</span>
                </>
              ) : (
                <b className="ms-live-none">{reading.events === 0 ? 'Waiting for the tilt sensor…' : '—'}</b>
              )}
              <small>
                {reading.tilt == null ? 'No tilt reading' : `tilt ${reading.tilt.toFixed(0)}° · max ${MAX_TILT_DEGREES}°`}
              </small>
            </div>
          </div>


          {shot.reason && <p className="ms-hint">{shot.reason}</p>}
          {note && <p className="ms-note">{note}</p>}

          <div className="ms-actions">
            <button type="button" className="button button-primary" onClick={addCorner}
              disabled={shot.distance == null}>
              Tap corner ({corners.length})
            </button>
            <button type="button" className="button" onClick={() => setClosed(true)}
              disabled={corners.length < 3 || closed}>
              Close outline
            </button>
            <button type="button" className="button" onClick={setCeilingFromAim}>
              {ceiling ? `Ceiling ${m2cm(ceiling)}` : 'Aim up: ceiling'}
            </button>
            <button type="button" className="button" onClick={reset}>Start over</button>
          </div>

          <FloorPlan corners={corners} closed={closed} room={room} />

          {!readiness.ready && (
            <p className="ms-hint">Still needed: {readiness.blocking.join(', ')}.</p>
          )}

          <details className="ms-setup">
            <summary>Holding height — {eyeHeight.toFixed(2)} m</summary>
            <p>
              Every distance is this height times the tangent of the tilt angle,
              so a wrong height scales the whole room by the same proportion.
              Measure it once with a tape and it never needs touching again.
            </p>
            <input type="range" min="0.8" max="2" step="0.01" value={eyeHeight}
              onChange={e => setEyeHeight(Number(e.target.value))}
              aria-label="Height you are holding the phone at, in metres" />
          </details>
        </div>
      )}

      {/* ---------------------------------------------------------- PHOTO */}
      {mode === 'photo' && (
        <div className="ms-stage">
          {!photo ? (
            <>
              <div className="ms-cam">
                <video ref={videoRef} className="ms-video" autoPlay playsInline muted />
              </div>
              <p className="ms-hint">
                Put something you know the size of flat against the wall — a sheet
                of A4, a bank card, a floor tile — and stand square on to it.
              </p>
              <div className="ms-actions">
                <button type="button" className="button button-primary" onClick={grabFrame}>
                  Take the photo
                </button>
              </div>
            </>
          ) : (
            <>
              <div className="ms-photo-wrap" onClick={markAt}>
                {/* eslint-disable-next-line @next/next/no-img-element */}
                <img src={photo} alt="The wall you are measuring" className="ms-photo" />
                <svg className="ms-overlay" viewBox="0 0 1000 1000" preserveAspectRatio="none">
                  {marks.length >= 2 && (
                    <line x1={marks[0].x} y1={marks[0].y} x2={marks[1].x} y2={marks[1].y}
                      stroke={VIOLET} strokeWidth="4" />
                  )}
                  {marks.length >= 4 && (
                    <line x1={marks[2].x} y1={marks[2].y} x2={marks[3].x} y2={marks[3].y}
                      stroke={GOLD} strokeWidth="4" />
                  )}
                  {marks.map((m, i) => (
                    <circle key={i} cx={m.x} cy={m.y} r="9"
                      fill="#1b1206" stroke={i < 2 ? VIOLET : GOLD} strokeWidth="4" />
                  ))}
                </svg>
              </div>

              <div className="ms-photo-controls">
                <label>
                  The thing I marked first is
                  <select value={refObject.id}
                    onChange={e => setRefObject(KNOWN_OBJECTS.find(o => o.id === e.target.value))}>
                    {KNOWN_OBJECTS.map(o => <option key={o.id} value={o.id}>{o.label}</option>)}
                  </select>
                </label>
                {refObject.metres === null && (
                  <label>
                    …and it is this many metres
                    <input type="number" step="0.001" min="0.01" value={customMetres}
                      onChange={e => setCustomMetres(e.target.value)} />
                  </label>
                )}
              </div>

              <p className="ms-hint">
                {marks.length < 2
                  ? 'Tap each end of the reference object.'
                  : marks.length < 4
                    ? 'Now tap each end of the wall you want measured.'
                    : photoScale.reason || 'Tap again to start a new pair.'}
              </p>

              {photoSpan.metres != null && (
                <div className={`ms-live is-${photoSpan.trust}`}>
                  <b>{m2cm(photoSpan.metres)}</b>
                  <span>± {Math.round(photoSpan.spread * 100)} cm</span>
                  <small>only valid in {photoScale.validIn}</small>
                </div>
              )}

              <div className="ms-actions">
                <button type="button" className="button button-primary"
                  disabled={photoSpan.metres == null}
                  onClick={() => { setWalls(w => [...w, photoSpan.metres]); setPhoto(null); }}>
                  Add this wall ({walls.length})
                </button>
                <button type="button" className="button" onClick={() => setPhoto(null)}>
                  Retake
                </button>
              </div>

              {walls.length > 0 && (
                <p className="ms-hint">
                  Walls so far: {walls.map(w => m2cm(w)).join(' · ')}.
                  A photo cannot see the angle between two walls, so these are
                  assembled as right angles.
                </p>
              )}
            </>
          )}

          {photoRoom && <FloorPlan corners={wallsToCorners(walls)} closed room={photoRoom} />}
        </div>
      )}

      {/* ----------------------------------------------------------- TYPE */}
      {mode === 'type' && (
        <div className="ms-stage ms-stage-plain">
          <p className="ms-hint">
            A tape measure beats both camera methods on accuracy, so this is not
            the fallback — it is the most reliable option on the screen. Use it
            when you have a tape, or to correct a number the camera got wrong.
          </p>
          <div className="ms-typed">
            {[['length', 'Length'], ['width', 'Width'], ['height', 'Height (optional)']].map(([key, label]) => (
              <label key={key}>
                {label}, in metres
                <input type="number" step="0.01" min="0" inputMode="decimal"
                  value={typed[key]}
                  onChange={e => setTyped(t => ({ ...t, [key]: e.target.value }))} />
              </label>
            ))}
          </div>
          {typedRoom && (
            <FloorPlan
              corners={[
                { x: 0, z: 0 }, { x: Number(typed.length), z: 0 },
                { x: Number(typed.length), z: Number(typed.width) }, { x: 0, z: Number(typed.width) }
              ]}
              closed room={typedRoom} />
          )}
        </div>
      )}

      {cameraError && mode !== 'type' && (
        <p className="ms-note">The camera would not open — {cameraError}. The Type tab still works.</p>
      )}

      <footer className="ms-foot">
        <div className="ms-summary">
          {activeRoom?.floorArea
            ? <>{fmt(Math.max(activeRoom.length, activeRoom.width), 'm')} × {fmt(Math.min(activeRoom.length, activeRoom.width), 'm')} · {fmt(activeRoom.floorArea, 'm²')}</>
            : <>Nothing measured yet</>}
        </div>
        <button type="button" className="button button-primary"
          disabled={!activeRoom?.floorArea}
          onClick={() => onUseRoom?.(activeRoom)}>
          Use this room
        </button>
      </footer>
    </div>
  );

  // document.body does not exist while this is server-rendered.
  return typeof document === 'undefined' ? null : createPortal(surface, document.body);
}
