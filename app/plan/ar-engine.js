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

import { SCALE_STATUS } from '../../lib/spatial/model-scale.mjs';
import { normalizeModel } from '../../lib/spatial/model-transform.mjs';
import { formatDimensions, formatFootprint, FURNITURE_UNITS } from '../../lib/spatial/units.mjs';
import { OneEuroFilter, Steadiness, displayPrecision } from '../../lib/spatial/smoothing.mjs';
import { roomDimensions, fitInRoom, minimumAreaRectangle } from '../../lib/spatial/room.mjs';
import { SweepCoverage, scanReadiness } from '../../lib/spatial/coverage.mjs';
import { assessPlacement, snapInsideRoom } from '../../lib/spatial/placement.mjs';
import { createXrayNet } from './xray-net.js';
import { notify, dismiss } from '../../lib/alerts/store.mjs';
import { catalog } from '../../lib/alerts/messages.mjs';
import {
  browserContext, browserHandoff, sessionInit, minimalSessionInit, classifyRefusal, DIAG, DIAG_COPY
} from '../../lib/spatial/capabilities.mjs';
import {
  HitSampler, evaluateTarget, FloorReference, roomAcceptance, compareScans,
  normalFromOrientation, TARGET
} from '../../lib/spatial/hit-sampler.mjs';
import { isSimplePolygon } from '../../public/geometry.js';

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

  /* Tracked capture. A corner, a placement or a floor-area point is taken
     from a short window of hits (hit-sampler.mjs), never from the one frame
     the thumb lands on, and the floor height is established once and every
     later corner checked against it. */
  const hitSampler = new HitSampler();
  const floorRef = new FloorReference();
  /* How this browser context should be treated, read once. The in-app
     check runs before any AR is attempted. */
  const context = typeof navigator === 'undefined'
    ? { platform: 'other', inAppBrowser: null }
    : browserContext(navigator.userAgent, { maxTouchPoints: navigator.maxTouchPoints, platform: navigator.platform });

  /* ===== Planner state and DOM helpers ===== */
  const state = {
    products: [],
    stores: {},
    selected: null,
    /* The selected piece's model access: its signed URL while fresh, or the
       reason there is none. See checkModelAccess(). */
    modelAccess: null,
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
    // How furniture sizes are WRITTEN in the AR readout: cm, in or ft. Text
    // only. It never touches model.scale, the fit check or placement — those
    // read product.dimensions, in centimetres, and nothing else.
    dimensionUnit: 'cm',
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
    // Floor corners tapped by hand, and the optional ceiling tap. This is the
    // measurement path that works without plane detection.
    roomTaps: { corners: [], ceilingY: null, closed: false },
    // Completed tapped scans of this room. The room is used only once a
    // second, independent scan agrees with the first (repeatability).
    roomScans: [],
    roomConfirmed: false,
    // The current reticle verdict, from evaluateTarget(): the one thing that
    // gates placing and capturing.
    target: { state: 'searching', reason: null },
    estimate: null,
    // Set when the last tracked-AR attempt was refused. The next tap on the
    // AR button tries the minimal configuration: a new request from a new
    // gesture, never a second request inside the first one's handler.
    retryMinimal: false,
    floorOrigin: false,
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
    <!-- The reticle is the ONLY thing that changes colour to say whether the
         target is good: white searching, green a valid floor, amber not yet
         certain, red not a floor. The room is never tinted. -->
    <div id="ar-reticle" class="ar-reticle" data-state="searching" aria-hidden="true"><span></span></div>
    <div id="ar-anchor-chip" class="ar-anchor-chip glass" hidden><b id="anchor-primary"></b><i id="anchor-secondary"></i></div>
    <header class="ar-bar">
      <button id="exit-ar" class="ar-chip glass ar-chip-button" aria-label="Close the camera">Close</button>
      <div class="ar-title glass">
        <strong id="ar-product-name"></strong>
        <span id="ar-product-dims"></span>
      </div>
      <span id="ar-mode-indicator" class="ar-chip glass ar-tracking" role="status" aria-live="polite" data-state="searching">Searching</span>
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
        <div><dt>Corners</dt><dd id="found-floor">0</dd></div>
        <div><dt>Walls</dt><dd id="found-walls">—</dd></div>
        <div><dt>Height</dt><dd id="found-height">—</dd></div>
        <div><dt>Sweep</dt><dd id="found-sweep">0°</dd></div>
      </dl>

      <!-- The tap-to-measure controls. The room scan used to depend entirely
           on WebXR plane detection, which Chrome for Android does not ship
           outside a flag — so on an ordinary phone the sweep filled up and
           nothing was ever measured. Tapping corners runs on hit-test, which
           every WebXR device has. -->
      <div class="scan-actions">
        <button id="close-room" class="ar-outline-button glass" hidden>Close the floor</button>
        <button id="undo-corner" class="ar-outline-button glass" hidden>Undo corner</button>
      </div>

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
    <!-- One instruction at a time. Troubleshooting lives on /diagnose, not
         in a paragraph over the camera. -->
    <p id="ar-mode-label" class="ar-hint glass" role="status" aria-live="polite"></p>
    <!-- Finishing a two-point or floor-area measurement had no control of its
         own: the only way out was "Close" in the top-right corner, which is
         both the hardest place on the screen to reach one-handed and a word
         that sounds like discarding the reading rather than keeping it. The
         number was in fact already saved, so the button confirms what has
         happened rather than performing it. -->
    <button id="use-measurement" class="ar-outline-button glass" hidden disabled>Use this measurement</button>
    <button id="close-outline" class="ar-outline-button glass" hidden>Close outline</button>
    <!-- Revealed only after the piece is placed. Before that, the only
         control is Place. -->
    <div id="ar-tray" class="ar-tray glass" role="group" aria-label="Adjust the placed piece" hidden>
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
          <button class="tray-btn" data-step="rotate" data-dir="1" aria-label="Rotate right">↻</button>
        </div>
      </div>
      <!-- There is no scale control, deliberately. See arTransform.resize. -->
      <div class="tray-cluster" data-cluster="view">
        <span class="tray-label">View</span>
        <div class="tray-row">
          <button class="tray-btn tray-wide" id="reset-model" aria-label="Reset: pick the piece up and place it again">Reset</button>
          <button class="tray-btn" id="dimension-unit" aria-label="Sizes in centimetres. Switch unit">cm</button>
          <!-- Only shown when the device reports walls or depth to occlude with. -->
          <button class="tray-btn tray-wide" id="toggle-occlusion" aria-pressed="true" hidden
            aria-label="Hide furniture behind real walls">Occlusion</button>
        </div>
      </div>
    </div>
    <!-- The one primary action in the thumb zone: Place, or Add corner /
         Add point while measuring. Enabled only when the target under the
         reticle is a valid floor, held still. -->
    <button id="place-button" class="ar-place" aria-label="Place" disabled><span></span></button>
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

    /* cm → in → ft → cm. Changes how the size chip is written, nothing else:
       the piece in the room stays exactly the size it was. */
    const UNIT_NAMES = { cm: 'centimetres', in: 'inches', ft: 'feet' };
    $('#dimension-unit').addEventListener('click', () => {
      const ids = FURNITURE_UNITS.map(unit => unit.id);
      state.dimensionUnit = ids[(ids.indexOf(state.dimensionUnit) + 1) % ids.length];
      const button = $('#dimension-unit');
      button.textContent = state.dimensionUnit;
      button.setAttribute('aria-label', `Sizes in ${UNIT_NAMES[state.dimensionUnit]}. Switch unit`);
    });
  }

  function setARMode(mode) {
    state.arMode = mode;
    const indicator = $('#ar-mode-indicator');
    if (!indicator) return;
    indicator.dataset.mode = mode;
    /* Only tracked AR has a tracking state. The camera preview is labelled
       for what it is, every time it is on screen: not anchored, not to scale
       in the room, not a fit check. */
    if (mode === 'camera-preview') { indicator.textContent = 'Untracked preview'; indicator.dataset.state = 'untracked'; }
    else if (mode === 'illustration-only') { indicator.textContent = 'No camera'; indicator.dataset.state = 'untracked'; }
    else setTracking('acquiring', true);
  }

  /* One line of instruction, rewritten at most a few times a second. The
     frame loop runs at the session's rate; a sentence that changes 60 times
     a second cannot be read and costs a layout each time. */
  let lastHintAt = 0;
  let pendingHint = null;
  function setHint(text, { urgent = true } = {}) {
    const hint = $('#ar-mode-label');
    if (!hint || hint.textContent === text) { pendingHint = null; return; }
    const now = performance.now();
    if (!urgent && now - lastHintAt < 250) { pendingHint = text; return; }
    hint.textContent = text;
    lastHintAt = now;
    pendingHint = null;
  }
  /* Called from the frame loop: lets a throttled hint land once its turn comes. */
  function flushHint() {
    if (pendingHint !== null && performance.now() - lastHintAt >= 250) setHint(pendingHint);
  }

  /* The reticle carries the target's state; nothing else is recoloured. */
  function setReticleState(targetState) {
    const reticle = $('#ar-reticle');
    if (reticle && reticle.dataset.state !== targetState) reticle.dataset.state = targetState;
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
  /* Searching until a valid floor is under the reticle, "Floor found" only
     then: a hit somewhere is not a floor. */
  const TRACKING_WORDS = { stable: 'Floor found', acquiring: 'Searching', lost: 'Tracking lost' };
  function setTracking(nextState, force = false) {
    for (const node of [$('#scan-tracking'), $('#ar-mode-indicator')]) {
      if (!node) continue;
      if (node === $('#ar-mode-indicator') && !force && state.arMode !== 'native-ar') continue;
      if (node.dataset.state === nextState && !force) continue;
      node.dataset.state = nextState;
      node.textContent = TRACKING_WORDS[nextState] || '';
    }
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

    /* Two ways to measure a room, and the panel reports whichever is in use.
       Tapping is the one that works on a phone without plane detection, so
       the readouts lead with the corner count rather than with a "Looking…"
       that would never resolve. */
    const taps = state.roomTaps || { corners: [], closed: false };
    const tapping = taps.corners.length > 0;

    set('#found-floor', tapping
      ? (taps.closed ? `${taps.corners.length} ✓` : String(taps.corners.length))
      : (room?.rectangle ? 'Found' : 'Looking…'));
    set('#found-walls', tapping ? '—' : (room ? `${room.walls} found` : '—'));
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

    /* ONE instruction: the next thing to do, nothing else. */
    const scanNumber = (state.roomScans?.length || 0) + (taps.closed ? 0 : 1);
    // The target's own reason wins while it is not usable: that is the
    // instruction that matters right now, and there is only one line.
    const targetReason = state.arMode === 'native-ar' && !taps.closed && !state.roomConfirmed
      && state.target && state.target.state !== TARGET.VALID ? state.target.reason : null;
    set('#scan-guidance', targetReason ? targetReason : state.roomConfirmed
      ? 'Two scans agree. Use this room.'
      : tapping
        ? (taps.closed
          ? (readiness?.firstScanDone ? 'Tap the ceiling for the height, or scan again to confirm.' : 'Close the outline.')
          : `Scan ${scanNumber}: corner ${taps.corners.length} placed. Turn to the next corner, hold still, tap.`)
        : readiness?.firstScanDone
          ? 'Scan 2: tap the same corners again, in the same order.'
          : (state.netSupport.planes ? sweep.guidance() : 'Move slowly until the floor is found, then aim at corner 1.'));
    renderSweepArc(sweep);
    // The sweep only means something where planes are detected.
    const planesLive = String(Boolean(state.netSupport.planes));
    if (panel.dataset.planes !== planesLive) panel.dataset.planes = planesLive;

    // What the device cannot do is said once, plainly, rather than left for
    // somebody to infer from a panel that never fills in.
    const notes = [];
    if (!state.netSupport.planes && !tapping) {
      /* This used to read "the room cannot be measured automatically here.
         Tap two points to measure a span instead" — which was true of the
         plane path and, on a phone without plane detection, amounted to
         telling somebody the room scanner could not scan their room. It can:
         by tapping its corners. The note now says how. */
      notes.push('This browser does not detect surfaces on its own, so the room is measured by tapping: aim at each corner where the floor meets a wall and tap it.');
    } else if (state.netSupport.planes && !state.netSupport.depth) {
      notes.push('No depth sensor on this device — the net follows detected walls and floor only, not furniture.');
    }
    if (room?.heightSource === 'wall-extent') {
      notes.push('Height is measured to the top of the tallest wall scanned, which may be short of the ceiling.');
    }
    set('#scan-note', notes.join(' '));

    const useRoom = $('#use-room');
    if (useRoom) {
      const ready = Boolean(readiness?.ready);
      /* A tapped room has two stages: the first accepted scan offers "Scan
         again to confirm"; only an agreeing second scan offers "Use this
         room". Enough points is never enough on its own. */
      const confirmStep = readiness?.method === 'tap' && readiness.firstScanDone && !ready && taps.closed;
      const enabled = ready || confirmStep;
      if (useRoom.disabled === enabled) useRoom.disabled = !enabled;
      const label = ready
        ? 'Use this room'
        : confirmStep
          ? 'Scan again to confirm'
          : readiness?.reason && tapping ? readiness.reason : 'Use this room';
      if (useRoom.textContent !== label) useRoom.textContent = label;
      useRoom.dataset.action = ready ? 'use' : confirmStep ? 'confirm' : 'none';
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
    /* Which method produced these numbers, and what agreement between two
       scans does and does not mean. */
    const METHOD_NOTE = {
      'webxr-hit-test': 'Measured by tracked AR, tapping the corners.',
      'manual': 'Typed in from a tape measure.',
      'aim': 'Measured by aiming the phone (tilt sensor and compass).',
      'photo': 'Measured from photos with a reference of known size.'
    };
    if (METHOD_NOTE[room.method]) notes.push(METHOD_NOTE[room.method]);
    if (room.repeatability) {
      notes.push(`Two scans agreed within ${Math.round(room.repeatability.worstMetres * 100)} cm. That shows the scan is repeatable, not that it matches a tape measure.`);
    }
    if (!room.height) notes.push('Wall height could not be determined — scan again including the walls to get it.');
    else if (room.heightSource === 'wall-extent') notes.push('Height measured to the top of the tallest wall scanned, which may be short of the ceiling.');
    if (!room.method && room.walls < 4) notes.push(`${room.walls} of the room's walls were detected, so the floor may extend further than measured.`);
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
  /* =============== the tap-measured room ===============================

     Why this exists at all.

     The room scan was built on `frame.detectedPlanes` — the WebXR Plane
     Detection API. On paper that is the right tool: the device's own tracker
     hands you real planes with real extents. In practice Chrome for Android
     does not ship it outside chrome://flags/#webxr-incubations, so on an
     ordinary phone `detectedPlanes` is undefined, `supported` comes back
     false, `state.room` is never assigned, and the scan can never finish.
     The sweep arc filled up and the room was never measured. The headline
     feature of this product was built on an API the target device does not
     have.

     Hit-test is different: it is in `requiredFeatures`, every WebXR runtime
     implements it, and it demonstrably works here — it is what the two-point
     measurement already uses. So the room is measured the way a tape measure
     would be: the person walks the room and taps each corner where the floor
     meets the wall, and each tap is a real point on a real surface.

     None of the geometry is new. The taps become a floor polygon, and that
     goes through the same convex hull, the same minimum-area rectangle and
     the same roomDimensions() that the plane path used — all of it already
     covered by tests/room.test.js. Plane detection, where a device does have
     it, still runs and still draws the net; it is an enhancement now rather
     than the foundation.
  */
  const MIN_CEILING_RISE = 1.5;   // a "ceiling" tap must clear the floor by this much

  function resetRoomTaps({ keepScans = false } = {}) {
    state.roomTaps = { corners: [], ceilingY: keepScans ? state.roomTaps?.ceilingY ?? null : null, closed: false };
    if (!keepScans) {
      state.roomScans = [];
      state.roomConfirmed = false;
      floorRef.reset();
    }
    syncRoomTapControls();
  }

  function syncRoomTapControls() {
    const taps = state.roomTaps;
    const close = $('#close-room');
    const undo = $('#undo-corner');
    if (close) {
      close.hidden = !taps || taps.closed || taps.corners.length < 3;
      close.textContent = 'Close the outline';
    }
    if (undo) undo.hidden = !taps || taps.closed || taps.corners.length === 0;
    const found = $('#found-floor');
    if (found && taps) found.textContent = taps.closed ? `${taps.corners.length} ✓` : String(taps.corners.length);
  }

  /* A tap during a room scan. Floor corners first, then one optional tap at
     the ceiling for the height.

     `point` is the robust estimate from the sampling window, never one
     frame's pose, and `spread` is how much that window moved. The seam in
     window.__furnisharScan passes points straight in, so a check can walk a
     room the way a person does. */
  function captureRoomCorner(point, spread = 0) {
    const taps = state.roomTaps;
    if (!taps) return;

    if (taps.closed) {
      /* The floor is closed, so this tap is the ceiling. A ceiling is usually
         featureless and hit-test often returns nothing up there at all, which
         is why height is optional rather than required: a room with an
         unmeasured height still reports its length, width, area and
         perimeter, and says the height is unknown instead of guessing one. */
      const floorY = floorRef.estimatedFloorY;
      if (floorY === null || point.y - floorY < MIN_CEILING_RISE) {
        toast('That is not the ceiling. Aim higher and tap again.', 'warning');
        return;
      }
      taps.ceilingY = point.y;
      buildTappedRoom();
      setHint(`Height ${metres(point.y - floorY)}.`);
      return;
    }

    /* Every corner after the first is checked against the floor the first
       one established. A table top, a bed, a shelf is refused with how far
       above the floor it is — not flattened onto the floor to make the
       outline close. */
    const check = floorRef.check(point);
    if (!check.ok) {
      toast(check.reason, 'warning');
      setHint(check.reason);
      return;
    }

    floorRef.accept(point);
    taps.corners.push({ x: point.x, y: point.y, z: point.z, spread });
    syncRoomTapControls();
    const count = taps.corners.length;
    const scanNumber = state.roomScans.length + 1;
    setHint(count < 3
      ? `Corner ${count}. Turn to corner ${count + 1}, hold still, then tap.`
      : `${count} corners. Tap the next corner, or close the outline.`);
    if (scanNumber === 2 && count === 1) setHint('Confirming: tap the same corners again, in the same order.');
    if (count >= 3) buildTappedRoom();
  }

  function closeTappedFloor() {
    const taps = state.roomTaps;
    if (!taps || taps.corners.length < 3) { toast('Tap at least three floor corners first.', 'warning'); return; }
    taps.closed = true;
    buildTappedRoom();
    const acceptance = tappedAcceptance();
    if (!acceptance.ready) {
      // Not usable as it stands; reopen so the person can undo and retap.
      taps.closed = false;
      buildTappedRoom();
      syncRoomTapControls();
      toast(acceptance.reason, 'warning');
      setHint(acceptance.reason);
      return;
    }
    syncRoomTapControls();

    /* A second scan confirms the first. Two scans agreeing is REPEATABILITY
       — the same hand, the same tracker — and is reported as that, never as
       accuracy against a tape measure. */
    if (state.roomScans.length === 0) {
      state.roomScans.push(state.room);
      setHint(`First scan ${metres(state.room.length)} × ${metres(state.room.width)}. Tap the ceiling for the height, or scan again to confirm.`);
    } else {
      /* Which earlier scan was right is not known when two disagree, so a
         new scan confirms if it agrees with ANY of them; the closest match
         is the one reported. */
      const comparisons = state.roomScans.map(earlier => compareScans(earlier, state.room));
      const comparison = comparisons.reduce((best, c) => (c.worst < best.worst ? c : best));
      if (!comparison.agrees) {
        toast(comparison.reason, 'warning');
        setHint(comparison.reason);
        state.roomScans = [...state.roomScans, state.room].slice(-3);
        state.roomConfirmed = false;
      } else {
        state.roomConfirmed = true;
        state.repeatability = comparison;
        setHint(`Confirmed: two scans agree within ${Math.round(comparison.worstMetres * 100)} cm. Use this room.`);
      }
    }
    state.scanReadiness = tappedReadiness();
    renderScanPanel();
  }

  /* "Scan again to confirm": the first scan is kept, the corners cleared,
     the floor height and any ceiling kept. */
  function startConfirmationScan() {
    if (!state.roomScans.length) return;
    resetRoomTaps({ keepScans: true });
    state.room = null;
    setHint('Confirming: tap the same corners again, in the same order.');
    state.scanReadiness = tappedReadiness();
    renderScanPanel();
  }

  function undoTappedCorner() {
    const taps = state.roomTaps;
    if (!taps || !taps.corners.length) return;
    taps.corners.pop();
    floorRef.remove();
    buildTappedRoom();
    syncRoomTapControls();
    setHint(`${taps.corners.length} corner${taps.corners.length === 1 ? '' : 's'}. Tap the next one.`);
  }

  /* The tapped points, turned into the same shape the plane path produced, so
     everything downstream — the panel, the fit verdict, the plan view,
     placement — is fed from one kind of room object and does not care which
     way it was measured. The floor is the ESTABLISHED floor height (the
     median of the accepted corners), not the lowest tap. */
  function buildTappedRoom() {
    const taps = state.roomTaps;
    if (!taps || taps.corners.length < 3) {
      state.room = null;
      state.scanReadiness = tappedReadiness();
      renderScanPanel();
      return;
    }

    const floorY = floorRef.estimatedFloorY ?? taps.corners[0].y;
    const surfaces = [{
      id: 'tapped-floor',
      orientation: 'horizontal',
      polygon: taps.corners.map(corner => ({ x: corner.x, y: floorY, z: corner.z }))
    }];

    if (taps.ceilingY !== null) {
      surfaces.push({
        id: 'tapped-ceiling',
        orientation: 'horizontal',
        polygon: taps.corners.map(corner => ({ x: corner.x, y: taps.ceilingY, z: corner.z }))
      });
    }

    /* minFloorArea defaults to 1 m², which is right for sifting real detected
       planes but wrong here: these points were deliberately placed by a
       person, so a genuinely small room must not be discarded as noise. */
    state.room = roomDimensions(surfaces, { minFloorArea: 0.5 });
    if (state.room) state.room.method = 'webxr-hit-test';
    state.detectedSurfaces = surfaces;
    state.scanReadiness = tappedReadiness();
    renderScanPanel();
  }

  function tappedAcceptance() {
    const taps = state.roomTaps || { corners: [], closed: false };
    const corners2d = taps.corners.map(c => ({ x: c.x, y: 0, z: c.z }));
    return roomAcceptance({
      corners: taps.corners,
      closed: taps.closed,
      simple: taps.corners.length < 4 || isSimplePolygon(corners2d),
      room: state.room,
      floor: floorRef
    });
  }

  /* Readiness for a tapped room: every acceptance check, plus a second scan
     that agrees with the first. Height stays optional. */
  function tappedReadiness() {
    const acceptance = tappedAcceptance();
    const hasFirst = state.roomScans.length > 0;
    const checks = [
      ...acceptance.checks.map(check => ({ key: check.key, ok: check.ok, label: check.reason })),
      { key: 'confirmed', ok: state.roomConfirmed, label: hasFirst ? 'scan again to confirm' : 'two scans that agree' }
    ];
    const blocking = checks.filter(check => !check.ok).map(check => check.key);
    return {
      ready: state.roomConfirmed && Boolean(state.room?.rectangle),
      firstScanDone: hasFirst,
      blocking,
      checks,
      reason: acceptance.reason,
      progress: checks.filter(check => check.ok).length / checks.length,
      // Named so the panel can say which way this room was measured, and so
      // nothing downstream has to guess.
      method: 'tap'
    };
  }

  function useScannedRoom() {
    const room = state.room;
    if (!room?.rectangle) return;
    if (state.roomConfirmed && state.repeatability) room.repeatability = state.repeatability;
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
    toast(`Room measured: ${metres(room.length)} × ${metres(room.width)}${room.height ? ` × ${metres(room.height)}` : ''}.`, 'success');
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
  function updatePlacementChip(model, camera, product, { untracked = false } = {}) {
    if (!THREE || !model) return positionAnchorChip(null);
    const box = new THREE.Box3().setFromObject(model);
    const top = new THREE.Vector3((box.min.x + box.max.x) / 2, box.max.y, (box.min.z + box.max.z) / 2);
    // The product's verified dimensions: the size the model was scaled to
    // (lib/spatial/model-transform.mjs), not the world-aligned box, which
    // grows diagonally as the piece turns. The unit only changes the writing.
    positionAnchorChip(
      projectToScreen(top, camera),
      formatDimensions(product.dimensions, state.dimensionUnit),
      // In the untracked preview the numbers are the listing, not what the
      // picture shows: the picture has no scale in the room.
      untracked ? 'Listed size · not to scale here' : `W × D × H · ${product.name}`
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
    if (button && state.arPurpose === 'measurement') button.hidden = false;
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
    $('#close-room').addEventListener('click', event => { event.stopPropagation(); closeTappedFloor(); });
    $('#undo-corner').addEventListener('click', event => { event.stopPropagation(); undoTappedCorner(); });
    /* The reading is already on the card — applyLiveClearance and the area
       scan write it as it changes — so this confirms and leaves rather than
       transferring anything. Saying so beats a silent exit that leaves people
       wondering whether the number survived. */
    $('#use-measurement').addEventListener('click', () => {
      const kept = state.measureMode === 'area'
        ? $('#measured-area')?.textContent
        : $('#measured-distance')?.textContent;
      if (state.session) state.session.end(); else cleanupAR();
      if (kept) toast(`Kept ${kept}. It is on your card.`, 'success');
    });
    document.addEventListener('keydown', onARKeydown);
    return experience;
  }

  function unmountARExperience() {
    document.removeEventListener('keydown', onARKeydown);
    $('#ar-experience')?.remove();
  }

  /*
     There used to be a setModelSurfaceState() here that swapped every mesh
     of the piece for a coral, 66% opaque material whenever the surface was
     not trusted. On a phone that is most of the screen painted over the very
     floor the person is trying to find (it showed in every field recording).
     The piece now always draws in its own materials, and the verdict lives
     on the reticle alone.
  */

  const CAPTURE_LABEL = { placement: 'Place', scan: 'Add corner', measurement: 'Add point' };
  function setPlacementButtonState(blocked, confirmed = false) {
    const button = $('#place-button');
    if (!button) return;
    const disabled = blocked || confirmed;
    if (button.disabled !== disabled) button.disabled = disabled;
    button.classList.toggle('is-confirmed', confirmed);
    const label = confirmed ? 'Placed' : (CAPTURE_LABEL[state.arPurpose] || 'Place');
    if (button.getAttribute('aria-label') !== label) button.setAttribute('aria-label', label);
    if (button.dataset.label !== label) button.dataset.label = label;
    // Once placed, the adjustments appear; before, they are not offered.
    const tray = $('#ar-tray');
    if (tray && state.arPurpose === 'placement') tray.hidden = !confirmed;
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
    if (state.selected?.modelGlb) checkModelAccess(state.selected);
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
              <small>${escapeHtml(formatDimensions(item.dimensions, 'cm'))} <span class="dims-key">W × D × H</span></small>
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
  /*
     Clearance was removed.

     It measured the gap across an opening — a doorway, a hallway — which is
     a different question from "how big is this room", and it was the first
     of the three tabs, so the scanner opened on the narrowest thing it can
     do. Floor area and whole room both answer the question the planner
     actually exists for. The clearance FIGURE is still used internally as
     walking space around a piece; only the scan mode is gone.
  */
  const MEASURE_MODES = {
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
    state.measureMode = MEASURE_MODES[mode] ? mode : 'room';
    const current = state.measureMode;
    $$('.mode-option').forEach(button => {
      const active = button.dataset.measureMode === current;
      button.classList.toggle('is-active', active);
      button.setAttribute('aria-checked', String(active));
    });

    // Each mode shows only the fields that belong to it, so there is never a
    // stale number visible from a mode you are no longer in.
    /* The manual width/height fields belonged to the clearance tab. They
         are kept available, because typing a known figure is still the most
         accurate input there is, but they are no longer tied to a mode that
         no longer exists. */
    const clearanceFields = $('#clearance-fields');
    if (clearanceFields) clearanceFields.hidden = false;
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
    $('#fit-plan-piece-label').textContent = formatFootprint(product.dimensions, 'cm');
  }


  /**
   * Scanner feedback, through the site's one notification system.
   *
   * This was a private toast with its own element and timer — so a message
   * raised here could collide with nothing and could not be styled, deduped
   * or announced like any other on the site. It now goes to
   * lib/alerts/store.mjs. The pace is kept: these are one-line coaching
   * during a scan ("aim higher", "room measured"), and 3.4s is what the
   * scanner was tuned to. One event still makes one message; the store's
   * dedup means tapping the wrong spot five times is one "aim higher", not
   * five stacked on the camera.
   */
  function toast(message, type = 'info') {
    notify({ type, message, duration: type === 'warning' ? 5000 : 3400 });
  }

  /* ===== Who may open a model =====
     A model is a reference (/api/sb/model/…) that the server trades for a
     five-minute signed URL only for a signed-in account the storage policy
     allows (0007, lib/supabase-proxy.js grantModelAccess). The trade happens
     when a piece is SELECTED, not when the camera button is tapped: WebXR
     needs the tap's user activation, and a network round trip between the
     tap and requestSession() can spend it. So the answer is ready — or the
     reason it is not has already been said — before anyone reaches for AR. */
  const ACCESS_FRESH_MS = 4 * 60 * 1000;   // signed URLs live 5 minutes

  function modelIssueFrom(error) {
    if (error?.code === 'auth_required') return { kind: 'auth-required' };
    if (error?.code === 'session_expired') return { kind: 'session-expired' };
    if (error?.code === 'unavailable') return { kind: 'forbidden' };
    if (error instanceof TypeError) return { kind: 'network' };
    return { kind: 'access-failed' };
  }

  async function resolveReference(reference) {
    if (!reference || !reference.startsWith('/api/sb/model/')) return reference;
    const { initBackend, supabase } = await import('../portal/backend.js');
    await initBackend();
    const sb = supabase();
    if (!sb?.resolveModelUrl) {
      const error = new Error('unconfigured'); error.code = 'upstream'; throw error;
    }
    return sb.resolveModelUrl(reference);
  }

  /** The signed URL for this product's model, from cache while it is fresh. */
  async function modelUrlFor(product, field = 'modelGlb') {
    const reference = product?.[field];
    const cached = state.modelAccess;
    if (cached && cached.reference === reference && cached.url && Date.now() - cached.at < ACCESS_FRESH_MS) {
      return cached.url;
    }
    const url = await resolveReference(reference);
    state.modelAccess = { reference, url, at: Date.now(), issue: null };
    return url;
  }

  /** Called on selection. Says why a model cannot open, once, before AR. */
  function checkModelAccess(product, announce = false) {
    const reference = product?.modelGlb;
    if (!reference || state.modelAccess?.reference === reference) return;
    state.modelAccess = { reference, url: null, at: 0, issue: null, pending: true };
    modelUrlFor(product).then(() => {
      /* Only after a retry: on an ordinary selection, the model being
         available is the expected case and says nothing. */
      if (announce) notify({ type: 'success', message: `${product.name} is ready to place in your room.` });
    }).catch(error => {
      state.modelAccess = { reference, url: null, at: 0, issue: modelIssueFrom(error) };
      raiseModelAlert(state.modelAccess.issue, product);
    });
  }

  /**
   * The words for a model that will not open, and the way out of it.
   * Every action here does something real: a sign-in that brings you back
   * to this exact piece, or a retry that runs the load again.
   */
  function raiseModelAlert(issue, product) {
    const here = `${window.location.pathname}${window.location.search}`;
    const signIn = `/login?as=buyer&next=${encodeURIComponent(here)}`;
    const retry = { label: 'Try again', onAction: () => { state.modelAccess = null; checkModelAccess(product, true); } };
    if (issue.kind === 'auth-required') {
      notify(catalog('auth.required', {
        actions: [{ label: 'Sign in', href: signIn }, { label: 'Create account', href: `${signIn}&mode=signup` }]
      }));
    } else if (issue.kind === 'session-expired') {
      notify(catalog('auth.expired', { actions: [{ label: 'Sign in again', href: signIn }] }));
    } else if (issue.kind === 'forbidden') {
      notify(catalog('model.forbidden', {
        actions: [{ label: 'Back to furniture', href: '/collection' }]
      }));
    } else if (issue.kind === 'network') {
      notify(catalog('net.offline', { actions: [retry] }));
    } else {
      notify(catalog('model.load-failed', { actions: [retry] }));
    }
  }


  /* ===== The AR engine ===== */
  /* The line under the button, and the hand-off out of an embedded browser.
     Written as markup because the hand-off is a real link. */
  function showInAppNotice() {
    const status = $('#ar-status');
    if (!status) return;
    const handoff = browserHandoff(context, window.location.href);
    const copy = DIAG_COPY[DIAG.IN_APP_BROWSER];
    status.innerHTML = `<b>${escapeHtml(copy.title)}.</b> ${escapeHtml(`You are in ${context.inAppName}'s built-in browser, which does not provide camera tracking. That says nothing about your phone.`)}
      ${handoff ? `<a class="button button-outline inapp-handoff" href="${escapeHtml(handoff.href)}">${escapeHtml(handoff.label)}</a>` : ''}
      <span class="inapp-steps">${escapeHtml(context.platform === 'ios'
        ? 'Or tap ··· or the share icon, then Open in Safari.'
        : 'Or tap ⋮ and choose Open in Chrome (or Open in browser).')}</span>`;
    status.dataset.state = 'in-app';
  }

  async function checkARSupport() {
    const status = $('#ar-status');
    /* An embedded browser is answered before anything else is asked of it:
       Messenger's webview is not a verdict on the phone. */
    if (context.inAppBrowser) {
      showInAppNotice();
      return false;
    }
    if (!window.isSecureContext) {
      status.textContent = 'Use HTTPS (or localhost) to enable camera and WebXR. Guided measurement is still available.';
      return false;
    }
    if (context.platform === 'ios') {
      /* A deliberate platform path, not a failed Android one: furniture is
         placed with AR Quick Look, the room is measured without WebXR. */
      status.textContent = state.selected?.modelUsdz
        ? 'On iPhone, furniture opens in Apple AR Quick Look. Measure the room with Measure without AR.'
        : 'On iPhone, measure the room with Measure without AR. Tracked AR room scans need Android Chrome.';
      return false;
    }
    if (!navigator.xr) {
      status.textContent = 'This browser has no tracked AR. Use Measure without AR, or open this page in Chrome.';
      return false;
    }
    try {
      const supported = await navigator.xr.isSessionSupported('immersive-ar');
      /* "Supported" here is the browser's promise, not a result. It is
         confirmed only when a session opens and finds the floor. */
      status.textContent = supported
        ? 'This browser offers tracked AR. It is confirmed once the camera finds your floor; bright light and a patterned floor help.'
        : 'This browser does not offer tracked AR on this phone. Use Measure without AR.';
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
    if (issue.kind === 'auth-required') {
      return `Sign in to view this furniture in 3D.${measure}`;
    }
    if (issue.kind === 'session-expired') {
      return `Your session has expired. Sign in again to view this piece in 3D.${measure}`;
    }
    if (issue.kind === 'forbidden') {
      return `You don't have permission to view this 3D model.${measure}`;
    }
    if (issue.kind === 'access-failed') {
      return `We couldn't open the 3D model just now. Please try again.${measure}`;
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
    // The file is fine; its shape does not match the listed size, so it
    // cannot be shown at that size without stretching it. A distorted piece
    // in somebody's room is worse than no preview at all, and the
    // measurements below are still true.
    if (issue.kind === 'scale-attention') {
      return issue.status === SCALE_STATUS.PROPORTION_MISMATCH
        ? `This 3D model's shape does not match the listed size, so it is not shown in AR. The listed dimensions are still correct.${measure}`
        : `This 3D model cannot be shown at its listed size right now. The listed dimensions are still correct.${measure}`;
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

    if (!product.modelGlb) {
      state.modelIssue = { kind: 'no-model' };
      return null;
    }

    /* The file itself only comes from a signed URL. If the server will not
       sign one — signed out, expired, not this account's to see — there is
       nothing to load, and the reason is said in words rather than left to
       GLTFLoader's "failed to load". */
    let modelPath;
    try {
      modelPath = await modelUrlFor(product);
    } catch (error) {
      state.modelIssue = modelIssueFrom(error);
      raiseModelAlert(state.modelIssue, product);
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
         How big is this? The product's verified dimensions say; the model
         supplies only the shape. lib/spatial/model-transform.mjs measures the
         mesh, asks lib/spatial/model-scale.mjs for ONE factor, applies it to
         all three axes, stands the piece on the floor, and measures again.
         The store portal's preview calls the same function, so the owner saw
         exactly this size before publishing.

         A model whose proportions cannot be that size without stretching is
         not stretched and not placed: a distorted sofa in somebody's room
         answers the fit question for furniture that does not exist.
      */
      const { decision, verified, finalMeters } = normalizeModel(THREE, model, product.dimensions);
      state.scaleDecision = decision;

      if (!verified) {
        // §24: never silently return false data. The measurements below the
        // viewer are still true; only the 3D stand-in is withheld.
        state.modelIssue = { kind: 'scale-attention', status: decision.status, detail: decision.message };
        console.error(`[AR] ${product.name}: ${decision.message}`);
        return null;
      }

      // Store original materials for later restoration during flat-surface detection
      model.traverse(child => {
        if (child instanceof THREE.Mesh && child.material) {
          child.userData.originalMaterial = Array.isArray(child.material) 
            ? child.material.slice() 
            : child.material;
        }
      });

      console.log(
        `[AR] ${product.name} at ${formatDimensions(product.dimensions)} `
        + `(measured ${(finalMeters.width * 100).toFixed(1)} × ${(finalMeters.depth * 100).toFixed(1)} × `
        + `${(finalMeters.height * 100).toFixed(1)} cm, ×${decision.scale.toPrecision(4)} from the file)`
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
    hitSampler.reset();
    state.target = { state: TARGET.SEARCHING, reason: null };
    state.estimate = null;

    /*
       ONE session request, from the tap that started this.

       This used to walk a ladder of five configurations, richest first, the
       first carrying a depth-sensing dictionary. Only the first request runs
       with the tap's user activation; the later ones may be refused because
       that activation was spent, not because the phone lacks anything — so
       the ladder turned "the browser refused" into "the phone cannot", and
       the depth request itself made otherwise capable phones refuse the whole
       session. Depth and plane detection are enhancements; the Infinix HOT 60i
       places furniture with neither.

       So: hit-test required, local-floor / dom-overlay (and plane-detection
       for a room scan) optional, depth never asked for. If it is refused, the
       planner says what was refused and the NEXT tap of the button tries the
       bare hit-test request — a new request from a new gesture.
    */
    const init = state.retryMinimal
      ? minimalSessionInit()
      : sessionInit({ domOverlayRoot: root, purpose: state.arPurpose === 'scan' ? 'scan' : 'placement' });
    state.sessionConfig = state.retryMinimal ? 'minimal' : 'standard';

    let session;
    try {
      session = await navigator.xr.requestSession('immersive-ar', init);
    } catch (error) {
      const refusal = classifyRefusal(error, { inAppBrowser: context.inAppBrowser });
      console.error('[AR] session refused:', { config: state.sessionConfig, name: error?.name, message: error?.message, state: refusal.state });
      // Offer the minimal request next time, unless that was this one.
      state.retryMinimal = !state.retryMinimal && refusal.state === DIAG.AR_SESSION_REFUSED;
      const wrapped = new Error(error?.message || 'AR session refused');
      wrapped.name = error?.name || 'Error';
      wrapped.refusal = refusal;
      throw wrapped;
    }
    state.retryMinimal = false;
    state.sessionFeatures = [...(session.enabledFeatures || [])];
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
    /* local-floor when it is granted: its origin is ON the floor, so a hit's
       height is its height above the floor and a table top can be told from
       the floor before any corner has been tapped. local otherwise — never
       required, so a browser without it still tracks. */
    state.floorOrigin = false;
    try {
      state.referenceSpace = await session.requestReferenceSpace('local-floor');
      state.floorOrigin = true;
    } catch {
      state.referenceSpace = await session.requestReferenceSpace('local');
    }

    // Hit-test is required by the request, so this should never be missing;
    // if it is, the session is useless for placing and says so.
    try {
      state.hitTestSource = await session.requestHitTestSource({ space: viewerSpace });
    } catch (err) {
      console.warn('[AR] Hit-test source unavailable:', err?.name, err?.message);
      state.hitTestSource = null;
      setHint('This AR session cannot find surfaces. Close it and use Measure without AR.');
    }

    const product = state.selected;
    const HINTS = {
      scan: 'Move slowly to find the floor.',
      placement: 'Move slowly to find the floor.',
      area: 'Move slowly to find the floor.'
    };
    setHint(
      state.arPurpose === 'scan' ? HINTS.scan
        : state.arPurpose !== 'measurement' ? HINTS.placement
        : HINTS[state.measureMode] || HINTS.scan
    );

    // The scan panel and its button only exist during a scan.
    const scanPanel = $('#scan-panel');
    if (scanPanel) scanPanel.hidden = state.arPurpose !== 'scan';
    const useRoom = $('#use-room');
    if (useRoom && state.arPurpose === 'scan') {
      useRoom.addEventListener('click', event => {
        event.stopPropagation();
        if (useRoom.dataset.action === 'confirm') startConfirmationScan();
        else useScannedRoom();
      });
    }

    /* A tap anywhere on the camera does what the thumb-zone button does, and
       is held to the same gate: nothing is captured until the target is a
       valid floor, held still. */
    session.addEventListener('select', event => captureNativePoint(event.frame));
    setPlacementButtonState(true);
    session.addEventListener('end', cleanupAR);

    // Load GLB model if this product has one. A room scan has no product, and
    // loading one would only cost time and memory for something never drawn.
    if (product && state.arPurpose !== 'scan') await loadGLBModel(product);

    // Set up THREE.js rendering if model is available
    let renderer = null, scene = null, camera = null;

    let light = null;
    let dirLight = null;
    let placedModel = null;
    let baseScale = null;

    // The adjustments appear once the piece is placed (setPlacementButtonState).
    $('#ar-tray').hidden = true;
    /* The measurement modes get their own bottom-of-screen confirmation, so
       that finishing is a deliberate tap within thumb reach rather than a
       reach for the corner. The room scan already has "Use this room". */
    const useMeasurement = $('#use-measurement');
    if (useMeasurement) {
      // Shown once there is a reading to keep (armUseMeasurement), not before.
      useMeasurement.hidden = true;
      useMeasurement.disabled = true;
    }

    /* No model, nothing to place. There used to be a plain box drawn at the
       product's dimensions here, in the product's colour, which on a phone
       read as "the furniture loaded". It did not; the shopper was placing a
       box. The reason the model is missing is said instead, and the camera
       stays useful for looking at the room. */
    if (state.arPurpose === 'placement' && product && !state.loadedModel) {
      setHint(modelFailureMessage());
    }
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
      hitSampler.reset();
      setPlacementButtonState(true);
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
        hitSampler.miss(time);
        setReticleState(TARGET.SEARCHING);
        if (!state.placementConfirmed) setPlacementButtonState(true);
        /* Raised once per loss, and only after the room had been found: the
           first frames of a session have no pose either, and that is
           "acquiring", not "lost". Taken down again when tracking returns. */
        if (state.trackingEverFound && !state.trackingLostAlert) {
          state.trackingLostAlert = notify(catalog('ar.tracking-lost'));
        }
        if (state.arPurpose === 'scan') {
          setHint('Tracking lost — move slowly and point at a surface with some texture.');
        }
        return;
      }
      state.trackingEverFound = true;
      if (state.trackingLostAlert) { dismiss(state.trackingLostAlert); state.trackingLostAlert = null; }

      const hits = state.hitTestSource ? xrFrame.getHitTestResults(state.hitTestSource) : [];
      state.latestHitPose = hits[0]?.getPose(state.referenceSpace) || null;

      /* ===== WHAT IS UNDER THE RETICLE =====
         Every hit goes into a short window; the window's robust estimate,
         not this frame's pose, is what gets judged and captured. The verdict
         is about THIS hit: its surface normal (a hit pose's +Y), how steady
         its height is, and, once a corner exists, whether it sits on the
         floor already measured. A plane somewhere else in the session is not
         evidence about this point, and steady Y alone is not flatness. */
      if (state.latestHitPose) {
        const t = state.latestHitPose.transform;
        hitSampler.push(t.position, time, normalFromOrientation(t.orientation));
      } else {
        hitSampler.miss(time);
      }
      const estimate = hitSampler.estimate();
      state.estimate = estimate;
      const measuringFloor = state.arPurpose === 'scan' && !state.roomTaps?.closed;
      const target = state.latestHitPose
        ? evaluateTarget({
            estimate,
            floor: measuringFloor ? floorRef : null,
            viewerY: state.floorOrigin ? pose.transform.position.y : null,
            onHorizontalPlane: hitOnHorizontalPlane(xrFrame, estimate.point)
          })
        : { state: TARGET.SEARCHING, reason: 'Move slowly to find the floor.' };
      // The ceiling tap is aimed UP; the floor gate does not apply to it.
      if (state.arPurpose === 'scan' && state.roomTaps?.closed && estimate.point && estimate.stable) {
        target.state = TARGET.VALID; target.reason = null;
      }
      state.target = target;
      setReticleState(target.state);
      setTracking(target.state === TARGET.VALID ? 'stable' : 'acquiring');

      if (!state.placementConfirmed) {
        const blocked = target.state !== TARGET.VALID || (state.arPurpose === 'placement' && !state.loadedModel);
        state.placementBlocked = blocked;
        setPlacementButtonState(blocked);
        if (state.arPurpose === 'placement' && state.loadedModel) {
          setHint(target.state === TARGET.VALID ? 'Floor found. Tap Place.' : target.reason, { urgent: false });
        } else if (state.arPurpose !== 'placement') {
          /* While the target is not usable, say why. The moment it is, say
             what to do — never leave "Hold still…" up under a green reticle. */
          if (target.state !== TARGET.VALID) {
            setHint(target.reason, { urgent: false });
            state.hintIsTargetReason = true;
          } else if (state.hintIsTargetReason) {
            setHint(state.arPurpose === 'scan'
              ? (state.roomTaps?.closed ? 'Aim at the ceiling line and tap for the height.' : 'Floor found. Hold on the corner and tap Add corner.')
              : 'Floor found. Tap Add point.');
            state.hintIsTargetReason = false;
          }
        }
      }
      flushHint();

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

        /* Plane detection, where the device has it, still measures the room
           on its own — but it must not overwrite corners somebody has tapped.
           Once a tap exists the person's own points win: they chose them. */
        if (supported && !state.roomTaps?.corners.length) {
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
        // Occlusion is offered only when there is something to occlude with.
        const occlusion = $('#toggle-occlusion');
        const canOcclude = Boolean(state.netSupport.planes || state.netSupport.depth);
        if (occlusion && occlusion.hidden === canOcclude) occlusion.hidden = !canOcclude;

        if (state.arPurpose === 'scan') {
          // Only count the sweep while the tracker actually has a pose: yaw
          // read during a tracking dropout is where the phone was, not where
          // it is, and would credit coverage that never happened.
          sweep.observe(state.viewerYaw);
          /* Which readiness applies depends on how this room is being
             measured. A tapped room is ready when its floor is closed; a
             plane-detected one when the sweep and the walls are in. Using the
             sweep-and-walls test on a tapped room would hold "Use this room"
             disabled forever on exactly the devices this path exists for. */
          state.scanReadiness = state.roomTaps?.corners.length
            ? tappedReadiness()
            : scanReadiness(sweep, state.room);
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
          // The same canonical size the fit check and the model use.
          const shown = product.dimensions;
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

      /* No model: nothing is drawn. See the note where the place button is
         wired — a box standing in for the product is not the product. */
    }

    session.requestAnimationFrame(frame);
  }

  /**
   * Does plane detection put this point ON a horizontal plane?
   *
   * true / false when the session reports planes, null when it does not —
   * so "no plane information" can never be read as either answer. The point
   * is taken into the plane's own space: within 3 cm of its surface and
   * inside its polygon counts.
   */
  function hitOnHorizontalPlane(xrFrame, point) {
    const planes = xrFrame?.detectedPlanes;
    if (!planes || !planes.size || !point || !THREE) return null;
    for (const plane of planes) {
      if (plane.orientation !== 'horizontal') continue;
      const planePose = xrFrame.getPose?.(plane.planeSpace, state.referenceSpace);
      if (!planePose) continue;
      const inverse = new THREE.Matrix4().fromArray(planePose.transform.matrix).invert();
      const local = new THREE.Vector3(point.x, point.y, point.z).applyMatrix4(inverse);
      if (Math.abs(local.y) > 0.03) continue;
      const polygon = plane.polygon || [];
      let inside = false;
      for (let i = 0, j = polygon.length - 1; i < polygon.length; j = i++) {
        const a = polygon[i], b = polygon[j];
        if ((a.z > local.z) !== (b.z > local.z)
          && local.x < ((b.x - a.x) * (local.z - a.z)) / (b.z - a.z) + a.x) inside = !inside;
      }
      if (inside) return true;
    }
    return false;
  }

  function captureNativePoint(frame) {
    const pose = state.latestHitPose;
    const estimate = state.estimate;
    /* The gate for EVERY capture: a valid floor, held still, from a window of
       hits. A tap before that is answered with what is wrong, not taken. */
    if (state.placementConfirmed && state.arPurpose === 'placement') return;
    if (!pose || !estimate?.point) { setHint('Move slowly to find the floor.'); return; }
    if (state.target?.state !== TARGET.VALID) {
      setHint(state.target?.reason || 'Hold still…');
      return;
    }
    const point = estimate.point;
    if (state.arPurpose === 'placement') {
      if (!state.loadedModel) { setHint(modelFailureMessage()); return; }
      // The hit's orientation, at the window's robust position.
      const matrix = pose.transform.matrix.slice();
      matrix[12] = point.x; matrix[13] = point.y; matrix[14] = point.z;
      state.placedMatrix = matrix;
      state.placementConfirmed = true;
      setHint('Placed. Move, rotate or reset below.');
      setPlacementButtonState(false, true);
      toast(`${state.selected.name} placed at its listed size.`, 'success');
      return;
    }

    // A tap during a room scan is a floor corner (or, once the floor is
    // closed, the ceiling). This is what actually measures the room on a
    // device without plane detection — which is to say, on almost all of them.
    if (state.arPurpose === 'scan') {
      const result = captureRoomCorner(point, estimate.spread);
      hitSampler.reset();   // the next corner starts from a fresh window
      return result;
    }

    if (state.measureMode === 'area') { hitSampler.reset(); return captureAreaPoint(point); }
    hitSampler.reset();

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
      toast('Readings differ by more than 5%. Measure the span again.', 'warning');
      state.arPoints = [];
      state.arNeedsConfirmation = false;
      state.arMeasurement = null;
      state.arConfirmationMeasurement = null;
      return;
    }

    const finalMeasurement = (state.arMeasurement + state.arConfirmationMeasurement) / 2;
    applyLiveClearance(finalMeasurement);
    toast(`Confirmed within 5%. Clearance ${cm(finalMeasurement)}.`, 'success');
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
      // Nothing measured yet: no readout over the camera. The instruction
      // line already says what to do.
      hideLiveMeasurement();
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
    if (points.length < 3) { toast('Tap at least three corners first.', 'warning'); return; }

    const area = geo.polygonArea(points);
    const confidence = geo.areaConfidence({ points, difference: 0 });
    if (confidence.level === 'low') {
      toast(`Scan again — ${confidence.reasons[0]}.`, 'warning');
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
      toast('The two scans differ by more than 5%. Measuring again.', 'warning');
      resetAreaScan();
      return;
    }

    const accepted = reconciled.value;
    const finalConfidence = geo.areaConfidence({ points, difference: reconciled.difference });
    applyMeasuredArea(accepted, points, finalConfidence, reconciled.difference);
    toast(`Confirmed within ${reconciled.difference.toFixed(1)}%. Floor ${geo.formatArea(accepted)}.`, 'success');
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

    /* NOT AR. The camera feed and the model are drawn on top of each other
       with no tracking between them: nothing here knows where the floor is,
       where the phone moved, or how many pixels a metre is. So it is called
       what it is on screen, there is no Place step and no "surface found",
       and nothing claims true scale or a fit. Move, rotate and reset only. */
    setARMode('camera-preview');
    $('#xr-canvas').style.display = 'none';
    stage.style.display = 'block';
    cameraVideo.style.display = 'block';
    $('#ar-tray').hidden = !isPlacement;
    $('#ar-reticle').hidden = true;
    const placeButton = $('#place-button');
    if (placeButton) placeButton.hidden = true;

    const hasCamera = await startCameraStream();
    if (hasCamera) {
      setHint(isPlacement
        ? 'Untracked 3D preview. It is not anchored to your room, so it cannot show true size or check fit.'
        : 'This phone cannot track the room. Close this and use Measure without AR.');
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

    /* There is nothing to occlude with in the untracked preview: no planes,
       no depth, no idea where the walls are. The control is hidden rather
       than shown doing nothing. */
    const previewOcclusion = $('#toggle-occlusion');
    if (previewOcclusion) previewOcclusion.hidden = true;

    $('#reset-model').addEventListener('click', event => {
      event.stopPropagation();
      arTransform.reset();
      setHint('Reset the view.');
    });

    bindPreviewGestures(stage, () => !isPlacement);

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
      setHint('This phone cannot track the room, so this view cannot measure it. Close this and use Measure without AR.');
    }

    const tick = () => {
      if (!state.fallbackRender) return;
      arTransform.tickSpin();
      modelRoot.position.set(arTransform.x, 0, arTransform.z);
      modelRoot.rotation.y = arTransform.yaw;
      modelRoot.scale.copy(baseScale);

      renderer.render(scene, camera);
      if (isPlacement) updatePlacementChip(modelRoot, camera, product, { untracked: true });
      requestAnimationFrame(tick);
    };

    state.fallbackRender = { renderer, scene, camera, modelRoot, resize };
    tick();
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
    if (purpose === 'placement' && !state.selected) return toast('Choose a piece to place first.', 'warning');
    /* Placing a piece this account may not see would open the camera and
       then draw nothing. Say why now, with the way forward, instead. */
    if (purpose === 'placement' && state.modelAccess?.issue
        && state.modelAccess.reference === state.selected.modelGlb) {
      raiseModelAlert(state.modelAccess.issue, state.selected);
      return;
    }
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
    const isIOS = context.platform === 'ios';

    /* In an embedded browser, nothing is attempted: the answer is "open this
       in your browser", before a chain of AR errors that would read as the
       phone's fault. */
    if (context.inAppBrowser) {
      showInAppNotice();
      notify({ type: 'info', message: DIAG_COPY[DIAG.IN_APP_BROWSER].title, duration: 6000 });
      return;
    }

    /* iPhone has no WebXR, so a room measurement goes straight to the
       methods that work there instead of to a camera preview that cannot
       measure. */
    if (isIOS && purpose !== 'placement') {
      window.dispatchEvent(new CustomEvent('furnishar:measure-without-ar'));
      return;
    }

    /* Quick Look renders a USDZ and hands nothing back to this page — no
       poses, no planes, no measurement. It is the right answer for "show me
       this chair on my floor" and completely the wrong one for "measure my
       room", so only a PLACEMENT goes down this path.

       This read `purpose !== 'scan'`, which sent the two-point and floor-area
       measurements to Quick Look on any iPhone — handing the user a 3D model
       viewer when they asked for a number, and, now that nothing is selected
       by default, dereferencing a null product on the way. */
    if (purpose === 'placement' && isIOS && product?.modelUsdz) {
      /* The USDZ is a protected file like the .glb: traded for a signed URL
         first. Quick Look opens a URL with no way to attach a token, so it
         must be handed one that already carries its permission. */
      let usdzUrl;
      try {
        usdzUrl = await modelUrlFor(product, 'modelUsdz');
      } catch (error) {
        raiseModelAlert(modelIssueFrom(error), product);
        return;
      }
      try {
        const response = await fetch(usdzUrl, { method: 'HEAD' });
        if (response.ok) {
          /* Safari only hands an rel="ar" link to AR Quick Look when the
             link contains an image; without one it downloads the file.
             allowsContentScaling=0 turns off pinch-to-resize, so the piece
             stays at its real size the way it does in FurnishAR's own AR. */
          const quickLookLink = document.createElement('a');
          quickLookLink.rel = 'ar';
          quickLookLink.href = `${usdzUrl}#allowsContentScaling=0`;
          const thumb = document.createElement('img');
          thumb.alt = '';
          thumb.src = product.thumbnail || 'data:image/gif;base64,R0lGODlhAQABAAAAACw=';
          quickLookLink.appendChild(thumb);
          quickLookLink.hidden = true;
          document.body.appendChild(quickLookLink);
          quickLookLink.click();
          quickLookLink.remove();
          toast('Opening Apple AR Quick Look.');
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
      scan: ['Room scan', 'Tap each corner where floor meets wall'],
      clearance: ['Measuring clearance', 'Tap point A, then point B'],
      area: ['Measuring floor area', 'Tap the corners of the free floor'],
      room: ['Room scan', 'Tap each corner where floor meets wall']
    };
    if (purpose === 'placement' && product) {
      /* The same canonical size, through the same formatter, as the product
         page, the planner card, the chip over the model and the fit check. */
      $('#ar-product-name').textContent = product.name;
      $('#ar-product-dims').textContent = formatDimensions(product.dimensions, 'cm');
    } else {
      const [title, sub] = TITLES[purpose === 'scan' ? 'scan' : state.measureMode] || TITLES.scan;
      $('#ar-product-name').textContent = title;
      $('#ar-product-dims').textContent = sub;
    }
    state.arPurpose = purpose;
    const layer = $('#ar-experience');
    if (layer) layer.dataset.purpose = purpose;
    if (purpose === 'scan') { sweep.reset(); resetRoomTaps(); }
    if (purpose === 'measurement' && state.measureMode === 'area') resetAreaScan();
    state.arPoints = [];
    state.placedMatrix = null;
    state.placementBlocked = false;
    state.placementConfirmed = false;
    $('#camera-feed').style.display = '';
    $('#xr-canvas').style.display = '';
    $('#fallback-product').style.display = 'none';
    $('#ar-tray').hidden = purpose !== 'placement';
    const placeButton = $('#place-button');
    if (placeButton) placeButton.hidden = false;
    setPlacementButtonState(true);
    try {
      const supportsAR = await checkARSupport();
      if (supportsAR) {
        await startNativeAR();
      } else if (purpose === 'placement') {
        await startCameraFallback();
      } else {
        // A room cannot be measured by an untracked camera. Say so and hand
        // over to the methods that can, instead of opening a camera that
        // pretends to.
        cleanupAR();
        window.dispatchEvent(new CustomEvent('furnishar:measure-without-ar'));
      }
    } catch (error) {
      console.error('[AR] Native AR start failed:', {
        errorName: error?.name,
        errorMessage: error?.message,
        errorCode: error?.code,
        stack: error?.stack?.split('\n').slice(0, 3).join('\n'),
        timestamp: new Date().toISOString()
      });
      /* What was OBSERVED is that the browser refused a session. That is
         said, with the likely causes as likely causes and the way forward —
         never "your phone does not support AR". */
      const refusal = error?.refusal || classifyRefusal(error, { inAppBrowser: context.inAppBrowser });
      const copy = DIAG_COPY[refusal.state] || DIAG_COPY[DIAG.AR_SESSION_REFUSED];
      if (purpose === 'placement') {
        await startCameraFallback();
      } else {
        cleanupAR();
      }
      toast(copy.title, 'warning');

      /* The next step, where the person is looking: the line under the
         button. A retry is offered only as a NEW tap (a different, minimal
         request); the device check is one link away. Only strings from the
         catalogue above are interpolated. */
      const status = $('#ar-status');
      if (status) {
        const retry = state.retryMinimal ? ' Tap the button again to try a simpler AR session.' : '';
        status.innerHTML = `<b>${escapeHtml(copy.title)}.</b> ${escapeHtml(copy.observed)}${copy.likely ? ` ${escapeHtml(copy.likely)}` : ''}${escapeHtml(retry)}
          <a href="/diagnose">Check this phone</a>, or use Measure without AR.`;
        status.dataset.state = 'refused';
      }
      if (state.retryMinimal) {
        const button = $('#ar-button');
        if (button) button.textContent = 'Try tracked AR again';
      }
    }
  }

  function cleanupAR() {
    state.hitTestSource?.cancel?.();
    state.hitTestSource = null;
    state.referenceSpace = null;
    state.latestHitPose = null;
    state.session = null;
    state.trackingEverFound = false;
    if (state.trackingLostAlert) { dismiss(state.trackingLostAlert); state.trackingLostAlert = null; }
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
  /*
     The way in for a room measured WITHOUT AR.

     MeasureSurface.js measures by tilt trigonometry, by photo scaling, or
     from typed tape figures, on phones where ARCore does not exist and never
     will. What comes back is a roomDimensions() result — the same shape the
     AR path produces, because all three paths go through the same function —
     so it can be adopted here with no special case downstream.

     Deliberately separate from __furnisharScan, which is a test seam. This is
     a real integration point between two parts of the app, and naming it as
     one stops the next person deleting it as test scaffolding.
  */
  window.__furnisharPlanner = {
    adoptRoom(room) {
      if (!room?.rectangle) return false;
      state.room = room;
      useScannedRoom();
      return true;
    }
  };

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
    /* The path that works on a phone with no plane detection: corners tapped
       on the floor, then optionally the ceiling. Each call is exactly what a
       tap on a hit-test point does, so a check can measure a whole room the
       way a person standing in one would, with detectedPlanes unavailable. */
    tapCorner(point, spread = 0.005) { captureRoomCorner(point, spread); return state.room; },
    closeFloor() { closeTappedFloor(); return state.room; },
    /* "Scan again to confirm": the second, independent pass a tapped room
       needs before it can be used. */
    confirmScan() { startConfirmationScan(); return state.scanReadiness; },
    undoCorner() { undoTappedCorner(); return state.room; },
    accept() { useScannedRoom(); },
    get state() {
      return {
        room: state.room,
        scannedRoom: state.scannedRoom,
        readiness: state.scanReadiness,
        netSupport: state.netSupport,
        taps: state.roomTaps,
        sweep: { degrees: sweep.degrees, guidance: sweep.guidance() }
      };
    },
    reset() {
      sweep.reset();
      state.room = null;
      state.scannedRoom = null;
      state.detectedSurfaces = [];
      state.scanReadiness = null;
      /* Cleared too, or a check that ran feed() earlier leaves planes marked
         supported and the next one cannot honestly claim to be testing the
         no-plane-detection path. */
      state.netSupport = { planes: false, depth: false };
      sweep.reset();
      resetRoomTaps();
    }
  };

  if (autoStart) startExperience('placement');

  return function teardown() {
    window.removeEventListener('popstate', onPopState);
    delete window.__furnisharScan;
    delete window.__furnisharPlanner;
    listeners.forEach(off => off());

    /*
       The overlay is removed from the screen NOW, synchronously — not after
       the WebXR session finishes ending.

       This used to be `if (state.session) state.session.end().catch(cleanupAR)`,
       which only ran cleanupAR (and so unmountARExperience) if ending the
       session FAILED. On success, removal waited for the session's own 'end'
       event, which fires only once the browser has actually torn down the
       camera and the XR frame loop — on real hardware that can take a
       noticeable moment, not the ~0ms it takes in a headless test. Someone
       navigating home from the room scanner during that window got the
       measurement chip and the reticle still sitting on screen, over the
       page they had just navigated to, because #ar-experience lives on
       document.body and nothing else was telling it to go.

       unmountARExperience() only removes the DOM and a listener; it does not
       touch the camera stream, the hit-test source or the renderer, so it is
       safe to call before the session has actually finished closing. Ending
       the session still happens in the background via state.session.end()
       (or cleanupAR() directly, restoring the pre-existing behaviour for
       everything that WASN'T the visible leak) so the camera and GPU
       resources are still released the moment the browser is done with them.
    */
    unmountARExperience();
    /* $('#ar-experience') is no use as the "was anything active" check here
       any more — unmountARExperience() just removed it unconditionally, so it
       would always read null. state.cameraStream is what actually indicates
       a camera/renderer was running without a full WebXR session (the
       camera-preview fallback path). */
    if (state.session) state.session.end().catch(cleanupAR);
    else if (state.cameraStream || state.xrRenderer || state.fallbackRender) cleanupAR();
  };
}
