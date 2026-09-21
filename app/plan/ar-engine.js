/**
 * The AR and measurement engine.
 *
 * This is the WebXR/three.js code from the vanilla build, MOVED rather than
 * rewritten. It is imperative, owns a WebGL canvas and a DOM subtree it builds
 * itself, and runs a frame loop -- none of which React improves. Reactifying it
 * would risk a working AR experience for no gain, so it keeps its own state
 * object and its own `document.querySelector` calls, and the planner page
 * renders the same element IDs it has always looked for.
 *
 * The only changes made while moving it:
 *   - three.js is an npm dependency now, not a CDN import map.
 *   - `changeView` and the build stamp are gone: views are routes, and the
 *     footer is rendered on the server.
 *   - it is wrapped in `createPlanner`, so mounting and unmounting are
 *     explicit and a React effect can tear it down.
 *
 * Everything else is byte-for-byte what shipped and was tested.
 */
'use client';

import { resolveScale } from '../../lib/spatial/model-scale.mjs';
import { OneEuroFilter, Steadiness, displayPrecision } from '../../lib/spatial/smoothing.mjs';
import { roomDimensions, fitInRoom, minimumAreaRectangle } from '../../lib/spatial/room.mjs';
import { SweepCoverage, scanReadiness } from '../../lib/spatial/coverage.mjs';
import { assessPlacement, snapInsideRoom } from '../../lib/spatial/placement.mjs';
import { createXrayNet } from './xray-net.js';

/**
 * Wires the planner up to the DOM the page has already rendered.
 *
 * @param {object}   options
 * @param {Array}    options.products   the catalogue, server-rendered upstream
 * @param {string?}  options.selectedId  the piece to start on, from ?product=
 * @param {boolean}  options.autoStart   open AR immediately (from ?ar=1)
 * @returns {Promise<() => void>} a teardown function for React to call
 */
export async function createPlanner({ products = [], selectedId = null, autoStart = false } = {}) {

  /* ===== THREE loading, escaping helpers ===== */
  let THREE = null;
  let GLTFLoader = null;
  let dracoLoader = null;      // set by loadThreeJS; decodes Draco geometry
  let meshoptDecoder = null;   // set by loadThreeJS; decodes meshopt geometry

  async function loadThreeJS() {
    if (THREE) return;
    try {
      THREE = await import('three');
      const { GLTFLoader: Loader } = await import('three/examples/jsm/loaders/GLTFLoader.js');
      GLTFLoader = Loader;

      // Decoders for compressed geometry, loaded alongside the loader.
      //
      // A plain GLTFLoader reads only uncompressed glTF, and refuses a
      // Draco or meshopt file outright — "no DRACOLoader instance provided".
      // That matters because compression is how a model gets under the upload
      // limit at all: a 60 MB export routinely becomes single digits, and
      // without these the owner's reward for doing the right thing would be a
      // file that no longer loads. Every shopper who opens it downloads the
      // smaller file too, on a phone, which is the whole point.
      try {
        const { DRACOLoader } = await import('three/examples/jsm/loaders/DRACOLoader.js');
        const { MeshoptDecoder: Meshopt } = await import('three/examples/jsm/libs/meshopt_decoder.module.js');
        // Self-hosted under /draco/, not a CDN: the decoder is ~750 KB and is
        // fetched only when a compressed model is actually opened.
        dracoLoader = new DRACOLoader().setDecoderPath('/draco/');
        meshoptDecoder = Meshopt;
      } catch (decoderError) {
        // An uncompressed model still loads without these, so this is not
        // fatal — but a compressed one will not, and that is worth saying.
        console.warn('[AR] compressed-model decoders unavailable:', decoderError?.message);
        dracoLoader = null;
        meshoptDecoder = null;
      }
      return true;
    } catch (error) {
      console.error('[AR] THREE.js unavailable:', error?.message);
      THREE = null;
      GLTFLoader = null;
      return false;
    }
  }

  // Escape HTML special characters to prevent XSS
  function escapeHtml(text) {
    if (typeof text !== 'string') return '';
    const div = document.createElement('div');
    div.textContent = text;
    return div.innerHTML;
  }

  // Format a timestamp as relative time ("3 days ago")
  function relativeTime(isoString) {
    if (!isoString) return '';
    const now = new Date();
    const then = new Date(isoString);
    const seconds = Math.floor((now - then) / 1000);
    const minutes = Math.floor(seconds / 60);
    const hours = Math.floor(minutes / 60);
    const days = Math.floor(hours / 24);
    const rtf = new Intl.RelativeTimeFormat('en', { numeric: 'auto' });
    if (days > 0) return rtf.format(-days, 'day');
    if (hours > 0) return rtf.format(-hours, 'hour');
    if (minutes > 0) return rtf.format(-minutes, 'minute');
    return rtf.format(-Math.max(0, seconds), 'second');
  }


  /* The live reading's stabiliser and its steadiness window. One per planner
     instance, reset between measurements rather than shared globally. */
  const liveFilter = new OneEuroFilter();
  const liveSteadiness = new Steadiness(30);
  let liveSeries = null;   // which quantity the filter is currently tracking

  /* The room scan. Coverage is the 180-degree sweep; `room` is the latest
     derivation from whatever surfaces have been detected so far. */
  const sweep = new SweepCoverage();
  let xrayNet = null;

  /* ===== Planner state and DOM helpers ===== */
  const state = {
    products: [],
    stores: {},
    selected: null,
    filters: { search: '', category: '', store: '', width: 240, color: '' },
    session: null,
    hitTestSource: null,
    referenceSpace: null,
    latestHitPose: null,
    placedMatrix: null,
    arPurpose: null,
    arPoints: [],
    arMeasurement: null,
    arConfirmationMeasurement: null,
    arNeedsConfirmation: false,
    cameraStream: null,
    token: (typeof sessionStorage !== 'undefined' ? sessionStorage.getItem('furnishar-token') : null) || '',
    user: JSON.parse((typeof sessionStorage !== 'undefined' ? sessionStorage.getItem('furnishar-user') : null) || 'null'),
    loadedModel: null,
    modelBounds: null,
    xrRenderer: null,
    xrScene: null,
    xrCamera: null,
    xrLight: null,
    arMode: null,
    placementConfirmed: false,
    viewerYaw: 0,
    ownProducts: [],
    measureMode: 'room',
    // The unit every length is shown in. Changed in Scan settings.
    units: 'm',
    // The room scan. `room` is null until a floor is found; `netSupport`
    // records what this device actually granted, so the UI can say which
    // layers are live instead of implying all of them.
    room: null,
    // The room the person accepted, which outlives the AR session that
    // produced it. `room` is the live derivation; this is the kept one.
    scannedRoom: null,
    // Pieces already standing in the scanned room, for collision checks.
    placedPieces: [],
    detectedSurfaces: [],
    netSupport: { planes: false, depth: false },
    scanReadiness: null,
    areaPoints: [],
    membership: null,
    unsubscribeCatalog: null
  };

  const $ = (selector, parent = document) => parent.querySelector(selector);
  const $$ = (selector, parent = document) => [...parent.querySelectorAll(selector)];
  const peso = value => new Intl.NumberFormat('en-PH', { style: 'currency', currency: 'PHP', maximumFractionDigits: 0 }).format(value);
  const cm = value => `${Math.round(value)} cm`;

  const AR_EXPERIENCE_HTML = `<div id="ar-experience" class="ar-layer">
    <video id="camera-feed" autoplay playsinline muted></video>
    <canvas id="xr-canvas"></canvas>
    <div id="fallback-product" class="ar-stage"></div>
    <div id="ar-reticle" class="ar-reticle" aria-hidden="true"><span></span></div>
    <div id="ar-anchor-chip" class="ar-anchor-chip glass" hidden><b id="anchor-primary"></b><i id="anchor-secondary"></i></div>
    <header class="ar-bar">
      <div class="ar-title glass">
        <strong id="ar-product-name"></strong>
        <span id="ar-product-dims"></span>
      </div>
      <span id="ar-mode-indicator" class="ar-chip glass" aria-label="Tracking mode"></span>
      <button id="exit-ar" class="ar-chip glass ar-chip-button" aria-label="Close AR view">Close</button>
    </header>
    <div id="live-measurement" class="ar-measure glass" hidden>
      <b id="live-m">0.00 m</b>
      <span><i id="live-cm">0 cm</i><i id="live-mm">0 mm</i></span>
      <em id="live-caption"></em>
    </div>

    <!-- Where the piece being placed stands in the scanned room. Hidden
         entirely until a room has been measured — there is nothing to be
         inside of before that. -->
    <div id="placement-verdict" class="placement-verdict glass" hidden role="status" aria-live="polite">
      <b id="placement-word"></b>
      <span id="placement-detail"></span>
    </div>

    <!-- Dimension labels pinned to each detected surface. Built and positioned
         by the scan loop; empty, and silent to a screen reader, until a
         surface has actually been measured. -->
    <div id="surface-labels" class="surface-labels" aria-hidden="true"></div>

    <!-- The guided room scan. Everything in here reports something the device
         has actually determined; rows the device cannot do say so. -->
    <section id="scan-panel" class="scan-panel glass" hidden aria-labelledby="scan-panel-title">
      <header>
        <h2 id="scan-panel-title">Room scan</h2>
        <span id="scan-tracking" class="scan-tracking" data-state="acquiring">Acquiring</span>
      </header>

      <!-- The 180-degree sweep. The arc is drawn as ticks so progress is
           legible without relying on colour alone. -->
      <div class="scan-sweep">
        <div id="scan-arc" class="scan-arc" role="img" aria-label="Sweep coverage"></div>
        <p id="scan-guidance" class="scan-guidance">Point the camera at the floor to begin.</p>
      </div>

      <dl class="scan-found">
        <div><dt>Floor</dt><dd id="found-floor">—</dd></div>
        <div><dt>Walls</dt><dd id="found-walls">—</dd></div>
        <div><dt>Height</dt><dd id="found-height">—</dd></div>
        <div><dt>Sweep</dt><dd id="found-sweep">0°</dd></div>
      </dl>

      <div class="scan-dimensions" aria-live="polite">
        <p><span>Length</span><b id="room-length">—</b></p>
        <p><span>Width</span><b id="room-width">—</b></p>
        <p><span>Height</span><b id="room-height">—</b></p>
        <p><span>Perimeter</span><b id="room-perimeter">—</b></p>
      </div>

      <!-- Volume, surface and perimeter, the way a room scanner states them.
           The letters are conventional (V, S, P) and each is spelled out for
           a screen reader, which cannot infer "volume" from a V. -->
      <ul class="scan-totals" aria-label="Room totals">
        <li><abbr title="Volume">V</abbr><b id="room-volume">—</b></li>
        <li><abbr title="Surface, the floor area">S</abbr><b id="room-area">—</b></li>
        <li><abbr title="Perimeter">P</abbr><b id="room-p">—</b></li>
      </ul>

      <p id="scan-note" class="scan-note"></p>
      <button id="use-room" class="ar-outline-button glass" disabled>Use this room</button>
    </section>
    <div class="ar-dock">
    <p id="ar-mode-label" class="ar-hint glass"></p>
    <!-- Finishing a two-point or floor-area measurement had no control of its
         own: the only way out was "Close" in the top-right corner, which is
         both the hardest place on the screen to reach one-handed and a word
         that sounds like discarding the reading rather than keeping it. The
         number was in fact already saved, so the button confirms what has
         happened rather than performing it. -->
    <button id="use-measurement" class="ar-outline-button glass" hidden disabled>Use this measurement</button>
    <button id="close-outline" class="ar-outline-button glass" hidden>Close outline</button>
    <div id="ar-tray" class="ar-tray glass" role="group" aria-label="Model controls">
      <div class="tray-cluster" data-cluster="move">
        <span class="tray-label">Move</span>
        <div class="tray-pad">
          <button class="tray-btn" data-step="move" data-axis="z" data-dir="-1" aria-label="Move away">↑</button>
          <button class="tray-btn" data-step="move" data-axis="x" data-dir="-1" aria-label="Move left">←</button>
          <button class="tray-btn" data-step="move" data-axis="z" data-dir="1" aria-label="Move closer">↓</button>
          <button class="tray-btn" data-step="move" data-axis="x" data-dir="1" aria-label="Move right">→</button>
        </div>
      </div>
      <div class="tray-cluster" data-cluster="rotate">
        <span class="tray-label">Rotate <i id="yaw-value">0°</i></span>
        <div class="tray-row">
          <button class="tray-btn" data-step="rotate" data-dir="-1" aria-label="Rotate left">↺</button>
          <button class="tray-btn tray-toggle" id="spin-toggle" aria-pressed="false" aria-label="Spin 360 degrees">360°</button>
          <button class="tray-btn" data-step="rotate" data-dir="1" aria-label="Rotate right">↻</button>
        </div>
      </div>
      <!-- There is no scale control, deliberately. See arTransform.resize. -->
      <div class="tray-cluster" data-cluster="view">
        <span class="tray-label">View</span>
        <div class="tray-row">
          <button class="tray-btn tray-wide" id="toggle-occlusion" aria-pressed="true"
            aria-label="Hide furniture behind real walls">Occlusion</button>
          <button class="tray-btn tray-wide" id="reset-model" aria-label="Reset model">Reset</button>
        </div>
      </div>
      <button id="place-button" class="ar-place" aria-label="Confirm placement" disabled><span></span></button>
    </div>
    </div>
  </div>`;

  /* Shared model transform. Both the WebXR path and the camera preview read from
     this, so the tray drives the model identically in either mode. */
  const arTransform = {
    x: 0, z: 0, yaw: 0, scale: 1, spinning: false,
    reset() { this.x = 0; this.z = 0; this.yaw = 0; this.scale = 1; this.spinning = false; syncTrayReadout(); },
    move(axis, dir, amount = 0.02) {
      // Move along the screen axes: "left" is left of the viewer, whichever way they face.
      const yaw = state.viewerYaw || 0;
      const viewX = axis === 'x' ? dir * amount : 0;
      const viewZ = axis === 'z' ? dir * amount : 0;
      this.x += viewX * Math.cos(yaw) + viewZ * Math.sin(yaw);
      this.z += viewZ * Math.cos(yaw) - viewX * Math.sin(yaw);
    },
    rotate(dir, radians = 0.035) { this.yaw = (this.yaw + dir * radians) % (Math.PI * 2); syncTrayReadout(); },
    /*
       Scale is fixed at 1, and there is no control for it.

       The tray used to offer -/+ buttons spanning 0.5x to 2x. That is a
       reasonable control in a decorating toy and a serious bug in a fit
       checker: a 2.10 m sofa could be shrunk to 1.05 m until it fitted, while
       the verdict card went on reporting the catalogue's 210 cm and saying
       yes. The whole product is the claim that what you see is the real size.

       Kept as a no-op rather than deleted so any stray caller cannot throw.
    */
    resize() { /* intentionally does nothing — see above */ },
    tickSpin() {
      const now = performance.now();
      const elapsed = Math.min((now - (this.lastSpin || now)) / 1000, 0.1);
      this.lastSpin = now;
      // A full turn every 12 seconds, independent of frame rate.
      if (this.spinning) { this.yaw = (this.yaw + (Math.PI / 6) * elapsed) % (Math.PI * 2); syncTrayReadout(); }
    }
  };

  const clamp = (value, min, max) => Math.min(max, Math.max(min, value));


  /* ===== The control tray and AR chrome ===== */
  function syncTrayReadout() {
    const yawValue = $('#yaw-value');
    if (yawValue) yawValue.textContent = `${Math.round((arTransform.yaw * 180 / Math.PI + 360) % 360)}°`;
  }

  /* Tray buttons repeat while held, so a long press glides the model instead of
     needing dozens of taps. */
  function bindTray() {
    const tray = $('#ar-tray');
    if (!tray) return;
    let held = null;
    let lastTick = 0;

    // Rates per second, so the model glides at the same speed on any frame rate.
    const RATES = { move: 0.35, rotate: Math.PI / 3, scale: 0.35 };
    const STEPS = { move: 0.02, rotate: Math.PI / 36, scale: 0.05 };

    const apply = (button, amount) => {
      const dir = Number(button.dataset.dir);
      if (button.dataset.step === 'move') arTransform.move(button.dataset.axis, dir, amount);
      if (button.dataset.step === 'rotate') arTransform.rotate(dir, amount);
      if (button.dataset.step === 'scale') arTransform.resize(dir, amount);
    };

    const repeat = timestamp => {
      if (!held) return;
      const elapsed = Math.min((timestamp - lastTick) / 1000, 0.1);
      lastTick = timestamp;
      apply(held, RATES[held.dataset.step] * elapsed);
      requestAnimationFrame(repeat);
    };

    tray.addEventListener('pointerdown', event => {
      const button = event.target.closest('[data-step]');
      if (!button) return;
      event.preventDefault();
      button.setPointerCapture?.(event.pointerId);
      held = button;
      lastTick = performance.now();
      button.classList.add('is-active');
      apply(button, STEPS[button.dataset.step]); // a tap nudges once
      requestAnimationFrame(repeat);
    });

    const release = () => { held?.classList.remove('is-active'); held = null; };
    ['pointerup', 'pointercancel', 'pointerleave'].forEach(type => tray.addEventListener(type, release));

    $('#spin-toggle').addEventListener('click', () => {
      arTransform.spinning = !arTransform.spinning;
      $('#spin-toggle').setAttribute('aria-pressed', String(arTransform.spinning));
      $('#spin-toggle').classList.toggle('is-on', arTransform.spinning);
    });
  }

  function setARMode(mode) {
    state.arMode = mode;
    const indicator = $('#ar-mode-indicator');
    if (!indicator) return;
    const modes = { 'native-ar': 'Tracking', 'camera-preview': 'Preview', 'illustration-only': 'No camera' };
    indicator.textContent = modes[mode] || '';
    indicator.dataset.mode = mode;
  }

  function setHint(text) {
    const hint = $('#ar-mode-label');
    if (hint && hint.textContent !== text) hint.textContent = text;
  }

  /* =================== the guided room scan ===================
     Everything below reports what the device has actually determined. A row
     it cannot fill says so; none of them is ever filled with a plausible
     number to keep the panel looking complete. */

  /**
   * A length, in whatever unit the person asked for.
   *
   * One function, so a unit change reaches every readout at once. `m` is the
   * default and shows centimetres below a metre, because "0.42 m" is not how
   * anybody says it; the explicit cm and mm settings never switch on you.
   */
  const metres = value => {
    if (!Number.isFinite(value)) return '—';
    if (state.units === 'cm') return `${Math.round(value * 100)} cm`;
    if (state.units === 'mm') return `${Math.round(value * 1000)} mm`;
    return value >= 1 ? `${value.toFixed(2)} m` : `${Math.round(value * 100)} cm`;
  };

  /** Walking space the person wants left around a piece, in metres. */
  const clearancePref = () => {
    const field = $('#clearance-pref');
    const cm = Number(field?.value || 0);
    return Number.isFinite(cm) && cm > 0 ? cm / 100 : 0;
  };

  function setUnits(unit) {
    state.units = ['m', 'cm', 'mm'].includes(unit) ? unit : 'm';
    $$('.unit-option').forEach(button => {
      const active = button.dataset.unit === state.units;
      button.classList.toggle('is-active', active);
      button.setAttribute('aria-checked', String(active));
    });
    try { localStorage.setItem('furnishar-units', state.units); } catch { /* private mode */ }
    // Every readout that is already on screen, in the new unit.
    renderScanPanel();
    renderRoomResult();
    updateFitVerdict();
  }

  /**
   * Whether the tracker currently knows where it is.
   *
   * The word carries the meaning and the colour only reinforces it, so this
   * is readable to somebody who cannot tell the three tints apart.
   */
  const TRACKING_WORDS = { stable: 'Stable', acquiring: 'Acquiring', lost: 'Tracking lost' };
  function setTracking(nextState) {
    const node = $('#scan-tracking');
    if (!node || node.dataset.state === nextState) return;
    node.dataset.state = nextState;
    node.textContent = TRACKING_WORDS[nextState] || '';
  }

  /**
   * Draw the sweep as a row of ticks.
   *
   * Ticks rather than a filled bar: a bar going from grey to green carries
   * progress in colour alone, and a tick that is present or absent does not.
   */
  function renderSweepArc(coverage) {
    const arc = $('#scan-arc');
    if (!arc) return;
    const bins = coverage.toArray();
    // Rebuilt only when the count changes; the rest of the time the ticks are
    // just re-flagged, so this is not 72 DOM nodes a frame.
    if (arc.childElementCount !== bins.length) {
      arc.innerHTML = bins.map(() => '<i></i>').join('');
    }
    const ticks = arc.children;
    for (let i = 0; i < bins.length; i++) {
      const swept = bins[i] ? 'yes' : 'no';
      if (ticks[i].dataset.swept !== swept) ticks[i].dataset.swept = swept;
    }
    arc.setAttribute('aria-label', `Sweep coverage ${Math.round(coverage.degrees)} of 180 degrees`);
  }

  /**
   * Pin a measurement to each detected surface.
   *
   * Only surfaces big enough to be worth labelling, and only while their
   * centre is actually on screen — a label for something behind you, or for
   * every scrap of plane the tracker found, is clutter rather than
   * information.
   */
  function renderSurfaceLabels(surfaces, camera) {
    const host = $('#surface-labels');
    if (!host || !THREE || !camera) return;

    const wanted = [];
    for (const surface of surfaces) {
      const rect = surfaceExtent(surface);
      if (!rect || rect.long < 0.6) continue;          // a scrap, not a surface

      let cx = 0, cy = 0, cz = 0;
      for (const point of surface.polygon) { cx += point.x; cy += point.y; cz += point.z; }
      const count = surface.polygon.length;
      const screen = projectToScreen(new THREE.Vector3(cx / count, cy / count, cz / count), camera);
      if (!screen) continue;
      if (screen.x < 0 || screen.y < 0 || screen.x > window.innerWidth || screen.y > window.innerHeight) continue;

      wanted.push({
        key: surface.orientation + Math.round(cx) + Math.round(cz),
        // Named, not coded. "Floor 4.81 m × 3.42 m" needs no legend; a glyph
        // standing for "floor" needs one, and there is nowhere to put it.
        kind: surface.orientation === 'vertical' ? 'Wall' : 'Floor',
        text: `${metres(rect.long)} × ${metres(rect.short)}`,
        orientation: surface.orientation,
        screen
      });
    }

    if (host.childElementCount !== wanted.length) {
      host.innerHTML = wanted
        .map(() => '<span class="surface-label glass"><b></b><i></i></span>')
        .join('');
    }
    const nodes = host.children;
    wanted.forEach((label, index) => {
      const node = nodes[index];
      if (!node) return;
      const name = node.querySelector('b');
      const size = node.querySelector('i');
      if (name && name.textContent !== label.kind) name.textContent = label.kind;
      if (size && size.textContent !== label.text) size.textContent = label.text;
      node.dataset.kind = label.orientation;
      node.style.transform = `translate(${Math.round(label.screen.x)}px, ${Math.round(label.screen.y)}px) translate(-50%, -50%)`;
    });
  }

  /** The measured size of one surface, in metres, along its own axes. */
  function surfaceExtent(surface) {
    if (!surface?.polygon || surface.polygon.length < 3) return null;
    if (surface.orientation === 'vertical') {
      // A wall's two dimensions are its run along the floor and its height,
      // which an X/Z rectangle cannot express.
      const ys = surface.polygon.map(p => p.y);
      const height = Math.max(...ys) - Math.min(...ys);
      let run = 0;
      for (let i = 0; i < surface.polygon.length; i++) {
        for (let j = i + 1; j < surface.polygon.length; j++) {
          const a = surface.polygon[i];
          const b = surface.polygon[j];
          run = Math.max(run, Math.hypot(a.x - b.x, a.z - b.z));
        }
      }
      return { long: Math.max(run, height), short: Math.min(run, height) };
    }
    const rect = minimumAreaRectangle(surface.polygon);
    return rect ? { long: rect.length, short: rect.width } : null;
  }

  /**
   * Update every scan readout from the surfaces detected so far.
   *
   * Called from the frame loop, so it is written to touch the DOM only when
   * something changed — the room's dimensions settle within a second or two
   * and then stop moving, while the loop keeps running at 60 Hz.
   */
  function renderScanPanel() {
    const panel = $('#scan-panel');
    if (!panel || panel.hidden) return;

    const room = state.room;
    const readiness = state.scanReadiness;

    const set = (id, text) => {
      const node = $(id);
      if (node && node.textContent !== text) node.textContent = text;
    };

    set('#found-floor', room?.rectangle ? 'Found' : 'Looking…');
    set('#found-walls', room ? `${room.walls} found` : '—');
    set('#found-height', room?.height ? 'Measured' : 'Not yet');
    set('#found-sweep', `${Math.round(sweep.degrees)}°`);

    // A dash is the honest reading for a dimension nothing has determined.
    set('#room-length', room?.length ? metres(room.length) : '—');
    set('#room-width', room?.width ? metres(room.width) : '—');
    set('#room-height', room?.height ? metres(room.height) : '—');
    set('#room-perimeter', room?.perimeter ? metres(room.perimeter) : '—');

    /* V stays a dash until a height has actually been measured — a volume
       computed from a typical ceiling is a guess with three digits on it. */
    set('#room-volume', room?.volume ? `${room.volume.toFixed(2)} m³` : '—');
    set('#room-area', room?.floorArea ? `${room.floorArea.toFixed(2)} m²` : '—');
    /* P is a length, so it follows the unit setting. V and S deliberately do
       not: nobody asks for a room in 44 billion cubic millimetres, and m³/m²
       are how volume and area are said whatever the lengths are shown in. */
    set('#room-p', room?.perimeter ? metres(room.perimeter) : '—');

    set('#scan-guidance', sweep.guidance());
    renderSweepArc(sweep);

    // What the device cannot do is said once, plainly, rather than left for
    // somebody to infer from a panel that never fills in.
    const notes = [];
    if (!state.netSupport.planes) {
      notes.push('This browser cannot detect surfaces, so the room cannot be measured automatically here. Tap two points to measure a span instead.');
    } else if (!state.netSupport.depth) {
      notes.push('No depth sensor on this device — the net follows detected walls and floor only, not furniture.');
    }
    if (room?.heightSource === 'wall-extent') {
      notes.push('Height is measured to the top of the tallest wall scanned, which may be short of the ceiling.');
    }
    set('#scan-note', notes.join(' '));

    const useRoom = $('#use-room');
    if (useRoom) {
      const ready = Boolean(readiness?.ready);
      if (useRoom.disabled === ready) useRoom.disabled = !ready;
      const label = ready
        ? 'Use this room'
        : `Keep scanning — ${(readiness?.blocking || []).join(', ') || 'looking'}`;
      if (useRoom.textContent !== label) useRoom.textContent = label;
    }
  }

  /** Writes the scanned room into the planner card. */
  function renderRoomResult() {
    const room = state.scannedRoom;
    const set = (id, text) => {
      const node = $(id);
      if (node && node.textContent !== text) node.textContent = text;
    };

    if (!room?.rectangle) {
      set('#room-result-length', '—');
      set('#room-result-width', '—');
      set('#room-result-height', '—');
      set('#room-result-area', '—');
      set('#room-result-note', 'Not scanned yet.');
      return;
    }

    set('#room-result-length', metres(room.length));
    set('#room-result-width', metres(room.width));
    // A dimension the scan could not reach stays a dash and is named, rather
    // than being filled with a typical ceiling height.
    set('#room-result-height', room.height ? metres(room.height) : '—');
    set('#room-result-area', `${room.floorArea.toFixed(1)} m²`);

    const notes = [];
    if (!room.height) notes.push('Wall height could not be determined — scan again including the walls to get it.');
    else if (room.heightSource === 'wall-extent') notes.push('Height measured to the top of the tallest wall scanned, which may be short of the ceiling.');
    if (room.walls < 4) notes.push(`${room.walls} of the room's walls were detected, so the floor may extend further than measured.`);
    set('#room-result-note', notes.join(' ') || 'Measured from the detected floor, walls and ceiling.');
  }

  /**
   * Where the piece is standing, said while you move it.
   *
   * Only ever shown when a room has actually been scanned. Without one there
   * is nothing to be inside or outside of, and a panel reporting "fits" from
   * no measurement is the exact failure this product exists to avoid.
   */
  function renderPlacementVerdict(verdict) {
    const panel = $('#placement-verdict');
    if (!panel) return;
    if (!verdict || verdict.ok === null) { panel.hidden = true; return; }

    panel.hidden = false;
    const state_ = verdict.ok ? 'ok' : 'problem';
    if (panel.dataset.state !== state_) panel.dataset.state = state_;

    const word = $('#placement-word');
    const detail = $('#placement-detail');
    // The word carries it; the tint only reinforces it.
    const label = verdict.ok ? 'In the room' : 'Does not fit here';
    if (word && word.textContent !== label) word.textContent = label;
    if (detail && detail.textContent !== verdict.reason) detail.textContent = verdict.reason;
  }

  /** Hands the scanned room to the planner and closes AR. */
  function useScannedRoom() {
    const room = state.room;
    if (!room?.rectangle) return;
    state.scannedRoom = room;

    /*
       The floor's SHORTER side becomes the clearance figure.

       A piece has to stand somewhere in the room, and the tightest direction
       is what decides whether it can. Using the longer side would let a sofa
       that only fits along the far wall read as fitting anywhere — which is
       the kind of confident wrong answer this feature exists to replace.
    */
    applyLiveClearance(room.width * 100);
    const areaField = $('#floor-area');
    if (areaField) areaField.value = room.floorArea.toFixed(2);
    const spanField = $('#floor-span');
    if (spanField) spanField.value = Math.round(room.length * 100);

    renderRoomResult();
    updateFitVerdict();
    toast(`Room measured: ${metres(room.length)} × ${metres(room.width)}${room.height ? ` × ${metres(room.height)}` : ''}.`);
    state.session?.end();
  }

  /**
   * The live reading, smoothed, and never quoted more precisely than it is.
   *
   * This used to print the raw per-frame hit-test distance to one decimal of a
   * centimetre and to the millimetre. A hit-test pose moves every frame even
   * on a motionless phone, so at 60 Hz those fields flickered through a couple
   * of centimetres of noise — the exact 2.91 / 2.96 / 2.88 problem — and the
   * millimetre field claimed three digits of precision the tracker was not
   * delivering.
   *
   * Now: the value passes through a One Euro filter (steady when still, and
   * still responsive when the phone moves), and how many digits are shown
   * follows the tracker's observed steadiness rather than being fixed.
   */
  function updateLiveMeasurementDisplay(distanceInMeters, caption = '', series = caption) {
    const panel = $('#live-measurement');
    if (!panel) return null;

    // "Phone to surface" and "point A to target" are different quantities. A
    // filter carried across the switch would spend a second easing from one
    // to the other and show a distance that is neither, so each series
    // acquires from scratch.
    if (series !== liveSeries) {
      liveSeries = series;
      resetLiveMeasurement();
    }

    const smoothed = liveFilter.filter(distanceInMeters, performance.now());
    liveSteadiness.push(smoothed);
    const spread = liveSteadiness.spread();
    const { decimals, trustworthy } = displayPrecision(spread);

    $('#live-cm').textContent = `${(smoothed * 100).toFixed(decimals)} cm`;
    // The millimetre field only exists while a millimetre is meaningful. An
    // empty dash is honest; a number that is three-quarters noise is not.
    $('#live-mm').textContent = decimals >= 1 ? `${(smoothed * 1000).toFixed(0)} mm` : '—';
    $('#live-m').textContent = `${smoothed.toFixed(decimals >= 1 ? 3 : 2)} m`;

    // §11/§32: say when the reading is not yet worth trusting, rather than
    // presenting an unsettled number as a fact.
    const steadyNote = liveSteadiness.ready && !trustworthy
      ? 'holding steady…'
      : '';
    $('#live-caption').textContent = [caption, steadyNote].filter(Boolean).join(' · ');
    panel.dataset.steady = trustworthy ? 'yes' : 'no';
    panel.hidden = false;

    // Handed back so the fit verdict uses the number on screen, not a
    // different one computed from the same frame.
    return { metres: smoothed, trustworthy, spread };
  }

  /** Dropped whenever a measurement ends, so the next one acquires cleanly
      instead of easing out of the previous span's value. */
  function resetLiveMeasurement() {
    liveFilter.reset();
    liveSteadiness.reset();
  }

  function hideLiveMeasurement() {
    const panel = $('#live-measurement');
    if (panel) panel.hidden = true;
    // Whatever comes back next is a new span, not a continuation of this one.
    liveSeries = null;
    resetLiveMeasurement();
  }

  /* Spatial UI: a small chip pinned to the model's own screen position, so the
     readout sits with the object rather than floating in a corner. */
  function positionAnchorChip(screenPoint, primary, secondary = '') {
    const chip = $('#ar-anchor-chip');
    if (!chip) return;
    if (!screenPoint) { chip.hidden = true; return; }
    chip.hidden = false;
    // Keep the chip on screen even when the model itself is partly out of frame.
    const x = clamp(screenPoint.x, 72, window.innerWidth - 72);
    const y = clamp(screenPoint.y, 108, window.innerHeight - 190);
    chip.style.transform = `translate(-50%,-50%) translate(${Math.round(x)}px, ${Math.round(y)}px)`;
    $('#anchor-primary').textContent = primary;
    $('#anchor-secondary').textContent = secondary;
  }

  function userYawQuaternion() {
    return new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(0, 1, 0), arTransform.yaw);
  }

  /* Pins the size chip to the top of the model and keeps its numbers honest as
     the tray rescales it. */
  function updatePlacementChip(model, camera, product) {
    if (!THREE || !model) return positionAnchorChip(null);
    const box = new THREE.Box3().setFromObject(model);
    const top = new THREE.Vector3((box.min.x + box.max.x) / 2, box.max.y, (box.min.z + box.max.z) / 2);
    // Read the size off the product's own footprint, not the world-aligned box,
    // so turning the piece never inflates the numbers.
    // The real size, full stop. There is no user scale to multiply by any
    // more, and quoting anything else here would be quoting a piece of
    // furniture that does not exist.
    const shown = state.scaleDecision?.actualCm || product.modelBounds || product.dimensions;
    positionAnchorChip(
      projectToScreen(top, camera),
      `${Math.round(shown.width)} × ${Math.round(shown.depth)} cm`,
      `${Math.round(shown.height)} cm tall · ${product.name}`
    );
  }

  /* Real-time link from the AR reading to the planner's fit verdict. */
  function applyLiveClearance(centimeters) {
    const pointB = $('#point-b');
    if (!pointB) return;
    const rounded = Math.round(centimeters);
    armUseMeasurement();
    if (Number(pointB.value) === rounded) return;
    $('#point-a').value = 0;
    pointB.value = rounded;
    updateFitVerdict();
  }

  /* There is now a reading worth keeping, so the button that says so becomes
     usable. Disabled until then, because "Use this measurement" with nothing
     measured is a button that lies about what it will do. */
  function armUseMeasurement() {
    const button = $('#use-measurement');
    if (button && button.disabled) button.disabled = false;
  }

  function projectToScreen(vector3, camera) {
    if (!THREE || !camera) return null;
    const projected = vector3.clone().project(camera);
    if (projected.z > 1) return null;
    return {
      x: (projected.x * 0.5 + 0.5) * window.innerWidth,
      y: (-projected.y * 0.5 + 0.5) * window.innerHeight
    };
  }

  function onARKeydown(event) {
    if (event.key !== 'Escape' || !$('#ar-experience')) return;
    event.preventDefault();
    if (state.session) state.session.end().catch(cleanupAR); else cleanupAR();
  }

  function mountARExperience() {
    let experience = $('#ar-experience');
    if (!experience) {
      document.body.insertAdjacentHTML('beforeend', AR_EXPERIENCE_HTML);
      experience = $('#ar-experience');
    }
    experience.hidden = false;
    /* Say something immediately.

       Requesting the camera and negotiating an XR session takes a beat, and
       until the first frame arrives this layer is an opaque black rectangle.
       On a recording of a real phone that black screen is the first thing the
       scanner shows, with no indication that anything is happening — it reads
       as a crash rather than as a camera warming up. The first hint is set
       here, before any awaiting starts, and whatever the session negotiates
       replaces it a moment later. */
    setHint('Starting the camera…');
    arTransform.reset();
    bindTray();
    syncTrayReadout();
    $('#exit-ar').addEventListener('click', () => state.session ? state.session.end() : cleanupAR(), { once: true });
    $('#close-outline').addEventListener('click', closeAreaOutline);
    /* The reading is already on the card — applyLiveClearance and the area
       scan write it as it changes — so this confirms and leaves rather than
       transferring anything. Saying so beats a silent exit that leaves people
       wondering whether the number survived. */
    $('#use-measurement').addEventListener('click', () => {
      const kept = state.measureMode === 'area'
        ? $('#measured-area')?.textContent
        : $('#measured-distance')?.textContent;
      if (state.session) state.session.end(); else cleanupAR();
      if (kept) toast(`Kept ${kept}. It is on your card.`);
    });
    document.addEventListener('keydown', onARKeydown);
    return experience;
  }

  function unmountARExperience() {
    document.removeEventListener('keydown', onARKeydown);
    $('#ar-experience')?.remove();
  }

  function setModelSurfaceState(modelRoot, blocked) {
    if (!modelRoot || !THREE) return;
    modelRoot.traverse(child => {
      if (!(child instanceof THREE.Mesh) || !child.material) return;
      if (!child.userData.normalMaterial) child.userData.normalMaterial = child.material;
      if (blocked) {
        child.userData.warningMaterial ||= new THREE.MeshBasicMaterial({ color: 0xff6b5a, transparent: true, opacity: 0.66 });
        child.material = child.userData.warningMaterial;
      } else {
        child.material = child.userData.normalMaterial;
      }
    });
    $('#ar-reticle')?.classList.toggle('is-blocked', !!blocked);
  }

  function setPlacementButtonState(blocked, confirmed = false) {
    const button = $('#place-button');
    if (!button) return;
    button.disabled = blocked || confirmed;
    button.classList.toggle('is-blocked', blocked);
    button.classList.toggle('is-confirmed', confirmed);
    button.setAttribute('aria-label', confirmed ? 'Placed' : 'Confirm placement');
  }


  /* The AR fallback's colour.
     When a product has no GLB the engine places a plain box at the product's
     real dimensions — honest, because it is obviously a box rather than
     furniture pretending to be the piece. It still needs the product's colour,
     which is the one thing the deleted illustration code is still needed for.
     Kept local rather than imported: this file is loaded as a standalone
     module by the planner and has no imports at all. */
  const COLOURS = {
    Sand: '#d4b18b', Oak: '#aa7953', Terracotta: '#c46e50', Walnut: '#725343',
    Black: '#474b47', White: '#d9d4ca', Natural: '#b58d62'
  };
  function colorFor(product) { return COLOURS[product.color] || '#8c9d88'; }

  /* ===== The piece being placed =====
     The picture is a render of this product's own model, the same one the
     catalogue card shows. It used to be a CSS silhouette assembled from a
     dozen spans and a shape keyword — which in the planner was a particularly
     odd thing to show, because the planner is the one screen where the real
     model is definitely present and about to be loaded a few pixels away.

     A product with no thumbnail gets no picture rather than a stand-in. In
     practice the planner only ever holds products with a model, so this is
     the belt to the braces. */
  function furniture(product, extra = '') {
    if (!product.thumbnail) return '';
    return `<img class="planner-product-thumb ${extra}" src="${escapeHtml(product.thumbnail)}"
      alt="${escapeHtml(product.name)}, rendered from its 3D model" width="220" height="220">`;
  }


  /* ---------------------------------------------------------------------------
     Backend
     The bundled JSON catalogue that ships with the app. Everything below this
     block is written against `backend` rather than against it directly.
  --------------------------------------------------------------------------- */


  /* ===== Measurement persistence and geometry ===== */
  function saveMeasurement() {
    try {
      localStorage.setItem(MEASUREMENT_KEY, JSON.stringify({
        mode: state.measureMode,
        pointA: $('#point-a').value,
        pointB: $('#point-b').value,
        area: $('#floor-area').value,
        span: $('#floor-span').value,
        savedAt: Date.now()
      }));
    } catch { /* private mode */ }
  }

  /** Restores the last measurement, so a shopper comparing pieces does not
      re-measure the same doorway for every one. */
  function restoreMeasurement() {
    let saved = null;
    try { saved = JSON.parse(localStorage.getItem(MEASUREMENT_KEY) || 'null'); } catch { /* private mode */ }
    if (!saved) return;
    // A measurement older than a day is probably a different room.
    if (Date.now() - (saved.savedAt || 0) > 24 * 60 * 60 * 1000) return;
    if (saved.pointA) $('#point-a').value = saved.pointA;
    if (saved.pointB) $('#point-b').value = saved.pointB;
    if (saved.area) $('#floor-area').value = saved.area;
    if (saved.span) $('#floor-span').value = saved.span;
    if (saved.mode) setMeasureMode(saved.mode);
  }


  // Declared beside the backend helpers in the vanilla client.js, which the
  // planner does not need; the measurement mathematics do.
  let geo = null;

  async function initGeometry() {
    if (geo) return geo;
    geo = await import('../../public/geometry.js');
    return geo;
  }


  /* ===== Product selection and the planner cards ===== */
  function selectProduct(id, goToPlanner = false) {
    const next = state.products.find(item => item.id === id);
    if (!next) return;
    state.selected = next;
    renderPlanner();
  }

  /* Only pieces that can actually be placed.
     A planner listing a product with no model would offer a choice that
     cannot be taken — you arrive at the scan step with nothing to put in the
     room. */
  function placeable() {
    return state.products.filter(item => item.modelGlb);
  }

  function renderPlanner() {
    const options = placeable();
    /*
       The piece somebody explicitly asked for is never swapped out.

       An earlier version of this reassigned the selection to the first
       placeable product whenever the current one had no model — which meant
       opening /plan?product=<a-piece-with-no-model> quietly put a DIFFERENT
       chair in the planner, sized the fit verdict to it, and never said a
       word. The honest answer ("this piece has no 3D model uploaded") is the
       one thing that must not be replaced by a picture of something else.

       So the list offers only what can be placed, and a request for something
       that cannot is kept and explained.
    */
    /*
       Nothing is chosen for you.

       This used to read `state.selected ||= options[0]`, which meant anybody
       who opened /plan to find out how big their room is arrived already
       holding an armchair they never asked for. It was invisible on the card
       — but not in AR, where that piece's chip sat over the camera and its
       box was drawn into the room being measured. Measuring came second to a
       shopping decision nobody had made.

       A room is a room. The selection stays null until somebody picks, or
       until ?product= names one.
    */
    const product = state.selected;
    const unplaceable = Boolean(product) && !product.modelGlb;

    /*
       The card is titled "Pick a product" and, until now, presented no way to
       pick one: it rendered the single product you arrived with as static
       markup. selectProduct() existed and worked; nothing ever called it from
       the UI. So somebody who opened the planner from the nav rather than from
       a product page got whichever piece happened to be first, with no
       indication that it was a choice at all.

       It is a real list now — a radiogroup, because this is one selection out
       of several and that is what a screen reader should be told.
    */
    const picker = $('#planner-product');
    if (!picker) return;

    if (!options.length) {
      picker.innerHTML = `<p class="planner-empty">No piece in the catalogue has a 3D model yet,
        so there is nothing to place. You can still measure your room below.</p>`;
    } else {
      // Named, not hidden. The shopper followed a link for this piece; they
      // are owed the reason it is not in the list below.
      const notice = unplaceable
        ? `<p class="planner-unplaceable"><b>${escapeHtml(product.name)} has no 3D model yet,</b>
             so it cannot be placed in your room. Its measurements are still checked
             below. Pick one of these to place instead:</p>`
        : '';
      picker.innerHTML = `${notice}<div class="planner-choices" role="radiogroup" aria-label="Choose a piece to place">
        ${options.map(item => {
          const current = product && item.id === product.id;
          return `<button type="button" class="planner-choice${current ? ' is-current' : ''}"
            role="radio" aria-checked="${current ? 'true' : 'false'}" data-product-id="${escapeHtml(item.id)}">
            ${furniture(item)}
            <span class="planner-choice-text">
              <b>${escapeHtml(item.name)}</b>
              <small>${escapeHtml(item.store)}</small>
              <small>${item.dimensions.width} W × ${item.dimensions.depth} D × ${item.dimensions.height} H</small>
            </span>
          </button>`;
        }).join('')}
      </div>`;

      for (const button of picker.querySelectorAll('[data-product-id]')) {
        button.addEventListener('click', () => selectProduct(button.dataset.productId));
      }
    }

    /* Nothing chosen is a normal state now, not a broken one. updateFitVerdict
       owns what card 03 says in that case — including after a scan, when it
       has a room to report. */
    if (!product) { updateFitVerdict(); return; }
    $('#check-width').textContent = cm(product.dimensions.width);
    $('#check-depth').textContent = cm(product.dimensions.depth);
    const arProductName = $('#ar-product-name');
    if (arProductName) arProductName.textContent = product.name;
    updateFitVerdict();
  }


  /* ===== Measuring, the fit verdict and the plan view ===== */
  function measuredDistance() { return Math.abs(Number($('#point-b').value || 0) - Number($('#point-a').value || 0)); }
  function measuredArea() { return Math.max(Number($('#floor-area').value || 0), 0); }

  /* Clearance measures a span; floor area measures a polygon. The switch changes
     what the AR scan captures, what the fields ask for, and how the verdict is
     decided. */
  const MEASURE_MODES = {
    clearance: {
      title: 'Two-point room scan',
      copy: 'Aim at a textured, non-reflective floor in bright light. On Android Chrome, tap two points across the opening. Otherwise use the fields below.',
      button: 'Scan with your camera'
    },
    area: {
      title: 'Floor area scan',
      copy: 'Tap around the free floor — three points or more, in order, then close the outline. Two scans are compared before a reading is accepted.',
      button: 'Scan floor area'
    },
    room: {
      title: 'Whole-room scan',
      copy: 'Stand near the middle of the room and turn slowly through a half-circle. Floor and walls are detected as you go, and the room’s length, width and height are measured from them. Needs a device that can detect surfaces — you will be told if yours cannot.',
      button: 'Scan the room'
    }
  };

  function setMeasureMode(mode) {
    state.measureMode = MEASURE_MODES[mode] ? mode : 'clearance';
    const current = state.measureMode;
    $$('.mode-option').forEach(button => {
      const active = button.dataset.measureMode === current;
      button.classList.toggle('is-active', active);
      button.setAttribute('aria-checked', String(active));
    });

    // Each mode shows only the fields that belong to it, so there is never a
    // stale number visible from a mode you are no longer in.
    $('#clearance-fields').hidden = current !== 'clearance';
    $('#area-fields').hidden = current !== 'area';
    const roomFields = $('#room-fields');
    if (roomFields) roomFields.hidden = current !== 'room';

    const config = MEASURE_MODES[current];
    $('#measure-title').textContent = config.title;
    $('#measure-copy').textContent = config.copy;
    $('#ar-button').textContent = config.button;
    try { localStorage.setItem('furnishar-measure-mode', current); } catch { /* private mode */ }
    updateFitVerdict();
  }
  /* What was measured, written down — with no opinion about whether anything
     fits in it.

     These three fields used to be set only inside the fit calculation, which
     needs a product. So with nothing selected, measuring a floor updated the
     verdict and left "12.0 m²" — the default — sitting in the readout the
     user was actually looking at. The measurement is the deliverable; it gets
     written whether or not there is a sofa to judge against it. */
  function renderRawMeasurement() {
    if (!geo) return;
    const clearance = measuredDistance();
    const distance = cm(clearance);
    const set = (selector, text) => { const el = $(selector); if (el) el.textContent = text; };
    set('#measured-distance', distance);
    set('#visual-distance', distance);
    set('#measured-area', geo.formatArea(measuredArea()));
  }

  function updateFitVerdict() {
    const product = state.selected;
    if (!geo) return;
    renderRawMeasurement();

    /*
       No piece chosen is a normal state, not a missing one.

       This used to `return` on a null product, which left card 03 holding
       whatever it happened to say last. Now that nothing is selected by
       default, that is the state most people see first, so it says what it
       is — and, once a room has been measured, it leads with the measurement
       rather than with the absence of a sofa. Measuring is the deliverable;
       the piece is optional. */
    if (!product) {
      const room = state.scannedRoom;
      const measured = state.measureMode === 'room' && room?.rectangle;
      const verdict = $('#fit-verdict');
      for (const id of ['#check-width', '#check-depth']) {
        const cell = $(id);
        if (cell) cell.textContent = '—';
      }
      if (measured) {
        /* The room is the thing that was measured, so it is drawn and named
           even with nothing to put in it. Withholding the plan view until a
           sofa is chosen would make the measurement look like a step towards
           shopping rather than the answer it already is. */
        $('#verdict-title').textContent = 'Room verdict';
        $('#check-clearance-label').textContent = 'Room (shortest side)';
        $('#check-clearance').textContent =
          metres(Math.min(room.rectangle.length, room.rectangle.width));
        drawFitPlan(null, {
          kind: 'room', length: room.rectangle.length, width: room.rectangle.width
        });
      } else if (state.measureMode === 'room') {
        /* Whole-room mode with no scan yet. The two-point field still holds
           its 120 cm default, and an earlier version of this branch reported
           that number as though it were a measurement of this room — a
           reading the user had never taken, on the screen that is supposed to
           be the honest one. Nothing measured means nothing claimed. */
        $('#verdict-title').textContent = 'Room verdict';
        $('#check-clearance-label').textContent = 'Room (shortest side)';
        const cell = $('#check-clearance');
        if (cell) cell.textContent = '—';
        drawFitPlan(null, { kind: 'none' });
      } else {
        /* Two-point and floor-area readings stand on their own too. The card
           reports the span or the area that was actually measured instead of
           going blank because no furniture has been picked to judge it. */
        const isArea = state.measureMode === 'area';
        $('#verdict-title').textContent = isArea ? 'Floor measured' : 'Clearance measured';
        $('#check-clearance-label').textContent = isArea ? 'Measured floor' : 'Measured clearance';
        const cell = $('#check-clearance');
        if (cell) cell.textContent = isArea ? geo.formatArea(measuredArea()) : cm(measuredDistance());
        drawFitPlan(null, { kind: 'none' });
      }
      if (verdict) {
        const isArea = state.measureMode === 'area';
        const unscannedRoom = !measured && state.measureMode === 'room';
        verdict.className = 'fit-verdict is-idle';
        verdict.innerHTML = measured
          ? `<div class="verdict-icon" aria-hidden="true">◧</div>
             <h3>Room measured.</h3>
             <p>${metres(room.rectangle.length)} × ${metres(room.rectangle.width)}${
               room.height ? `, ${metres(room.height)} high` : ''}. Pick a piece above
             to check whether it fits.</p>`
          : unscannedRoom
          ? `<div class="verdict-icon" aria-hidden="true">·</div>
             <h3>No room measured yet.</h3>
             <p>Scan your room with the camera above. You do not need to choose
             any furniture first.</p>`
          : `<div class="verdict-icon" aria-hidden="true">·</div>
             <h3>${escapeHtml(isArea ? geo.formatArea(measuredArea()) : cm(measuredDistance()))} measured.</h3>
             <p>That figure is yours without choosing anything. Pick a piece above
             whenever you want to check whether it fits.</p>`;
      }
      return;
    }

    /*
       A scanned room answers a better question than a measured span.

       "Does it fit through this gap" and "can this live in this room" are not
       the same, and only the second is what somebody shopping for a sofa
       actually wants to know. When a whole-room scan has been taken, the
       verdict is computed against the floor rectangle and the ceiling — so a
       piece that clears the doorway but cannot stand anywhere is told so.
    */
    if (state.measureMode === 'room') {
      const room = state.scannedRoom;
      $('#verdict-title').textContent = 'Room verdict';
      $('#check-clearance-label').textContent = 'Room (shortest side)';

      if (!room?.rectangle) {
        $('#check-clearance').textContent = '—';
        $('#fit-verdict').className = 'fit-verdict';
        $('#fit-verdict').innerHTML =
          '<div class="verdict-icon">·</div><h3>No room measured yet.</h3>' +
          '<p>Scan the room and the fit is worked out against its real floor and ceiling.</p>';
        drawFitPlan(product, { kind: 'none' });
        return;
      }

      const piece = {
        width: product.dimensions.width / 100,
        depth: product.dimensions.depth / 100,
        height: product.dimensions.height / 100
      };
      const verdict = fitInRoom(room, piece, { clearance: clearancePref() });
      $('#check-clearance').textContent = metres(room.width);
      $('#fit-verdict').className = `fit-verdict ${verdict.fits ? '' : 'fail'}`;
      $('#fit-verdict').innerHTML = verdict.fits
        ? `<div class="verdict-icon">✓</div><h3>It fits this room.</h3>` +
          `<p>${escapeHtml(verdict.reason)} The room measured ` +
          `${metres(room.length)} × ${metres(room.width)}` +
          `${room.height ? ` × ${metres(room.height)}` : ''}.</p>`
        : `<div class="verdict-icon">!</div><h3>It does not fit this room.</h3>` +
          `<p>${escapeHtml(verdict.reason)}</p>`;
      drawFitPlan(product, { kind: 'room', length: room.length, width: room.width });
      return;
    }

    // The verdict card names what was actually measured.
    const isArea = state.measureMode === 'area';
    $('#verdict-title').textContent = isArea ? 'Floor verdict' : 'Clearance verdict';
    $('#check-clearance-label').textContent = isArea ? 'Measured floor' : 'Measured clearance';

    if (isArea) {
      const area = measuredArea();
      const fit = geo.fitAgainstArea(product.dimensions, area);
      $('#measured-area').textContent = geo.formatArea(area);
      $('#check-clearance').textContent = geo.formatArea(area);
      $('#fit-verdict').className = `fit-verdict ${fit.fits ? '' : 'fail'}`;
      $('#fit-verdict').innerHTML = fit.fits
        ? `<div class="verdict-icon">✓</div><h3>It fits the floor.</h3><p>The piece covers ${geo.formatArea(fit.footprint)} — ${Math.round(fit.shareOfFloor * 100)}% of the ${geo.formatArea(area)} you measured, leaving ${geo.formatArea(fit.remaining)} free.</p>`
        : `<div class="verdict-icon">!</div><h3>Not enough floor.</h3><p>With a 5 cm gap on each side this piece needs ${geo.formatArea(fit.withMargin)}. You measured ${geo.formatArea(area)}.</p>`;
      drawFitPlan(product, { kind: 'area', area });
      return;
    }

    const clearance = measuredDistance();
    const fit = geo.fitAgainstClearance(product.dimensions, clearance);
    $('#measured-distance').textContent = cm(clearance);
    $('#visual-distance').textContent = cm(clearance);
    $('#check-clearance').textContent = cm(clearance);
    $('#fit-verdict').className = `fit-verdict ${fit.fits ? '' : 'fail'}`;
    $('#fit-verdict').innerHTML = fit.fits
      ? `<div class="verdict-icon">✓</div><h3>It should fit.</h3><p>You have ${cm(fit.spare)} of remaining clearance. Keep a little extra room for comfortable movement.</p>`
      : `<div class="verdict-icon">!</div><h3>Needs more clearance.</h3><p>This piece needs at least ${cm(fit.needed)} including a 5 cm comfort margin. Try a narrower option or re-measure the opening.</p>`;
    drawFitPlan(product, { kind: 'clearance', clearance });
  }

  /* A plan view drawn to scale: the measured space, with the piece's real
     footprint inside it. Numbers are easy to misread; a picture of the two
     rectangles is not. */
  function drawFitPlan(product, measurement) {
    const stage = $('#fit-plan-stage');
    if (!stage) return;
    const space = $('#fit-plan-space');
    const piece = $('#fit-plan-piece');

    // Metres of real space represented by the drawing, always square.
    let spaceWidth;
    let spaceDepth;
    if (measurement.kind === 'none') {
      // Nothing measured yet. Drawing a plausible-looking room here would be
      // a picture of a measurement that has not happened.
      stage.dataset.state = 'empty';
      $('#fit-plan-space-label').textContent = 'Not measured yet';
      space.style.aspectRatio = '4 / 3';
      space.style.width = '100%';
      piece.hidden = true;
      return;
    }
    stage.dataset.state = 'measured';
    piece.hidden = false;

    if (measurement.kind === 'room') {
      // The real rectangle the scan found, at its real proportions — not a
      // square of equivalent area.
      spaceWidth = measurement.length;
      spaceDepth = measurement.width;
      $('#fit-plan-space-label').textContent =
        `${metres(measurement.length)} × ${metres(measurement.width)} measured`;
    } else if (measurement.kind === 'area') {
      const side = Math.sqrt(Math.max(measurement.area, 0.01));
      const longest = Number($('#floor-span').value) / 100;
      spaceWidth = longest > 0.1 ? longest : side;
      spaceDepth = spaceWidth > 0 ? measurement.area / spaceWidth : side;
      // A longest side that does not match the area produces a sliver of a room.
      // Rather than draw something misleading, fall back to a square of the same
      // area — the area is the measurement, the shape is only an illustration.
      if (!Number.isFinite(spaceDepth) || spaceDepth < 0.4 || spaceDepth > spaceWidth) {
        spaceWidth = side;
        spaceDepth = side;
      }
      $('#fit-plan-space-label').textContent = `${geo.formatArea(measurement.area)} measured`;
    } else {
      spaceWidth = Math.max(measurement.clearance / 100, 0.1);
      spaceDepth = Math.max(product.dimensions.depth / 100 * 1.6, 0.4);
      $('#fit-plan-space-label').textContent = `${cm(measurement.clearance)} clearance`;
    }

    /* The room on its own, when nothing has been chosen to stand in it.
       The rectangle is the measurement; an empty one is a complete answer. */
    if (!product) {
      space.style.aspectRatio = `${spaceWidth} / ${spaceDepth}`;
      space.style.width = spaceWidth >= spaceDepth ? '100%' : 'auto';
      space.style.height = spaceWidth >= spaceDepth ? 'auto' : '100%';
      piece.hidden = true;
      return;
    }

    // The piece is drawn as a share of the space it sits in, so both rectangles
    // stay in the same scale however the space is shaped.
    const pieceWidthM = product.dimensions.width / 100;
    const pieceDepthM = product.dimensions.depth / 100;
    const tooWide = pieceWidthM > spaceWidth;
    const tooDeep = pieceDepthM > spaceDepth;

    space.style.aspectRatio = `${spaceWidth} / ${spaceDepth}`;
    space.style.width = spaceWidth >= spaceDepth ? '100%' : 'auto';
    space.style.height = spaceWidth >= spaceDepth ? 'auto' : '100%';
    const widthShare = Math.min((pieceWidthM / spaceWidth) * 100, 100);
    const depthShare = Math.min((pieceDepthM / spaceDepth) * 100, 100);
    piece.style.width = `${widthShare}%`;
    piece.style.height = `${depthShare}%`;
    piece.classList.toggle('is-over', tooWide || tooDeep);
    // Below about a third of the space the label no longer fits inside the piece.
    piece.classList.toggle('is-tiny', widthShare < 34 || depthShare < 28);
    $('#fit-plan-piece-label').textContent = `${product.dimensions.width} × ${product.dimensions.depth} cm`;
  }


  function toast(message) {
    const element = $('#toast'); element.textContent = message; element.classList.add('show');
    clearTimeout(toast.timer); toast.timer = setTimeout(() => element.classList.remove('show'), 3400);
  }


  /* ===== The AR engine ===== */
  async function checkARSupport() {
    const status = $('#ar-status');
    if (!window.isSecureContext) {
      status.textContent = 'Use HTTPS (or localhost) to enable camera and WebXR. Guided measurement is still available.';
      return false;
    }
    const isIOS = /iPad|iPhone|iPod/.test(navigator.userAgent) || (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1);
    if (isIOS && state.selected?.modelUsdz) {
      status.textContent = 'iPhone Safari detected. AR Quick Look will open the native USDZ viewer for this product.';
      return false;
    }
    if (!navigator.xr) {
      status.textContent = 'WebXR is unavailable in this browser. The camera preview and guided measurement will still work.';
      return false;
    }
    try {
      const supported = await navigator.xr.isSessionSupported('immersive-ar');
      status.textContent = supported ? 'AR-ready device detected. Use a bright, textured floor for best tracking.' : 'This device does not expose immersive AR. A camera preview will be used instead.';
      return supported;
    } catch (error) {
      console.warn('[AR] Support probe failed:', error?.name, error?.message);
      status.textContent = 'AR availability could not be checked. Guided measurement is available.';
      return false;
    }
  }

  function distanceBetween(a, b) { return Math.hypot(a.x - b.x, a.y - b.y, a.z - b.z); }
  function matrixMultiply(a, b) { const result = new Float32Array(16); for (let column = 0; column < 4; column++) for (let row = 0; row < 4; row++) result[column * 4 + row] = a[row] * b[column * 4] + a[4 + row] * b[column * 4 + 1] + a[8 + row] * b[column * 4 + 2] + a[12 + row] * b[column * 4 + 3]; return result; }
  function translateScale(base, x, y, z, sx, sy, sz) { return matrixMultiply(base, new Float32Array([sx,0,0,0, 0,sy,0,0, 0,0,sz,0, x,y,z,1])); }
  function compileShader(gl, type, source) { const shader = gl.createShader(type); gl.shaderSource(shader, source); gl.compileShader(shader); if (!gl.getShaderParameter(shader, gl.COMPILE_STATUS)) throw new Error(gl.getShaderInfoLog(shader)); return shader; }
  function arRenderer(gl) {
    const vertex = compileShader(gl, gl.VERTEX_SHADER, 'attribute vec3 p; uniform mat4 mvp; void main(){ gl_Position=mvp*vec4(p,1.0); }');
    const fragment = compileShader(gl, gl.FRAGMENT_SHADER, 'precision mediump float; uniform vec4 color; void main(){ gl_FragColor=color; }');
    const program = gl.createProgram(); gl.attachShader(program, vertex); gl.attachShader(program, fragment); gl.linkProgram(program);
    const vertices = new Float32Array([-1,-1,1,1,-1,1,1,1,1,-1,-1,1,1,1,1,-1,1,1,1,-1,-1,1,1,-1,1,1,1,1,-1,-1,1,-1,-1,-1,-1,-1,-1,1,1,-1,1,1,-1,-1,-1,-1,1,-1,1,-1,1,1,-1,1,1,1,1,1,-1,1,1,-1,-1,-1,1,-1,1,1,1,1,-1,-1,-1,1,-1,1,-1,1,1,-1,-1,-1,-1,-1,1,-1,1,-1,1,1,-1,1,-1,-1,-1,1,-1,-1,1,1,-1,-1,1,1,-1,1,1,-1,1,-1,-1,-1,-1,-1,1,-1,1,1,-1,1,1,-1,-1]);
    const buffer = gl.createBuffer(); gl.bindBuffer(gl.ARRAY_BUFFER, buffer); gl.bufferData(gl.ARRAY_BUFFER, vertices, gl.STATIC_DRAW);
    return { draw(mvp, color) { gl.useProgram(program); gl.bindBuffer(gl.ARRAY_BUFFER, buffer); const position = gl.getAttribLocation(program, 'p'); gl.enableVertexAttribArray(position); gl.vertexAttribPointer(position, 3, gl.FLOAT, false, 0, 0); gl.uniformMatrix4fv(gl.getUniformLocation(program, 'mvp'), false, mvp); gl.uniform4fv(gl.getUniformLocation(program, 'color'), color); gl.drawArrays(gl.TRIANGLES, 0, 36); } };
  }

  /**
   * Why the last model load failed, for the message shown in its place.
   *
   * Every one of these used to end at the same sentence — "3D preview
   * unavailable on this device" — which is a guess, and usually the wrong one.
   * A piece with no model uploaded, a file the server will not serve, and a
   * corrupt .glb are not device problems, and telling a shop owner their phone
   * is at fault sends them to replace the one thing that was working.
   */
  function modelFailureMessage() {
    const measure = ' Use the measurement fields to check fit.';
    const issue = state.modelIssue;
    if (!issue) return `3D preview unavailable on this device.${measure}`;

    if (issue.kind === 'no-model') {
      return `This piece has no 3D model uploaded yet, so there is nothing to place.${measure}`;
    }
    if (issue.kind === 'no-three') {
      return `The 3D engine did not finish loading. Check your connection and reload the page.${measure}`;
    }
    if (issue.kind === 'fetch-failed') {
      return issue.html
        ? `The model could not be downloaded — the server sent a web page instead of a file `
          + `(HTTP ${issue.status}). On a protected preview deployment, that protection blocks it.${measure}`
        : `The model could not be downloaded (HTTP ${issue.status}).${measure}`;
    }
    if (issue.kind === 'no-decoder') {
      return `This model is compressed, and the decoder for it did not load — the file itself is `
        + `fine. Reload the page; if it keeps happening the 3D decoder files are not being served.${measure}`;
    }
    if (issue.kind === 'parse-failed') {
      return `The model downloaded but could not be read — the .glb looks corrupt or incomplete. `
        + `Re-upload it from the store portal.${measure}`;
    }
    if (issue.kind === 'network') {
      return `The model could not be reached. Check your connection and try again.${measure}`;
    }
    // The file is fine; its scale is not. Placing it would mean guessing how
    // big it is, and a guessed size in somebody's room is worse than no
    // preview at all — the measurements below are still true.
    if (issue.kind === 'unknown-scale') {
      return `${issue.detail}${measure}`;
    }
    return `3D preview unavailable on this device.${measure}`;
  }

  /**
   * GLTFLoader reports "failed to load" and almost nothing else, so when it
   * fails, ask the server directly what happened. Only on the failure path —
   * a model that loads costs nothing extra.
   */
  async function diagnoseModelFailure(modelPath, error) {
    try {
      const response = await fetch(modelPath, { method: 'HEAD', cache: 'no-store' });
      if (!response.ok) {
        const type = response.headers.get('content-type') || '';
        return { kind: 'fetch-failed', status: response.status, html: /text\/html/i.test(type) };
      }
      const type = response.headers.get('content-type') || '';
      // 200, but HTML: an interstitial (SSO, a protection page) standing in
      // for the file. The loader sees bytes that are not a model.
      if (/text\/html/i.test(type)) {
        return { kind: 'fetch-failed', status: response.status, html: true };
      }
      // A compressed model with no decoder attached fails the same way a
      // broken file does, and three.js says which — "No DRACOLoader instance
      // provided". Telling someone their file is corrupt when it is fine and
      // merely compressed sends them re-exporting a model that was never the
      // problem, so the two are separated by what the loader actually said.
      if (/DRACOLoader|KHR_draco|meshopt|EXT_meshopt|KTX2|KHR_texture_basisu/i.test(error?.message || '')) {
        return { kind: 'no-decoder', detail: error?.message || '' };
      }
      return { kind: 'parse-failed', detail: error?.message || '' };
    } catch (headError) {
      return { kind: 'network', detail: headError?.message || error?.message || '' };
    }
  }

  async function loadScaledModel(product) {
    state.modelIssue = null;
    if (!THREE) await loadThreeJS();
    if (!THREE || !GLTFLoader) {
      state.modelIssue = { kind: 'no-three' };
      return null;
    }

    const modelPath = product.modelGlb;
    if (!modelPath) {
      state.modelIssue = { kind: 'no-model' };
      return null;
    }

    try {
      const loader = new GLTFLoader();
      // Harmless when the model is uncompressed; the loader only calls a
      // decoder if the file declares the matching extension.
      if (dracoLoader) loader.setDRACOLoader(dracoLoader);
      if (meshoptDecoder) loader.setMeshoptDecoder(meshoptDecoder);
      const gltf = await new Promise((resolve, reject) => {
        loader.load(
          modelPath,
          resolve,
          undefined,
          reject
        );
      });

      const model = gltf.scene;
      
      // Ensure vertex colors are used only when the geometry actually carries a
      // COLOR_0 attribute. Forcing it on a textured model (no colour attribute)
      // leaves the shader without that attribute and renders the mesh black.
      model.traverse(node => {
        if (!node.isMesh || !node.material) return;
        const hasVertexColors = !!node.geometry?.getAttribute?.('color');
        const materials = Array.isArray(node.material) ? node.material : [node.material];
        materials.forEach(mat => {
          if (mat.vertexColors !== hasVertexColors) {
            mat.vertexColors = hasVertexColors;
            mat.needsUpdate = true;
          }
          if (mat.map) mat.map.colorSpace = THREE.SRGBColorSpace;
        });
      });

      /*
         How big is this, really? One question, answered in one place
         (lib/spatial/model-scale.mjs), and the answer is always ONE factor.

         This used to compute three independent factors and apply them, which
         forced the mesh into whatever box the shop had typed — squeezing the
         cane-back armchair, whose geometry measures 79.3 × 88.5 × 100.0 cm,
         into a listed 70 × 78 × 88. The shopper then judged a piece of
         furniture that does not exist, and the fit verdict answered for it.

         glTF's unit is the metre, so a correct export already carries true
         scale and is the only measured quantity here; the typed dimensions
         are a human's claim about the same object. The claim is now a
         cross-check that surfaces disagreement, not an instruction that
         silently overrules the geometry.
      */
      const bbox = new THREE.Box3().setFromObject(model);
      const size = bbox.getSize(new THREE.Vector3());
      const decision = resolveScale({
        meshExtent: { width: size.x, depth: size.z, height: size.y },
        declaredCm: product.dimensions,
        overrideCm: product.modelBounds || null
      });
      state.scaleDecision = decision;

      if (!decision.usable) {
        // No honest size exists for this file, so it is not placed in anyone's
        // room at a guessed one. §24: never silently return false data.
        state.modelIssue = { kind: 'unknown-scale', detail: decision.message };
        console.error(`[AR] ${product.name}: ${decision.message}`);
        return null;
      }

      model.scale.setScalar(decision.scale);
      if (decision.verdict !== 'agrees') console.warn(`[AR] ${product.name}: ${decision.message}`);

      const scaledBbox = new THREE.Box3().setFromObject(model);
      const center = scaledBbox.getCenter(new THREE.Vector3());
      model.position.x = -center.x;
      model.position.y = -scaledBbox.min.y;
      model.position.z = -center.z;

      // Store original materials for later restoration during flat-surface detection
      model.traverse(child => {
        if (child instanceof THREE.Mesh && child.material) {
          child.userData.originalMaterial = Array.isArray(child.material) 
            ? child.material.slice() 
            : child.material;
        }
      });

      const shown = decision.actualCm;
      console.log(
        `[AR] ${product.name} at ${shown.width}×${shown.depth}×${shown.height} cm ` +
        `(×${decision.scale.toFixed(4)} from ${decision.units.unit}, source: ${decision.source})`
      );
      return model;
    } catch (error) {
      state.modelIssue = await diagnoseModelFailure(modelPath, error);
      console.error(`[AR] Could not load ${modelPath}:`, state.modelIssue, error?.name, error?.message);
      return null;
    }
  }

  async function loadGLBModel(product) {
    state.loadedModel = await loadScaledModel(product);
    state.modelBounds = state.loadedModel ? { product: product.id } : null;
  }

  async function startNativeAR() {
    setARMode('native-ar');
    const root = $('#ar-experience');
    
    // Flat-surface detection state
    let isSurfaceFlat = false;
    let recentHitHeights = []; // Rolling buffer of Y-position samples (last 10 frames)
    const flatnessThreshold = 0.015; // ~1.5 cm variance threshold
    
    let session;
    try {
      // Try with hit-test as required
      session = await navigator.xr.requestSession('immersive-ar', {
        requiredFeatures: ['hit-test'],
        // Both stay OPTIONAL. Requiring plane-detection would deny a session
        // to every device that can still measure perfectly well by tapping
        // two points; requiring depth-sensing would deny it to almost all of
        // them. What the session actually granted is read back below and
        // reported, rather than assumed from having asked.
        optionalFeatures: ['local-floor', 'dom-overlay', 'plane-detection', 'depth-sensing'],
        depthSensing: {
          usagePreference: ['cpu-optimized'],
          dataFormatPreference: ['luminance-alpha', 'float32']
        },
        domOverlay: { root }
      });
      state.hitTestRequired = true;
    } catch (error) {
      console.warn('[AR] hit-test required failed:', error?.name, error?.message, '— retrying without hit-test...');
      try {
        // Fallback: try without hit-test as required
        session = await navigator.xr.requestSession('immersive-ar', {
          optionalFeatures: [
            'hit-test', 'local-floor', 'dom-overlay', 'plane-detection', 'depth-sensing'
          ],
          depthSensing: {
            usagePreference: ['cpu-optimized'],
            dataFormatPreference: ['luminance-alpha', 'float32']
          },
          domOverlay: { root }
        });
        state.hitTestRequired = false;
      } catch (finalError) {
        // Log detailed diagnostics
        console.error('[AR] XR session request failed:', {
          errorName: finalError?.name,
          errorMessage: finalError?.message,
          errorCode: finalError?.code,
          isSecureContext: window.isSecureContext,
          xrAvailable: !!navigator.xr,
          timestamp: new Date().toISOString()
        });
        throw finalError;
      }
    }
    
    state.session = session;

    // Load THREE.js if needed
    if (!THREE) await loadThreeJS();

    const canvas = $('#xr-canvas');
    const gl = canvas.getContext('webgl2', { xrCompatible: true, alpha: true });
    if (!gl) {
      console.warn('[AR] WebGL2 not available, falling back to WebGL');
      const glFallback = canvas.getContext('webgl', { xrCompatible: true, alpha: true });
      if (glFallback) await glFallback.makeXRCompatible();
    } else {
      await gl.makeXRCompatible();
    }

    const layer = new XRWebGLLayer(session, gl);
    session.updateRenderState({ baseLayer: layer });
    const viewerSpace = await session.requestReferenceSpace('viewer');
    state.referenceSpace = await session.requestReferenceSpace('local');
    
    // Request hit-test if the session supports it
    if (state.hitTestRequired !== false) {
      try {
        state.hitTestSource = await session.requestHitTestSource({ space: viewerSpace });
      } catch (err) {
        console.warn('[AR] Hit-test source unavailable:', err?.name, err?.message);
        state.hitTestSource = null;
      }
    }

    const product = state.selected;
    const HINTS = {
      scan: 'Stand near the middle of the room and turn slowly through a half-circle.',
      placement: 'Find the floor, then place. Use the tray to move, turn, and resize.',
      area: 'Tap the corners of the free floor in order. Three or more, then close the outline.',
      clearance: 'Tap point A, then point B. The reading updates as you move.'
    };
    setHint(
      state.arPurpose === 'scan' ? HINTS.scan
        : state.arPurpose !== 'measurement' ? HINTS.placement
        : HINTS[state.measureMode] || HINTS.clearance
    );

    // The scan panel and its button only exist during a scan.
    const scanPanel = $('#scan-panel');
    if (scanPanel) scanPanel.hidden = state.arPurpose !== 'scan';
    const useRoom = $('#use-room');
    if (useRoom && state.arPurpose === 'scan') {
      useRoom.addEventListener('click', event => {
        event.stopPropagation();
        useScannedRoom();
      });
    }

    session.addEventListener('select', event => captureNativePoint(event.frame));
    session.addEventListener('end', cleanupAR);

    // Load GLB model if this product has one. A room scan has no product, and
    // loading one would only cost time and memory for something never drawn.
    if (product && state.arPurpose !== 'scan') await loadGLBModel(product);

    // Set up THREE.js rendering if model is available
    let renderer = null, scene = null, camera = null;
    const fallbackRenderer = arRenderer(gl);
    const [red, green, blue] = (colorFor(product).match(/[a-f\d]{2}/gi) || ['8c','9d','88']).map(value => parseInt(value, 16) / 255);

    let light = null;
    let dirLight = null;
    let placedModel = null;
    let baseScale = null;

    $('#ar-tray').hidden = state.arPurpose !== 'placement';
    /* The measurement modes get their own bottom-of-screen confirmation, so
       that finishing is a deliberate tap within thumb reach rather than a
       reach for the corner. The room scan already has "Use this room". */
    const useMeasurement = $('#use-measurement');
    if (useMeasurement) {
      useMeasurement.hidden = state.arPurpose !== 'measurement';
      useMeasurement.disabled = true;
    }

    // Tray actions are wired up whether or not a GLB loaded, so the box fallback
    // can still be placed and reset.
    $('#place-button').addEventListener('click', event => {
      event.stopPropagation();
      captureNativePoint(null);
    });
    /* Occlusion on/off. Worth offering because a plane detected slightly in
       front of the real wall will swallow a piece that is genuinely in the
       room, and somebody seeing that needs a way to rule it out. */
    const occlusionButton = $('#toggle-occlusion');
    if (occlusionButton) {
      occlusionButton.addEventListener('click', event => {
        event.stopPropagation();
        const next = occlusionButton.getAttribute('aria-pressed') !== 'true';
        occlusionButton.setAttribute('aria-pressed', String(next));
        xrayNet?.setOcclusion(next);
        setHint(next
          ? 'Real walls now hide furniture behind them.'
          : 'Occlusion off — furniture draws over everything.');
      });
    }

    $('#reset-model').addEventListener('click', event => {
      event.stopPropagation();
      arTransform.reset();
      state.placedMatrix = null;
      state.placementConfirmed = false;
      setPlacementButtonState(false);
      setHint('Reset. Find the floor and place again.');
    });

    /*
       The scene is needed whenever there is anything to draw, which now
       includes the x-ray net during a room scan.

       It used to be created only when a GLB had loaded, and the render call
       was gated on `arPurpose === 'placement'` — so in measurement mode the
       frame loop computed poses and drew nothing at all. The net has to
       appear over a room the person has not chosen a product for yet, so the
       gate is "is there anything to render", not "is there a model".
    */
    const wantsScene = Boolean(THREE) && (state.loadedModel || state.arPurpose === 'scan');

    if (wantsScene) {
      try {
        renderer = new THREE.WebGLRenderer({ canvas, context: gl, antialias: true, alpha: true });
        renderer.xr.enabled = true;
        renderer.xr.setSession(session);
        renderer.setPixelRatio(1);
        renderer.setClearColor(0x000000, 0);

        scene = new THREE.Scene();
        camera = new THREE.PerspectiveCamera(75, gl.canvas.width / gl.canvas.height, 0.01, 100);

        // Add lighting - hemisphere light for soft ambient illumination
        light = new THREE.HemisphereLight(0xffffff, 0x404040, 1.5);
        scene.add(light);

        // Add directional light for PBR materials
        dirLight = new THREE.DirectionalLight(0xffffff, 1);
        dirLight.position.set(5, 10, 5);
        scene.add(dirLight);

        state.xrRenderer = renderer;
        state.xrScene = scene;
        state.xrCamera = camera;
        state.xrLight = light;

        // Clone the loaded model for this session. A room scan runs with no
        // product chosen, so this is conditional now.
        if (state.loadedModel) {
          placedModel = state.loadedModel.clone();
          scene.add(placedModel);
          baseScale = placedModel.scale.clone();
        }

        // The net, drawn only over surfaces the device reports.
        xrayNet = createXrayNet({ THREE, scene });

      } catch (error) {
        console.error('[AR] THREE.js renderer unavailable:', error.message);
        renderer = null;
      }
    }

    function frame(time, xrFrame) {
      session.requestAnimationFrame(frame);
      const pose = xrFrame.getViewerPose(state.referenceSpace);

      /*
         No pose means the tracker has lost the room — moved too fast, pointed
         at a blank wall, lights off. The loop used to return here silently, so
         a scan simply froze with its last numbers on screen and no explanation.
         Saying so is the whole of §24: the reading stops being updated, and
         the panel says why and what to do about it.
      */
      if (!pose) {
        setTracking('lost');
        if (state.arPurpose === 'scan') {
          setHint('Tracking lost — move slowly and point at a surface with some texture.');
        }
        return;
      }
      setTracking(state.latestHitPose ? 'stable' : 'acquiring');

      const hits = state.hitTestSource ? xrFrame.getHitTestResults(state.hitTestSource) : [];
      state.latestHitPose = hits[0]?.getPose(state.referenceSpace) || null;

      // ===== FLAT-SURFACE DETECTION =====
      if (state.arPurpose === 'placement' && state.latestHitPose && !state.placementConfirmed) {
        // Method 1: Check XRPlaneSet if plane-detection is supported
        const planes = xrFrame.detectedPlanes;
        if (planes && planes.size > 0) {
          // Check if any detected plane at this hit position is horizontal (floor-like)
          const hitPos = state.latestHitPose.transform.position;
          isSurfaceFlat = false;
          
          for (const plane of planes) {
            if (plane.orientation === 'horizontal') {
              // Simple check: if a horizontal plane exists, assume current surface is flat
              isSurfaceFlat = true;
              break;
            }
          }
        } else {
          // Method 2: Fallback — sample Y-position variance over time
          const hitY = state.latestHitPose.transform.position.y;
          recentHitHeights.push(hitY);
          if (recentHitHeights.length > 10) recentHitHeights.shift(); // Keep last 10 samples
          
          if (recentHitHeights.length > 2) {
            const minY = Math.min(...recentHitHeights);
            const maxY = Math.max(...recentHitHeights);
            const yRange = maxY - minY;
            isSurfaceFlat = yRange < flatnessThreshold; // < 1.5 cm range = flat
          }
        }

        // Visual feedback on flatness. This also gates the place button, so it
        // runs whether or not a GLB is available for this product.
        setModelSurfaceState(placedModel, !isSurfaceFlat);
        setHint(isSurfaceFlat ? 'Flat surface found. Tap to place.' : 'Uneven surface — find a flatter spot.');
        state.placementBlocked = !isSurfaceFlat;
        setPlacementButtonState(!isSurfaceFlat);
      }
      // ===== END FLAT-SURFACE DETECTION =====

      // Viewer heading, so the tray's left/right follow wherever the phone faces.
      const viewerOrientation = pose.transform.orientation;
      state.viewerYaw = Math.atan2(
        2 * (viewerOrientation.w * viewerOrientation.y + viewerOrientation.x * viewerOrientation.z),
        1 - 2 * (viewerOrientation.y ** 2 + viewerOrientation.z ** 2)
      );

      /* ===== THE ROOM SCAN =====
         Planes in, room out. Runs whenever a net exists, because the surfaces
         it finds are useful for placement too — knowing where the floor is
         makes a placed piece sit on it rather than near it. */
      if (xrayNet) {
        const { supported, surfaces } = xrayNet.update(xrFrame, state.referenceSpace);

        // Recorded once, from what the session actually granted rather than
        // from what was asked for.
        if (state.netSupport.planes !== supported) state.netSupport.planes = supported;

        if (supported) {
          state.detectedSurfaces = surfaces;
          state.room = roomDimensions(surfaces);
        }

        // The depth layer, where the hardware has one. Tried per view because
        // depth is per-view; the first that yields is enough for the net.
        let depthLive = false;
        for (const view of pose.views) {
          if (xrayNet.updateDepth(xrFrame, view, state.referenceSpace, time)) {
            depthLive = true;
            break;
          }
        }
        if (state.netSupport.depth !== depthLive) state.netSupport.depth = depthLive;

        if (state.arPurpose === 'scan') {
          // Only count the sweep while the tracker actually has a pose: yaw
          // read during a tracking dropout is where the phone was, not where
          // it is, and would credit coverage that never happened.
          sweep.observe(state.viewerYaw);
          state.scanReadiness = scanReadiness(sweep, state.room);
          renderScanPanel();
          renderSurfaceLabels(
            state.detectedSurfaces,
            renderer?.xr.getCamera?.() || camera
          );
        }
      }

      // ===== REAL-TIME MEASUREMENT =====
      if (state.arPurpose === 'measurement') {
        const hitPos = state.latestHitPose?.transform.position;
        if (state.measureMode === 'area') {
          updateLiveAreaDisplay(hitPos, pose);
        } else if (hitPos && state.arPoints.length === 1) {
          const liveDistanceM = distanceBetween(state.arPoints[0], hitPos);
          const shown = updateLiveMeasurementDisplay(
            liveDistanceM,
            state.arNeedsConfirmation ? 'confirming span' : 'point A → target'
          );
          /*
             Feed the planner the SAME number the readout is showing.

             This used to pass the raw per-frame distance while the panel
             above showed something else, so the fit verdict flickered between
             "fits" and "needs more clearance" on tracker noise alone, and
             disagreed with the figure the user was reading at the time.

             And only once the reading has settled: a verdict computed from a
             value still visibly moving is a guess wearing a tick or a cross.
          */
          if (shown?.trustworthy) applyLiveClearance(shown.metres * 100);
        } else if (hitPos) {
          const viewerPos = pose.transform.position;
          updateLiveMeasurementDisplay(distanceBetween(viewerPos, hitPos), 'phone → surface');
        } else {
          hideLiveMeasurement();
        }
      } else {
        hideLiveMeasurement();
      }

      arTransform.tickSpin();

      /*
         A room scan has no product and no anchor — the net IS the render. It
         has to draw before the early return below, which exists to skip the
         placement path when there is nothing placed.
      */
      if (state.arPurpose === 'scan') {
        if (renderer && scene && camera) renderer.render(scene, camera);
        return;
      }

      const anchor = state.placedMatrix || state.latestHitPose?.transform.matrix;
      if (!anchor || state.arPurpose !== 'placement') return;

      if (renderer && scene && placedModel) {
        const anchorMatrix = new THREE.Matrix4().fromArray(anchor);
        const anchorPosition = new THREE.Vector3().setFromMatrixPosition(anchorMatrix);
        const anchorQuaternion = new THREE.Quaternion().setFromRotationMatrix(anchorMatrix);

        // Anchor pose + the tray's offset, heading and scale.
        placedModel.position.set(anchorPosition.x + arTransform.x, anchorPosition.y, anchorPosition.z + arTransform.z);
        placedModel.quaternion.copy(anchorQuaternion).multiply(userYawQuaternion());
        placedModel.scale.copy(baseScale);

        /*
           Where is this piece, relative to the room that was scanned?

           Only asked when a room HAS been scanned — placement without one
           still works exactly as before, and the panel below stays hidden
           rather than reporting against a room nobody measured.
        */
        if (state.scannedRoom?.rectangle) {
          const shown = state.scaleDecision?.actualCm || product.dimensions;
          const verdict = assessPlacement(
            state.scannedRoom,
            { width: shown.width / 100, depth: shown.depth / 100, height: shown.height / 100 },
            { x: placedModel.position.x, z: placedModel.position.z, yaw: arTransform.yaw },
            state.placedPieces,
            { clearance: clearancePref() }
          );
          renderPlacementVerdict(verdict);
        }

        // three.js drives the XR framebuffer, viewports and per-eye cameras itself.
        renderer.render(scene, camera);
        updatePlacementChip(placedModel, renderer.xr.getCamera?.() || camera, product);
        return;
      }

      /* Fallback cube when the GLB or THREE.js is unavailable.

         Two rules, both learned from watching a recording of this running on
         a real phone:

         1. It is only ever drawn while PLACING something. It used to draw in
            every purpose, so somebody measuring a doorway had a 200 × 100 ×
            123 cm cabinet — a piece they had not chosen — parked against the
            lens. Nothing belongs in front of the camera during a measurement
            except the room.

         2. It is drawn faintly. At alpha .72 a box that size is not an
            object in the room, it is a coat of paint over it: the floor being
            measured was a solid terracotta wash with the real world barely
            legible underneath. .28 keeps the volume readable as a volume and
            keeps the room visible through it, which is the whole point of
            holding a box up against a space.
      */
      if (state.arPurpose !== 'placement' || !product) return;
      gl.bindFramebuffer(gl.FRAMEBUFFER, layer.framebuffer);
      gl.clearColor(0, 0, 0, 0);
      gl.clear(gl.COLOR_BUFFER_BIT | gl.DEPTH_BUFFER_BIT);
      gl.enable(gl.DEPTH_TEST);
      const dimensions = product.dimensions;
      for (const view of pose.views) {
        const viewport = layer.getViewport(view);
        gl.viewport(viewport.x, viewport.y, viewport.width, viewport.height);
        const model = translateScale(anchor, arTransform.x, dimensions.height / 200, arTransform.z, dimensions.width / 200, dimensions.height / 200, dimensions.depth / 200);
        fallbackRenderer.draw(matrixMultiply(view.projectionMatrix, matrixMultiply(view.transform.inverse.matrix, model)), [red, green, blue, .28]);
      }
    }

    session.requestAnimationFrame(frame);
  }

  function captureNativePoint(frame) {
    const pose = state.latestHitPose;
    if (!pose) { toast('Move slowly until the floor target is detected, then tap again.'); return; }
    const point = pose.transform.position;
    if (state.arPurpose === 'placement') {
      if (state.placementBlocked || state.placementConfirmed) { toast('Uneven surface. Find a flatter spot.'); return; }
      state.placedMatrix = pose.transform.matrix.slice();
      state.placementConfirmed = true;
      setHint('Placed at true scale. Use the tray to adjust it.');
      setPlacementButtonState(false, true);
      toast(`${state.selected.name} placed at true scale.`);
      return;
    }

    if (state.measureMode === 'area') return captureAreaPoint(point);

    // Measurement mode: an initial scan, then a confirmatory scan of the same span.
    if (!state.arNeedsConfirmation) {
      state.arPoints.push({ x: point.x, y: point.y, z: point.z });
      if (state.arPoints.length === 1) {
        setHint('Point A set. Tap point B.');
        return;
      }
      state.arMeasurement = distanceBetween(state.arPoints[0], state.arPoints[1]) * 100;
      state.arNeedsConfirmation = true;
      state.arPoints = [];
      setHint(`First reading ${cm(state.arMeasurement)}. Scan the same span again to confirm.`);
      return;
    }

    state.arPoints.push({ x: point.x, y: point.y, z: point.z });
    if (state.arPoints.length === 1) {
      setHint('Point A set. Tap point B to finish the check.');
      return;
    }

    state.arConfirmationMeasurement = distanceBetween(state.arPoints[0], state.arPoints[1]) * 100;
    const percentDiff = Math.abs(state.arMeasurement - state.arConfirmationMeasurement) / state.arMeasurement * 100;

    if (percentDiff > 5) {
      setHint(`Readings differ by ${Math.round(percentDiff)}% (${cm(state.arMeasurement)} vs ${cm(state.arConfirmationMeasurement)}). Scan again.`);
      toast('Readings differ by more than 5%. Measure the span again.');
      state.arPoints = [];
      state.arNeedsConfirmation = false;
      state.arMeasurement = null;
      state.arConfirmationMeasurement = null;
      return;
    }

    const finalMeasurement = (state.arMeasurement + state.arConfirmationMeasurement) / 2;
    applyLiveClearance(finalMeasurement);
    toast(`Confirmed within 5%. Clearance ${cm(finalMeasurement)}.`);
    state.session?.end();

    state.arPoints = [];
    state.arMeasurement = null;
    state.arConfirmationMeasurement = null;
    state.arNeedsConfirmation = false;
  }


  /* ---------------------------------------------------------------------------
     Floor area scan

     Tap the corners of the free floor in order, then close the outline. The area
     is the shoelace of those points on the floor plane. Nothing is accepted
     until a second scan of the same floor agrees within 5%, and the points are
     checked for flatness so a tap that landed on a sofa cannot quietly inflate
     the answer. The mathematics live in geometry.js and are tested there.
  --------------------------------------------------------------------------- */

  function updateLiveAreaDisplay(hitPos, pose) {
    if (!geo) return;
    const points = state.arPoints;
    if (!points.length) {
      if (hitPos && pose) updateLiveMeasurementDisplay(distanceBetween(pose.transform.position, hitPos), 'phone → floor · tap the first corner');
      else hideLiveMeasurement();
      return;
    }
    // Preview the outline as if the reticle were the next corner.
    const preview = hitPos ? [...points, { x: hitPos.x, y: hitPos.y, z: hitPos.z }] : points;
    const area = geo.polygonArea(preview);
    // Count only the corners actually captured — the reticle is a preview, not a tap.
    showAreaReadout(area, points.length, geo.perimeter(preview));
  }

  function showAreaReadout(area, cornerCount, perimeterMetres) {
    const panel = $('#live-measurement');
    if (!panel) return;
    $('#live-m').textContent = geo.formatArea(area);
    $('#live-cm').textContent = `${cornerCount} ${cornerCount === 1 ? 'corner' : 'corners'}`;
    $('#live-mm').textContent = `${perimeterMetres.toFixed(2)} m around`;
    $('#live-caption').textContent = state.arNeedsConfirmation ? 'confirming the same floor' : 'tap corners, then close';
    panel.hidden = false;
  }

  function captureAreaPoint(point) {
    state.arPoints.push({ x: point.x, y: point.y, z: point.z });
    const count = state.arPoints.length;
    $('#close-outline').hidden = count < 3;
    setHint(count < 3
      ? `${count} of 3 corners. Keep tapping the edge of the free floor.`
      : `${count} corners. Tap more, or close the outline to read the area.`);
  }

  /* Closes the outline and either stores the first reading or reconciles it with
     the confirmatory one. */
  function closeAreaOutline() {
    if (!geo) return;
    const points = state.arPoints;
    if (points.length < 3) { toast('Tap at least three corners first.'); return; }

    const area = geo.polygonArea(points);
    const confidence = geo.areaConfidence({ points, difference: 0 });
    if (confidence.level === 'low') {
      toast(`Scan again — ${confidence.reasons[0]}.`);
      setHint(`Scan again: ${confidence.reasons[0]}.`);
      state.arPoints = [];
      $('#close-outline').hidden = true;
      return;
    }

    if (!state.arNeedsConfirmation) {
      state.arMeasurement = area;
      state.areaPoints = points.slice();
      state.arNeedsConfirmation = true;
      state.arPoints = [];
      $('#close-outline').hidden = true;
      setHint(`First reading ${geo.formatArea(area)}. Walk the same floor again to confirm.`);
      toast(`First reading ${geo.formatArea(area)}. Scan once more.`);
      return;
    }

    const reconciled = geo.reconcileReadings(state.arMeasurement, area);
    if (!reconciled.agrees) {
      setHint(`Readings differ by ${reconciled.difference.toFixed(0)}% (${geo.formatArea(state.arMeasurement)} vs ${geo.formatArea(area)}). Scan again.`);
      toast('The two scans differ by more than 5%. Measuring again.');
      resetAreaScan();
      return;
    }

    const accepted = reconciled.value;
    const finalConfidence = geo.areaConfidence({ points, difference: reconciled.difference });
    applyMeasuredArea(accepted, points, finalConfidence, reconciled.difference);
    toast(`Confirmed within ${reconciled.difference.toFixed(1)}%. Floor ${geo.formatArea(accepted)}.`);
    state.session?.end();
    resetAreaScan();
  }

  function resetAreaScan() {
    state.arPoints = [];
    state.areaPoints = [];
    state.arMeasurement = null;
    state.arNeedsConfirmation = false;
    const button = $('#close-outline');
    if (button) button.hidden = true;
  }

  /* Writes an accepted area into the planner, with the longest side so the plan
     view can draw the room at its real proportions. */
  function applyMeasuredArea(area, points, confidence, difference) {
    const field = $('#floor-area');
    if (!field) return;
    field.value = area.toFixed(2);
    armUseMeasurement();

    let longest = 0;
    for (let i = 0; i < points.length; i++) {
      longest = Math.max(longest, geo.distanceOnFloor(points[i], points[(i + 1) % points.length]));
    }
    if (longest > 0) $('#floor-span').value = Math.round(longest * 100);

    const note = $('#area-confidence');
    if (note) {
      note.textContent = confidence.level === 'high'
        ? `Confirmed to within ${difference.toFixed(1)}% across two scans.`
        : `Accepted, but check it: ${confidence.reasons[0] || 'the scans were not identical'}.`;
      note.dataset.level = confidence.level;
    }
    updateFitVerdict();
  }

  async function startCameraFallback() {
    const product = state.selected;
    const isPlacement = state.arPurpose === 'placement';
    const stage = $('#fallback-product');
    const cameraVideo = $('#camera-feed');

    setARMode('camera-preview');
    $('#xr-canvas').style.display = 'none';
    stage.style.display = 'block';
    cameraVideo.style.display = 'block';
    $('#ar-tray').hidden = !isPlacement;
    $('#ar-reticle').hidden = true;

    const hasCamera = await startCameraStream();
    if (hasCamera) {
      setHint(isPlacement
        ? 'Untracked preview. Use the tray to move, turn and resize.'
        : 'Drag across the opening. The reading follows your finger.');
    }

    // The preview is an unanchored, device-side approximation for judging fit.
    // Tracked room placement still comes from WebXR where the device supports it.
    const model = await loadScaledModel(product);
    const canvas = document.createElement('canvas');
    stage.innerHTML = '';
    stage.appendChild(canvas);

    // Only a missing WebGL2 context is genuinely about the device. Everything
    // else — no model uploaded, a model the server would not serve, a file
    // that is not a readable .glb — has its own sentence, because they have
    // their own fixes and none of them is "get a better phone".
    const webgl = canvas.getContext('webgl2', { alpha: true });
    if (!model || !THREE || !webgl) {
      setARMode('illustration-only');
      const message = !webgl
        ? 'This device cannot show the 3D preview — it has no WebGL2. Use the measurement fields to check fit.'
        : modelFailureMessage();
      stage.innerHTML = `<div class="fallback-message glass">${escapeHtml(message)}</div>`;
      $('#ar-tray').hidden = true;
      return;
    }

    const renderer = new THREE.WebGLRenderer({ canvas, antialias: true, alpha: true, powerPreference: 'high-performance', premultipliedAlpha: false });
    renderer.setClearColor(0x000000, 0);
    renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 2));
    renderer.outputColorSpace = THREE.SRGBColorSpace;

    const scene = new THREE.Scene();
    const camera = new THREE.PerspectiveCamera(46, 1, 0.01, 100);
    camera.position.set(0, 1.35, 2.6);
    camera.lookAt(0, 0.4, 0);

    scene.add(new THREE.HemisphereLight(0xffffff, 0x1a1a1a, 1.25));
    const key = new THREE.DirectionalLight(0xffffff, 1);
    key.position.set(2, 3, 2.5);
    scene.add(key);

    const modelRoot = model.clone();
    const baseScale = modelRoot.scale.clone();
    scene.add(modelRoot);

    // In measurement mode the product stays on screen as the scale reference the
    // ruler is calibrated against, so it is dimmed rather than removed.
    if (!isPlacement) {
      modelRoot.traverse(child => {
        if (!child.isMesh || !child.material) return;
        const materials = Array.isArray(child.material) ? child.material : [child.material];
        materials.forEach(material => { material.transparent = true; material.opacity = 0.35; });
      });
    }

    const resize = () => {
      if (!canvas.isConnected) return; // the AR layer was closed
      const width = window.innerWidth;
      const height = window.innerHeight;
      renderer.setSize(width, height, false);
      camera.aspect = width / height;
      camera.updateProjectionMatrix();
    };
    resize();
    window.addEventListener('resize', resize, { passive: true });

    let surfaceBlocked = false;
    let placementConfirmed = false;
    let previewTilt = 0;

    setPlacementButtonState(false);
    /* There is nothing to occlude with in the untracked preview: no planes,
       no depth, no idea where the walls are. The control is hidden rather
       than shown doing nothing. */
    const previewOcclusion = $('#toggle-occlusion');
    if (previewOcclusion) previewOcclusion.hidden = true;

    $('#reset-model').addEventListener('click', event => {
      event.stopPropagation();
      arTransform.reset();
      placementConfirmed = false;
      setPlacementButtonState(surfaceBlocked);
      setHint('Reset to true scale.');
    });
    $('#place-button').addEventListener('click', event => {
      event.stopPropagation();
      if (surfaceBlocked) return;
      placementConfirmed = true;
      setPlacementButtonState(false, true);
      setHint('Placed. Move around it to judge the fit.');
    });

    bindPreviewGestures(stage, () => placementConfirmed || !isPlacement);

    /*
       There is deliberately no ruler here any more.

       This view used to let you drag a finger across the picture and read off
       a distance in centimetres. The number came from
       `pixels / state.pixelsPerCm`, where the scale factor was obtained by
       projecting the VIRTUAL model's bounding box to screen space — so it was
       only ever valid at the exact depth the virtual chair happened to be
       floating at. Drag across a doorway three metres further back and the
       reading was badly wrong, with nothing to say so. It was labelled an
       "estimate", but it wrote into the same field as a tracked WebXR reading
       and drove the same fit verdict.

       A single camera with no tracking and no depth cannot measure a room.
       Pretending otherwise is the failure mode this whole feature exists to
       avoid, so the honest fallback is the measurement fields: a number the
       person got from a tape measure, which they know the provenance of.
    */
    if (!isPlacement) {
      setHint('This preview shows the piece at its real size, but cannot measure your room — '
        + 'this device has no AR tracking. Enter a tape-measure reading in the fields below.');
    }

    const tick = () => {
      if (!state.fallbackRender) return;
      arTransform.tickSpin();
      modelRoot.position.set(arTransform.x, 0, arTransform.z);
      modelRoot.rotation.y = arTransform.yaw;
      modelRoot.scale.copy(baseScale);

      const nextBlocked = Math.abs(previewTilt) > 45;
      if (nextBlocked !== surfaceBlocked) {
        surfaceBlocked = nextBlocked;
        setModelSurfaceState(modelRoot, surfaceBlocked);
        setPlacementButtonState(surfaceBlocked, placementConfirmed);
        setHint(surfaceBlocked ? 'Hold the phone level to judge the surface.' : 'Untracked preview. Use the tray to move, turn and resize.');
      }

      renderer.render(scene, camera);
      if (isPlacement) updatePlacementChip(modelRoot, camera, product);
      requestAnimationFrame(tick);
    };

    state.fallbackRender = { renderer, scene, camera, modelRoot, resize };
    tick();

    if (window.DeviceOrientationEvent) {
      window.addEventListener('deviceorientation', event => { previewTilt = event.beta || 0; }, { passive: true });
    }
  }

  /* Screen scale derived from the model's known true width at its current depth.
     It is what makes the preview ruler read in centimetres. */

  /* Touch gestures stay available and write into the same transform the tray
     uses, so the two never disagree. */
  function bindPreviewGestures(stage, isLocked) {
    let pinchDistance = null;
    let lastAngle = null;
    let lastPoint = null;

    stage.addEventListener('pointerdown', event => {
      if (isLocked()) return;
      stage.setPointerCapture(event.pointerId);
      lastPoint = { x: event.clientX, y: event.clientY };
    });

    stage.addEventListener('pointermove', event => {
      if (isLocked() || !lastPoint || !stage.hasPointerCapture?.(event.pointerId)) return;
      arTransform.x += (event.clientX - lastPoint.x) * 0.002;
      arTransform.z += (event.clientY - lastPoint.y) * 0.002;
      lastPoint = { x: event.clientX, y: event.clientY };
    });

    ['pointerup', 'pointercancel'].forEach(type => stage.addEventListener(type, () => { lastPoint = null; }));

    stage.addEventListener('wheel', event => {
      if (isLocked()) return;
      event.preventDefault();
      // Nothing: the wheel used to resize the piece. See arTransform.resize.
    }, { passive: false });

    stage.addEventListener('touchmove', event => {
      if (isLocked() || event.touches.length !== 2) return;
      const [a, b] = [event.touches[0], event.touches[1]];
      const distance = Math.hypot(a.clientX - b.clientX, a.clientY - b.clientY);
      const angle = Math.atan2(b.clientY - a.clientY, b.clientX - a.clientX);
      // Pinch turns the piece; it does not resize it. Resizing was the same
      // bug as the tray's scale buttons, reachable by a second route — a
      // shopper could pinch a sofa down until it fitted while the verdict
      // went on quoting the catalogue's real 210 cm.
      if (lastAngle !== null) arTransform.rotate(1, angle - lastAngle);
      pinchDistance = distance;
      lastAngle = angle;
    }, { passive: true });

    ['touchend', 'touchcancel'].forEach(type => stage.addEventListener(type, () => { pinchDistance = null; lastAngle = null; }, { passive: true }));
  }


  /* Opens the rear camera for the preview layer. */
  async function startCameraStream() {
    const feed = $('#camera-feed');
    if (!navigator.mediaDevices?.getUserMedia) {
      feed.style.display = 'none';
      setARMode('illustration-only');
      setHint('No camera on this device. Use the measurement fields instead.');
      return false;
    }
    try {
      state.cameraStream = await navigator.mediaDevices.getUserMedia({ video: { facingMode: { ideal: 'environment' } }, audio: false });
      feed.srcObject = state.cameraStream;
      return true;
    } catch {
      feed.style.display = 'none';
      setARMode('illustration-only');
      setHint('Camera permission denied. Use the measurement fields instead.');
      return false;
    }
  }

  async function startExperience(purpose) {
    /* Measuring a room is about the room, not about any one piece — you might
       well scan first and go shopping afterwards.

       Only PLACEMENT needs a product. This used to read `purpose !== 'scan'`,
       which caught the two-point and floor-area measurements as well and told
       anybody trying to measure a doorway to "Choose a product first". A
       doorway does not care what furniture you own. */
    if (purpose === 'placement' && !state.selected) return toast('Choose a piece to place first.');
    // A second tap before the first call reaches mountARExperience() would
    // insert nothing new — mountARExperience() reuses #ar-experience if it
    // already exists — but it would re-run addEventListener('click', ...) on
    // the SAME #close-outline button a second time, so one tap of "Close
    // outline" would fire closeAreaOutline() twice. The button that starts
    // this is disabled for exactly as long as this function is in flight.
    if (state.startingExperience) return;
    state.startingExperience = true;
    const arButton = $('#ar-button');
    if (arButton) arButton.disabled = true;
    try {
      await startExperienceInner(purpose);
    } finally {
      state.startingExperience = false;
      if (arButton) arButton.disabled = false;
    }
  }

  async function startExperienceInner(purpose) {
    const product = state.selected;
    const isIOS = /iPad|iPhone|iPod/.test(navigator.userAgent) || (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1);

    /* Quick Look renders a USDZ and hands nothing back to this page — no
       poses, no planes, no measurement. It is the right answer for "show me
       this chair on my floor" and completely the wrong one for "measure my
       room", so only a PLACEMENT goes down this path.

       This read `purpose !== 'scan'`, which sent the two-point and floor-area
       measurements to Quick Look on any iPhone — handing the user a 3D model
       viewer when they asked for a number, and, now that nothing is selected
       by default, dereferencing a null product on the way. */
    if (purpose === 'placement' && isIOS && product?.modelUsdz) {
      try {
        const response = await fetch(product.modelUsdz, { method: 'HEAD' });
        if (response.ok) {
          const quickLookLink = document.createElement('a');
          quickLookLink.rel = 'ar';
          quickLookLink.href = product.modelUsdz;
          quickLookLink.target = '_blank';
          quickLookLink.click();
          toast('Opening the native AR Quick Look viewer on iPhone Safari.');
          return;
        } else {
          console.warn(`[AR] USDZ file returned ${response.status} at ${product.modelUsdz}`, { url: product.modelUsdz });
        }
      } catch (err) {
        console.warn(`[AR] Could not verify USDZ availability (${err?.message}), falling back to WebXR/camera`, { url: product.modelUsdz, error: err?.message });
      }
    }

    mountARExperience();
    /* The header says what this session is DOING, not what happens to be
       selected back on the page.

       It used to read `if (product) → product.name`, which is how somebody
       measuring the gap under a doorway ended up with "Cabint 200 / 200 × 100
       × 123 cm" pinned over the camera. The piece is only the subject of the
       session when the session is placing it; the rest of the time the
       subject is the room. */
    const TITLES = {
      scan: ['Room scan', 'Turn slowly through a half-circle'],
      clearance: ['Measuring clearance', 'Tap point A, then point B'],
      area: ['Measuring floor area', 'Tap the corners of the free floor'],
      room: ['Room scan', 'Turn slowly through a half-circle']
    };
    if (purpose === 'placement' && product) {
      const { width, depth, height } = product.dimensions;
      $('#ar-product-name').textContent = product.name;
      $('#ar-product-dims').textContent = `${width} × ${depth} × ${height} cm`;
    } else {
      const [title, sub] = TITLES[purpose === 'scan' ? 'scan' : state.measureMode] || TITLES.scan;
      $('#ar-product-name').textContent = title;
      $('#ar-product-dims').textContent = sub;
    }
    state.arPurpose = purpose;
    if (purpose === 'scan') sweep.reset();
    if (purpose === 'measurement' && state.measureMode === 'area') resetAreaScan();
    state.arPoints = [];
    state.placedMatrix = null;
    state.placementBlocked = false;
    state.placementConfirmed = false;
    $('#camera-feed').style.display = '';
    $('#xr-canvas').style.display = '';
    $('#fallback-product').style.display = 'none';
    $('#ar-tray').hidden = purpose !== 'placement';
    try {
      const supportsAR = await checkARSupport();
      if (supportsAR) await startNativeAR(); else await startCameraFallback();
    } catch (error) {
      console.error('[AR] Native AR start failed:', {
        errorName: error?.name,
        errorMessage: error?.message,
        errorCode: error?.code,
        stack: error?.stack?.split('\n').slice(0, 3).join('\n'),
        timestamp: new Date().toISOString()
      });
      const messageMap = {
        NotAllowedError: 'Camera permission was denied. Enable camera access for this site and try again.',
        NotSupportedError: 'This device reports AR support but couldn\'t start a session — hit-test or the AR overlay isn\'t available here.',
        SecurityError: 'AR requires a secure, top-level browsing context — this won\'t work inside an embedded/in-app browser.',
        ReferenceError: 'XR capabilities not available on this browser.',
        TypeError: 'XR session initialization error — check console for details.'
      };
      await startCameraFallback();
      toast(messageMap[error?.name] || `Live AR could not start (${error?.name}); switched to camera preview.`);
    }
  }

  function cleanupAR() {
    state.hitTestSource?.cancel?.();
    state.hitTestSource = null;
    state.referenceSpace = null;
    state.latestHitPose = null;
    state.session = null;
    hideLiveMeasurement();

    /*
       The net owns geometry and shader materials of its own, and it holds a
       Map keyed by XRPlane objects belonging to the session that is ending.
       Disposed before the scene walk below, so its meshes are gone rather
       than disposed twice.
    */
    xrayNet?.dispose();
    xrayNet = null;
    sweep.reset();
    state.detectedSurfaces = [];
    state.scanReadiness = null;
    // state.room is deliberately kept: the measurement survives the session
    // that produced it, which is the point of taking it.

    const scanPanel = $('#scan-panel');
    if (scanPanel) scanPanel.hidden = true;
    const labels = $('#surface-labels');
    if (labels) labels.innerHTML = '';

    // Clean up THREE.js resources
    if (state.xrRenderer) {
      state.xrRenderer.dispose();
      state.xrRenderer = null;
    }
    if (state.xrScene) {
      state.xrScene.traverse(child => {
        if (child.geometry) child.geometry.dispose();
        if (child.material) {
          if (Array.isArray(child.material)) {
            child.material.forEach(mat => mat.dispose());
          } else {
            child.material.dispose();
          }
        }
      });
      state.xrScene = null;
    }
    state.xrCamera = null;
    state.xrLight = null;

    // Stops the preview render loop, which bails out as soon as this is cleared.
    state.fallbackRender?.renderer?.dispose();
    state.fallbackRender = null;
    state.viewerYaw = 0;

    state.cameraStream?.getTracks().forEach(track => track.stop());
    state.cameraStream = null;
    const feed = $('#camera-feed');
    if (feed) feed.srcObject = null;
    unmountARExperience();
    state.placedMatrix = null;
    state.placementConfirmed = false;

    state.arPoints = [];
    state.arMeasurement = null;
    state.arConfirmationMeasurement = null;
    state.arNeedsConfirmation = false;
  }

  /* ------------------------------------------------------------------ boot --
     What init() used to do for the planner, minus the catalogue and portal
     wiring that now lives in React. */

  state.products = products;
  /* An explicit ?product= wins outright, model or no model — see renderPlanner.
     With no request to honour, NOTHING is selected.

     It used to fall through to `products.find(item => item.modelGlb)`, so
     opening /plan from the nav silently armed the planner with a piece. That
     is the wrong default for a tool whose first job is to measure a room:
     the piece only matters once there is a room to put it in. */
  state.selected =
    products.find(item => item.id === selectedId || item.slug === selectedId)
    || null;

  await initGeometry();

  /* Whole-room is the default: it is what this product is for, and it needs
     nothing chosen first. Somebody who previously picked another mode keeps
     theirs. */
  let savedMode = 'room';
  try { savedMode = localStorage.getItem('furnishar-measure-mode') || 'room'; } catch { /* private mode */ }
  setMeasureMode(savedMode);

  const listeners = [];
  const on = (selector, event, handler) => {
    const element = $(selector);
    if (!element) return;
    element.addEventListener(event, handler);
    listeners.push(() => element.removeEventListener(event, handler));
  };

  on('#ar-button', 'click', () =>
    startExperience(state.measureMode === 'room' ? 'scan' : 'measurement'));
  $$('.mode-option').forEach(button => {
    const handler = () => setMeasureMode(button.dataset.measureMode);
    button.addEventListener('click', handler);
    listeners.push(() => button.removeEventListener('click', handler));
  });
  on('#close-outline', 'click', closeAreaOutline);
  ['#point-a', '#point-b'].forEach(selector => {
    on(selector, 'input', updateFitVerdict);
    on(selector, 'input', saveMeasurement);
  });
  ['#floor-area', '#floor-span'].forEach(selector => {
    on(selector, 'input', () => { updateFitVerdict(); saveMeasurement(); });
  });

  // Leaving the page with an XR session open would strand the camera.
  const onPopState = () => {
    if (!$('#ar-experience')) return;
    if (state.session) state.session.end().catch(cleanupAR);
    else cleanupAR();
  };
  window.addEventListener('popstate', onPopState);

  // Scan settings: the unit switch and the clearance field. Both change a
  // real calculation, so both re-run the readouts that depend on them.
  /* on() takes a selector and registers its own teardown, so these bind
     directly and push their own — there are three buttons and no id between
     them. */
  $$('.unit-option').forEach(button => {
    const handler = () => setUnits(button.dataset.unit);
    button.addEventListener('click', handler);
    listeners.push(() => button.removeEventListener('click', handler));
  });
  on('#clearance-pref', 'input', () => { updateFitVerdict(); renderScanPanel(); });
  try { setUnits(localStorage.getItem('furnishar-units') || 'm'); } catch { setUnits('m'); }

  restoreMeasurement();
  renderPlanner();
  await loadThreeJS();
  await checkARSupport();

  /*
     A seam for testing the room scan, because CI has no XR device.

     Everything downstream of "here are the surfaces WebXR found" is ordinary
     code, and it is the part most likely to break — the derivation, the
     panel, the verdict, the kept result. This hands synthetic surfaces to
     exactly the same functions the frame loop calls, so a check can drive a
     whole scan and assert what a person would see.

     It is a way to TEST the pipeline, never a way to fake a measurement for
     somebody: it writes only to the same state the real scan writes, is
     driven by the test rather than by the app, and nothing in the product
     calls it.
  */
  window.__furnisharScan = {
    // The panel is part of what is under test, and renderScanPanel() skips a
    // hidden one, so a test opens it the way an AR session would.
    openPanel() {
      mountARExperience();
      const panel = $('#scan-panel');
      if (panel) panel.hidden = false;
      return Boolean(panel);
    },
    feed(surfaces) {
      state.detectedSurfaces = surfaces;
      state.room = roomDimensions(surfaces);
      state.netSupport.planes = true;
      state.scanReadiness = scanReadiness(sweep, state.room);
      renderScanPanel();
      return state.room;
    },
    sweepTo(degrees) {
      for (let d = 0; d <= degrees; d += 2) sweep.observe((d * Math.PI) / 180);
      state.scanReadiness = scanReadiness(sweep, state.room);
      renderScanPanel();
      return { degrees: sweep.degrees, fraction: sweep.fraction };
    },
    accept() { useScannedRoom(); },
    get state() {
      return {
        room: state.room,
        scannedRoom: state.scannedRoom,
        readiness: state.scanReadiness,
        netSupport: state.netSupport,
        sweep: { degrees: sweep.degrees, guidance: sweep.guidance() }
      };
    },
    reset() {
      sweep.reset();
      state.room = null;
      state.scannedRoom = null;
      state.detectedSurfaces = [];
      state.scanReadiness = null;
    }
  };

  if (autoStart) startExperience('placement');

  return function teardown() {
    window.removeEventListener('popstate', onPopState);
    delete window.__furnisharScan;
    listeners.forEach(off => off());
    if (state.session) state.session.end().catch(cleanupAR);
    else if ($('#ar-experience')) cleanupAR();
  };
}
