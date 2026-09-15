/* FurnishAR client — no build step required. It talks to the local Node API. */

// Load THREE.js and GLTFLoader from CDN (ES module)
// These are loaded via dynamic import when needed
let THREE = null;
let GLTFLoader = null;

async function loadThreeJS() {
  if (THREE) return;
  try {
    THREE = await import('three');
    const { GLTFLoader: Loader } = await import('three/addons/loaders/GLTFLoader.js');
    GLTFLoader = Loader;
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
  pixelsPerCm: null,
  ownProducts: [],
  measureMode: 'clearance',
  areaPoints: [],
  membership: null,
  unsubscribeCatalog: null
};

const $ = (selector, parent = document) => parent.querySelector(selector);
const $$ = (selector, parent = document) => [...parent.querySelectorAll(selector)];
const peso = value => new Intl.NumberFormat('en-PH', { style: 'currency', currency: 'PHP', maximumFractionDigits: 0 }).format(value);
const cm = value => `${Math.round(value)} cm`;
const colorStyles = { Sand: '#d4b18b', Oak: '#aa7953', Terracotta: '#c46e50', Walnut: '#725343', Black: '#474b47', White: '#d9d4ca', Natural: '#b58d62' };

const AR_EXPERIENCE_HTML = `<div id="ar-experience" class="ar-layer">
  <video id="camera-feed" autoplay playsinline muted></video>
  <canvas id="xr-canvas"></canvas>
  <div id="fallback-product" class="ar-stage"></div>
  <div id="ar-reticle" class="ar-reticle" aria-hidden="true"><span></span></div>
  <div id="ar-anchor-chip" class="ar-anchor-chip glass" hidden><b id="anchor-primary"></b><i id="anchor-secondary"></i></div>
  <svg id="ar-measure-line" class="ar-measure-line" aria-hidden="true" hidden><line x1="0" y1="0" x2="0" y2="0" /><circle id="measure-dot-a" r="7" /><circle id="measure-dot-b" r="7" /></svg>
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
  <div class="ar-dock">
  <p id="ar-mode-label" class="ar-hint glass"></p>
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
    <div class="tray-cluster" data-cluster="scale">
      <span class="tray-label">Scale <i id="scale-value">100%</i></span>
      <div class="tray-row">
        <button class="tray-btn" data-step="scale" data-dir="-1" aria-label="Smaller">−</button>
        <button class="tray-btn tray-wide" id="reset-model" aria-label="Reset model">Reset</button>
        <button class="tray-btn" data-step="scale" data-dir="1" aria-label="Larger">+</button>
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
  resize(dir, amount = 0.01) { this.scale = clamp(this.scale + dir * amount, 0.5, 2); syncTrayReadout(); },
  tickSpin() {
    const now = performance.now();
    const elapsed = Math.min((now - (this.lastSpin || now)) / 1000, 0.1);
    this.lastSpin = now;
    // A full turn every 12 seconds, independent of frame rate.
    if (this.spinning) { this.yaw = (this.yaw + (Math.PI / 6) * elapsed) % (Math.PI * 2); syncTrayReadout(); }
  }
};

const clamp = (value, min, max) => Math.min(max, Math.max(min, value));

function syncTrayReadout() {
  const scaleValue = $('#scale-value');
  if (scaleValue) scaleValue.textContent = `${Math.round(arTransform.scale * 100)}%`;
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

function updateLiveMeasurementDisplay(distanceInMeters, caption = '') {
  const panel = $('#live-measurement');
  if (!panel) return;
  $('#live-cm').textContent = `${(distanceInMeters * 100).toFixed(1)} cm`;
  $('#live-mm').textContent = `${(distanceInMeters * 1000).toFixed(0)} mm`;
  $('#live-m').textContent = `${distanceInMeters.toFixed(3)} m`;
  $('#live-caption').textContent = caption;
  panel.hidden = false;
}

function hideLiveMeasurement() {
  const panel = $('#live-measurement');
  if (panel) panel.hidden = true;
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
  const bounds = product.modelBounds || product.dimensions;
  const scale = arTransform.scale;
  positionAnchorChip(
    projectToScreen(top, camera),
    `${Math.round(bounds.width * scale)} × ${Math.round(bounds.depth * scale)} cm`,
    `${Math.round(bounds.height * scale)} cm tall · ${product.name}`
  );
}

/* Real-time link from the AR reading to the planner's fit verdict. */
function applyLiveClearance(centimeters) {
  const pointB = $('#point-b');
  if (!pointB) return;
  const rounded = Math.round(centimeters);
  if (Number(pointB.value) === rounded) return;
  $('#point-a').value = 0;
  pointB.value = rounded;
  updateFitVerdict();
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
  arTransform.reset();
  bindTray();
  syncTrayReadout();
  $('#exit-ar').addEventListener('click', () => state.session ? state.session.end() : cleanupAR(), { once: true });
  $('#close-outline').addEventListener('click', closeAreaOutline);
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

function colorFor(product) { return colorStyles[product.color] || '#8c9d88'; }
function furniture(product, extra = '') {
  const model = ['sofa', 'table', 'chair', 'bed', 'shelf', 'desk'].includes(product.model) ? product.model : 'shelf';
  return `<div class="furniture-illustration ${model} ${extra}" style="--piece:${colorFor(product)}" aria-hidden="true">
    <span class="piece back"></span><span class="piece seat"></span><span class="piece top"></span>
    <span class="piece leg leg-a"></span><span class="piece leg leg-b"></span><span class="piece leg leg-c"></span><span class="piece leg leg-d"></span>
    <span class="piece side side-a"></span><span class="piece side side-b"></span><span class="piece shelf-line shelf-one"></span><span class="piece shelf-line shelf-two"></span><span class="piece shelf-line shelf-three"></span>
  </div>`;
}


/* ---------------------------------------------------------------------------
   Backend
   Supabase when the deployment is configured for it, otherwise the bundled
   JSON catalogue and demo sign-in that shipped with the app. Everything below
   this block is written against `backend`, not against either one directly.
--------------------------------------------------------------------------- */

let sb = null;             // the Supabase module, imported on demand
let geo = null;            // measurement mathematics (public/geometry.js)
const backend = { kind: 'local' };


/* ---------------------------------------------------------------------------
   Convenience
   A shopper should be able to send someone a link to a piece, come back to a
   half-finished measurement, and install the app on their phone. None of that
   needs an account.
--------------------------------------------------------------------------- */

/** Opens the product named in ?product=<slug|id>, if there is one. */
function openProductFromUrl() {
  const wanted = new URLSearchParams(location.search).get('product');
  if (!wanted) return false;
  const product = state.products.find(item => item.slug === wanted || item.id === wanted);
  if (!product) return false;
  selectProduct(product.id);
  openProduct(product.id);
  return true;
}

/** Keeps the address bar in step so the page can be shared or reloaded. */
function rememberProductInUrl(product) {
  if (!product) return;
  const url = new URL(location.href);
  url.searchParams.set('product', product.slug || product.id);
  history.replaceState({}, '', url);
}

async function shareProduct(product) {
  const url = new URL(location.href);
  url.searchParams.set('product', product.slug || product.id);
  const link = url.toString();
  try {
    if (navigator.share) {
      await navigator.share({ title: product.name, text: `${product.name} — ${product.store}`, url: link });
      return;
    }
    await navigator.clipboard.writeText(link);
    toast('Link copied.');
  } catch (error) {
    if (error?.name !== 'AbortError') toast('Could not share that link.');
  }
}

const MEASUREMENT_KEY = 'furnishar-measurement';

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

function showBuildStamp() {
  const config = window.FURNISHAR_CONFIG || {};
  const stamp = $('#build-stamp');
  if (!stamp) return;
  const version = config.version ? `v${config.version}` : '';
  const commit = config.commit && config.commit !== 'dev' ? ` · ${config.commit}` : '';
  const backend = usingSupabase() ? ' · live catalog' : '';
  stamp.textContent = `${version}${commit}${backend}`.trim();
}

async function initGeometry() {
  if (geo) return geo;
  geo = await import('./geometry.js');
  return geo;
}

async function initBackend() {
  try {
    const module = await import('./supabase.js');
    if (!module.isConfigured()) return;
    // Load the client library up front: if it cannot be fetched, this
    // deployment falls back to the bundled catalogue instead of showing an
    // empty shop.
    await module.prepare();
    sb = module;
    backend.kind = 'supabase';
    console.log('[FurnishAR] Supabase backend active');
  } catch (error) {
    backend.kind = 'local';
    sb = null;
    console.warn('[FurnishAR] Supabase unavailable, using the bundled catalogue:', error?.message);
  }
}

function usingSupabase() {
  return backend.kind === 'supabase' && sb;
}

async function api(path, options = {}) {
  const headers = { ...(options.body ? { 'Content-Type': 'application/json' } : {}), ...(options.headers || {}) };
  if (state.token) headers.Authorization = `Bearer ${state.token}`;
  const response = await fetch(path, { ...options, headers });
  const data = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(data.error || 'The request could not be completed.');
  return data;
}

function productMatches(product) {
  const f = state.filters;
  const find = `${product.name} ${product.store} ${product.category} ${product.style} ${product.color}`.toLowerCase();
  return (!f.search || find.includes(f.search.toLowerCase())) && (!f.category || product.category === f.category) && (!f.store || product.storeId === f.store) && product.dimensions.width <= f.width && (!f.color || product.color === f.color);
}

function renderCatalog() {
  const found = state.products.filter(productMatches);
  $('#result-count').textContent = `${found.length} ${found.length === 1 ? 'piece' : 'pieces'} to explore`;
  $('#product-grid').innerHTML = found.length ? found.map(product => `
    <article class="product-card">
      <div class="product-image">${furniture(product)}<span class="ar-badge">AR</span><button class="view-button" data-open-product="${product.id}" aria-label="View ${escapeHtml(product.name)}">→</button></div>
      <div class="product-info"><p class="product-store">${escapeHtml(product.store)}</p><h3 class="product-name">${escapeHtml(product.name)}</h3><div class="product-meta"><span class="product-price">${peso(product.price)}</span><span class="product-dimension">${product.dimensions.width} × ${product.dimensions.depth} × ${product.dimensions.height} cm</span></div></div>
    </article>`).join('') : '<div class="no-results"><b>No furniture matches these filters.</b><br /><small>Try widening your search or clearing a filter.</small></div>';
}

function renderColors() {
  const colors = [...new Set(state.products.map(product => product.color))];
  $('#color-options').innerHTML = colors.map(color => `<button class="color-option ${state.filters.color === color ? 'active' : ''}" data-color="${color}" style="background:${colorFor({ color })}" aria-label="Filter by ${color}" aria-pressed="${state.filters.color === color}"></button>`).join('');
}

/* Dialogs remember the control that opened them, so closing returns focus
   where the keyboard left it instead of dropping it on <body>. */
function openDialog(dialog) {
  dialog.dataset.returnFocus = '';
  state.focusReturn = document.activeElement;
  dialog.showModal();
  const heading = dialog.querySelector('h2');
  if (heading) {
    heading.setAttribute('tabindex', '-1');
    heading.focus({ preventScroll: true });
  }
  dialog.addEventListener('close', () => {
    const target = state.focusReturn;
    state.focusReturn = null;
    if (target && document.contains(target)) target.focus({ preventScroll: true });
  }, { once: true });
}

function openProduct(id) {
  const product = state.products.find(item => item.id === id);
  if (!product) return;
  state.selected = product;
  const storeInfo = state.stores[product.storeId];
  const storeBlock = storeInfo ? `<dl class="store-card">
    <div><dt>Store</dt><dd>${escapeHtml(storeInfo.name)}</dd></div>
    <div><dt>Address</dt><dd>${escapeHtml(storeInfo.address)}</dd></div>
    <div><dt>Contact</dt><dd>${escapeHtml(storeInfo.contactNumber)}</dd></div>
    <div><dt>Hours</dt><dd>${escapeHtml(storeInfo.hours)}</dd></div>
  </dl>` : '';
  const isIOS = /iPad|iPhone|iPod/.test(navigator.userAgent) || (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1);
  const quickLookLink = (isIOS && product.modelUsdz) ? `<a class="button button-primary" rel="ar" href="${product.modelUsdz}"><img src="${product.modelUsdz.replace(/\.(usdz|glb)$/i, '.png')}" alt="${escapeHtml(product.name)} preview" style="display:block;width:100%;max-width:180px;border-radius:12px;margin:0 auto 12px;" onerror="this.style.display='none'" />Open in AR</a>` : '';
  const arAction = (navigator.xr && !isIOS) ? `<button class="button button-primary" data-place-product="${product.id}">Place in your room</button>` : (product.modelUsdz && isIOS ? quickLookLink : `<button class="button button-primary" data-place-product="${product.id}">Place in your room</button>`);
  $('#dialog-content').innerHTML = `<div class="dialog-layout"><div class="dialog-image">${furniture(product)}</div><div class="dialog-info"><p class="product-store">${escapeHtml(product.store)} · ${escapeHtml(product.category)}</p><h2>${escapeHtml(product.name)}</h2><p class="dialog-price">${peso(product.price)}</p><p>${escapeHtml(product.description)}</p><div class="dialog-dimensions"><div><span>WIDTH</span><b>${cm(product.dimensions.width)}</b></div><div><span>DEPTH</span><b>${cm(product.dimensions.depth)}</b></div><div><span>HEIGHT</span><b>${cm(product.dimensions.height)}</b></div></div>${storeBlock}${arAction}<button class="button button-outline" data-plan-product="${product.id}">Measure the fit first</button><button class="button button-outline" data-share-product="${product.id}">Copy link to this piece</button></div></div>`;
  rememberProductInUrl(product);
  openDialog($('#product-dialog'));
}

function selectProduct(id, goToPlanner = false) {
  const next = state.products.find(item => item.id === id);
  if (!next) return;
  state.selected = next;
  if ($('#product-dialog').open) $('#product-dialog').close();
  renderPlanner();
  if (goToPlanner) changeView('planner');
}

function renderPlanner() {
  if (!state.selected) state.selected = state.products[0] || null;
  const product = state.selected;
  if (!product) return;
  $('#planner-product').innerHTML = `<div class="planner-product-inner">${furniture(product)}<div><h3>${escapeHtml(product.name)}</h3><p>${escapeHtml(product.store)}</p><p>${product.dimensions.width} W × ${product.dimensions.depth} D × ${product.dimensions.height} H</p></div></div>`;
  $('#check-width').textContent = cm(product.dimensions.width);
  $('#check-depth').textContent = cm(product.dimensions.depth);
  const arProductName = $('#ar-product-name');
  if (arProductName) arProductName.textContent = product.name;
  updateFitVerdict();
}

function measuredDistance() { return Math.abs(Number($('#point-b').value || 0) - Number($('#point-a').value || 0)); }
function measuredArea() { return Math.max(Number($('#floor-area').value || 0), 0); }

/* Clearance measures a span; floor area measures a polygon. The switch changes
   what the AR scan captures, what the fields ask for, and how the verdict is
   decided. */
function setMeasureMode(mode) {
  state.measureMode = mode === 'area' ? 'area' : 'clearance';
  const isArea = state.measureMode === 'area';
  $$('.mode-option').forEach(button => {
    const active = button.dataset.measureMode === state.measureMode;
    button.classList.toggle('is-active', active);
    button.setAttribute('aria-checked', String(active));
  });
  $('#clearance-fields').hidden = isArea;
  $('#area-fields').hidden = !isArea;
  $('#measure-title').textContent = isArea ? 'Floor area scan' : 'Two-point room scan';
  $('#measure-copy').textContent = isArea
    ? 'Tap around the free floor — three points or more, in order, then close the outline. Two scans are compared before a reading is accepted.'
    : 'Aim at a textured, non-reflective floor in bright light. On Android Chrome, tap two points across the opening. Otherwise use the fields below.';
  $('#ar-button').textContent = isArea ? 'Scan floor area' : 'Scan with your camera';
  try { localStorage.setItem('furnishar-measure-mode', state.measureMode); } catch { /* private mode */ }
  updateFitVerdict();
}
function updateFitVerdict() {
  const product = state.selected;
  if (!product || !geo) return;

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
  if (measurement.kind === 'area') {
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

function changeView(name) {
  if ($('#ar-experience')) {
    if (state.session) state.session.end().catch(cleanupAR);
    else cleanupAR();
  }
  $$('.view').forEach(view => view.classList.toggle('active', view.id === `${name}-view`));
  $$('.nav-link').forEach(button => {
    const isCurrent = button.dataset.view === name;
    button.classList.toggle('active', isCurrent);
    button.setAttribute('aria-current', isCurrent ? 'page' : 'false');
  });
  if (name === 'planner') renderPlanner();
  if (name === 'admin') renderAdmin();
  window.scrollTo({ top: 0, behavior: 'smooth' });
}

function toast(message) {
  const element = $('#toast'); element.textContent = message; element.classList.add('show');
  clearTimeout(toast.timer); toast.timer = setTimeout(() => element.classList.remove('show'), 3400);
}

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

async function loadScaledModel(product) {
  if (!THREE) await loadThreeJS();
  if (!THREE || !GLTFLoader) {
    return null;
  }

  const modelPath = product.modelGlb;
  if (!modelPath) {
    return null;
  }

  try {
    const loader = new GLTFLoader();
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

    const bbox = new THREE.Box3().setFromObject(model);
    const size = bbox.getSize(new THREE.Vector3());
    const targetBounds = product.modelBounds || product.dimensions;
    const scaleX = (targetBounds.width / 100) / Math.max(size.x, 0.0001);
    const scaleY = (targetBounds.height / 100) / Math.max(size.y, 0.0001);
    const scaleZ = (targetBounds.depth / 100) / Math.max(size.z, 0.0001);

    model.scale.set(scaleX, scaleY, scaleZ);

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

    console.log(`[AR] ${product.name} scaled to ${targetBounds.width}×${targetBounds.height}×${targetBounds.depth} cm`);
    return model;
  } catch (error) {
    console.error(`[AR] Could not load ${modelPath}:`, error?.name, error?.message);
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
      optionalFeatures: ['local-floor', 'dom-overlay', 'plane-detection'],
      domOverlay: { root }
    });
    state.hitTestRequired = true;
  } catch (error) {
    console.warn('[AR] hit-test required failed:', error?.name, error?.message, '— retrying without hit-test...');
    try {
      // Fallback: try without hit-test as required
      session = await navigator.xr.requestSession('immersive-ar', {
        optionalFeatures: ['hit-test', 'local-floor', 'dom-overlay', 'plane-detection'],
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
  setHint(state.arPurpose !== 'measurement'
    ? 'Find the floor, then place. Use the tray to move, turn, and resize.'
    : state.measureMode === 'area'
      ? 'Tap the corners of the free floor in order. Three or more, then close the outline.'
      : 'Tap point A, then point B. The reading updates as you move.');
  session.addEventListener('select', event => captureNativePoint(event.frame));
  session.addEventListener('end', cleanupAR);

  // Load GLB model if this product has one
  await loadGLBModel(product);

  // Set up THREE.js rendering if model is available
  let renderer = null, scene = null, camera = null;
  const fallbackRenderer = arRenderer(gl);
  const [red, green, blue] = (colorFor(product).match(/[a-f\d]{2}/gi) || ['8c','9d','88']).map(value => parseInt(value, 16) / 255);

  let light = null;
  let dirLight = null;
  let placedModel = null;
  let baseScale = null;

  $('#ar-tray').hidden = state.arPurpose !== 'placement';

  // Tray actions are wired up whether or not a GLB loaded, so the box fallback
  // can still be placed and reset.
  $('#place-button').addEventListener('click', event => {
    event.stopPropagation();
    captureNativePoint(null);
  });
  $('#reset-model').addEventListener('click', event => {
    event.stopPropagation();
    arTransform.reset();
    state.placedMatrix = null;
    state.placementConfirmed = false;
    setPlacementButtonState(false);
    setHint('Reset. Find the floor and place again.');
  });

  if (THREE && state.loadedModel) {
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

      // Clone the loaded model for this session
      placedModel = state.loadedModel.clone();
      scene.add(placedModel);
      baseScale = placedModel.scale.clone();

    } catch (error) {
      console.error('[AR] THREE.js renderer unavailable:', error.message);
      renderer = null;
    }
  }

  function frame(time, xrFrame) {
    session.requestAnimationFrame(frame);
    const pose = xrFrame.getViewerPose(state.referenceSpace);
    if (!pose) return;

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

    // ===== REAL-TIME MEASUREMENT =====
    if (state.arPurpose === 'measurement') {
      const hitPos = state.latestHitPose?.transform.position;
      if (state.measureMode === 'area') {
        updateLiveAreaDisplay(hitPos, pose);
      } else if (hitPos && state.arPoints.length === 1) {
        const liveDistanceM = distanceBetween(state.arPoints[0], hitPos);
        updateLiveMeasurementDisplay(liveDistanceM, state.arNeedsConfirmation ? 'confirming span' : 'point A → target');
        // Feed the planner live so the fit verdict tracks the phone in real time.
        applyLiveClearance(liveDistanceM * 100);
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

    const anchor = state.placedMatrix || state.latestHitPose?.transform.matrix;
    if (!anchor || state.arPurpose !== 'placement') return;

    if (renderer && scene && placedModel) {
      const anchorMatrix = new THREE.Matrix4().fromArray(anchor);
      const anchorPosition = new THREE.Vector3().setFromMatrixPosition(anchorMatrix);
      const anchorQuaternion = new THREE.Quaternion().setFromRotationMatrix(anchorMatrix);

      // Anchor pose + the tray's offset, heading and scale.
      placedModel.position.set(anchorPosition.x + arTransform.x, anchorPosition.y, anchorPosition.z + arTransform.z);
      placedModel.quaternion.copy(anchorQuaternion).multiply(userYawQuaternion());
      placedModel.scale.copy(baseScale).multiplyScalar(arTransform.scale);

      // three.js drives the XR framebuffer, viewports and per-eye cameras itself.
      renderer.render(scene, camera);
      updatePlacementChip(placedModel, renderer.xr.getCamera?.() || camera, product);
      return;
    }

    // Fallback cube when the GLB or THREE.js is unavailable.
    gl.bindFramebuffer(gl.FRAMEBUFFER, layer.framebuffer);
    gl.clearColor(0, 0, 0, 0);
    gl.clear(gl.COLOR_BUFFER_BIT | gl.DEPTH_BUFFER_BIT);
    gl.enable(gl.DEPTH_TEST);
    const dimensions = product.dimensions;
    for (const view of pose.views) {
      const viewport = layer.getViewport(view);
      gl.viewport(viewport.x, viewport.y, viewport.width, viewport.height);
      const model = translateScale(anchor, arTransform.x, dimensions.height / 200, arTransform.z, dimensions.width / 200, dimensions.height / 200, dimensions.depth / 200);
      fallbackRenderer.draw(matrixMultiply(view.projectionMatrix, matrixMultiply(view.transform.inverse.matrix, model)), [red, green, blue, .72]);
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

  if (!model || !THREE || !canvas.getContext('webgl2', { alpha: true })) {
    setARMode('illustration-only');
    stage.innerHTML = '<div class="fallback-message glass">3D preview unavailable on this device. Use the measurement fields to check fit.</div>';
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
  if (!isPlacement) bindPreviewRuler(stage, product);

  const tick = () => {
    if (!state.fallbackRender) return;
    arTransform.tickSpin();
    modelRoot.position.set(arTransform.x, 0, arTransform.z);
    modelRoot.rotation.y = arTransform.yaw;
    modelRoot.scale.copy(baseScale).multiplyScalar(arTransform.scale);

    const nextBlocked = Math.abs(previewTilt) > 45;
    if (nextBlocked !== surfaceBlocked) {
      surfaceBlocked = nextBlocked;
      setModelSurfaceState(modelRoot, surfaceBlocked);
      setPlacementButtonState(surfaceBlocked, placementConfirmed);
      setHint(surfaceBlocked ? 'Hold the phone level to judge the surface.' : 'Untracked preview. Use the tray to move, turn and resize.');
    }

    renderer.render(scene, camera);
    state.pixelsPerCm = measurePixelsPerCm(modelRoot, camera);
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
function measurePixelsPerCm(modelRoot, camera) {
  if (!THREE) return null;
  const box = new THREE.Box3().setFromObject(modelRoot);
  const size = box.getSize(new THREE.Vector3());
  const centre = box.getCenter(new THREE.Vector3());
  const left = projectToScreen(new THREE.Vector3(centre.x - size.x / 2, centre.y, centre.z), camera);
  const right = projectToScreen(new THREE.Vector3(centre.x + size.x / 2, centre.y, centre.z), camera);
  if (!left || !right || size.x <= 0) return null;
  return Math.hypot(right.x - left.x, right.y - left.y) / (size.x * 100);
}

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
    arTransform.resize(event.deltaY > 0 ? -1 : 1, 0.05);
  }, { passive: false });

  stage.addEventListener('touchmove', event => {
    if (isLocked() || event.touches.length !== 2) return;
    const [a, b] = [event.touches[0], event.touches[1]];
    const distance = Math.hypot(a.clientX - b.clientX, a.clientY - b.clientY);
    const angle = Math.atan2(b.clientY - a.clientY, b.clientX - a.clientX);
    if (pinchDistance && Math.abs(distance - pinchDistance) > 6) {
      arTransform.scale = clamp(arTransform.scale * (distance / pinchDistance), 0.5, 2);
      syncTrayReadout();
    }
    if (lastAngle !== null) arTransform.rotate(1, angle - lastAngle);
    pinchDistance = distance;
    lastAngle = angle;
  }, { passive: true });

  ['touchend', 'touchcancel'].forEach(type => stage.addEventListener(type, () => { pinchDistance = null; lastAngle = null; }, { passive: true }));
}

/* Real-time ruler for devices without WebXR: drag across the opening and the
   span is read off the on-screen scale of the product itself. */
function bindPreviewRuler(stage, product) {
  const svg = $('#ar-measure-line');
  const line = svg.querySelector('line');
  const dotA = $('#measure-dot-a');
  const dotB = $('#measure-dot-b');
  let origin = null;

  const draw = (from, to) => {
    // SVGElement has no `hidden` IDL property — the attribute has to go directly.
    svg.removeAttribute('hidden');
    line.setAttribute('x1', from.x); line.setAttribute('y1', from.y);
    line.setAttribute('x2', to.x); line.setAttribute('y2', to.y);
    dotA.setAttribute('cx', from.x); dotA.setAttribute('cy', from.y);
    dotB.setAttribute('cx', to.x); dotB.setAttribute('cy', to.y);
  };

  const readout = (from, to) => {
    if (!state.pixelsPerCm) return;
    const centimetres = Math.hypot(to.x - from.x, to.y - from.y) / state.pixelsPerCm;
    updateLiveMeasurementDisplay(centimetres / 100, `estimate · scaled to ${product.dimensions.width} cm reference`);
    applyLiveClearance(centimetres);
  };

  stage.addEventListener('pointerdown', event => {
    origin = { x: event.clientX, y: event.clientY };
    draw(origin, origin);
    readout(origin, origin);
  });

  stage.addEventListener('pointermove', event => {
    if (!origin) return;
    const point = { x: event.clientX, y: event.clientY };
    draw(origin, point);
    readout(origin, point);
  });

  ['pointerup', 'pointercancel'].forEach(type => stage.addEventListener(type, () => {
    if (origin) setHint('Reading saved to the planner. Drag again to re-measure.');
    origin = null;
  }));
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
  if (!state.selected) return toast('Choose a product first.');
  const product = state.selected;
  const isIOS = /iPad|iPhone|iPod/.test(navigator.userAgent) || (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1);

  // Try iOS Quick Look if on iOS and USDZ is available and accessible
  if (isIOS && product.modelUsdz) {
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
  const { width, depth, height } = product.dimensions;
  $('#ar-product-name').textContent = product.name;
  $('#ar-product-dims').textContent = `${width} × ${depth} × ${height} cm`;
  state.arPurpose = purpose;
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
  state.pixelsPerCm = null;
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

async function login(event) {
  event.preventDefault();
  $('#login-error').textContent = '';
  const form = event.currentTarget;
  form.querySelector('[name="email"]')?.removeAttribute('aria-invalid');
  const fields = Object.fromEntries(new FormData(form));
  const button = form.querySelector('button[type="submit"]');
  button.disabled = true;

  try {
    if (usingSupabase()) {
      await sb.signIn({ email: fields.email, password: fields.password });
      await applySupabaseSession();
      form.reset();
      toast(state.user?.store ? `Signed in to ${state.user.store}.` : 'Signed in.');
    } else {
      const response = await api('/api/auth/login', { method: 'POST', body: JSON.stringify(fields) });
      state.token = response.token;
      state.user = response.user;
      sessionStorage.setItem('furnishar-token', state.token);
      sessionStorage.setItem('furnishar-user', JSON.stringify(state.user));
      form.reset();
      renderAdmin();
      toast(`Signed in to ${state.user.store}.`);
    }
  } catch (error) {
    $('#login-error').textContent = error.message;
    form.querySelector('[name="email"]')?.setAttribute('aria-invalid', 'true');
    form.querySelector('[name="email"]')?.focus();
  } finally {
    button.disabled = false;
  }
}

/* Reads the Supabase session and the store it may act for. A brand new account
   has no store until an admin approves its application, so the portal shows a
   pending state rather than an empty dashboard. */
async function applySupabaseSession() {
  const session = await sb.getSession();
  if (!session) {
    state.user = null;
    state.token = '';
    state.membership = null;
    state.ownProducts = [];
    renderAdmin();
    return;
  }
  const membership = await sb.getMembership();
  state.membership = membership;
  state.token = session.access_token;
  state.user = membership
    ? { email: session.user.email, storeId: membership.storeId, storeUuid: membership.storeUuid, store: membership.store, plan: membership.plan }
    : { email: session.user.email, storeId: null, storeUuid: null, store: null, plan: null };
  renderAdmin();
  if (membership) await loadOwnProducts();
}

async function logout() {
  if (usingSupabase()) {
    await sb.signOut();
    state.user = null;
    state.membership = null;
    state.ownProducts = [];
    state.token = '';
  } else {
    state.token = '';
    state.user = null;
    sessionStorage.removeItem('furnishar-token');
    sessionStorage.removeItem('furnishar-user');
  }
  renderAdmin();
  toast('Signed out.');
}

function showSignup() {
  $('#login-panel').hidden = true;
  $('#signup-panel').hidden = false;
  $('#signup-message').textContent = '';
}

function showLogin() {
  $('#login-panel').hidden = false;
  $('#signup-panel').hidden = true;
}

async function signup(event) {
  event.preventDefault();
  const form = event.currentTarget;
  const fields = Object.fromEntries(new FormData(form));
  const message = $('#signup-message');
  message.textContent = '';
  message.classList.remove('is-ok');

  if (!usingSupabase()) {
    message.textContent = "Store sign-ups open once the live database is connected. We'll onboard your store manually in the meantime.";
    return;
  }

  const button = form.querySelector('button[type="submit"]');
  button.disabled = true;
  try {
    const result = await sb.signUp({
      email: fields.email,
      password: fields.password,
      storeName: fields.storeName,
      phone: fields.phone,
      message: fields.message
    });
    form.reset();
    message.classList.add('is-ok');
    message.textContent = result.needsEmailConfirmation
      ? 'Account created. Confirm your email address, then sign in — your store is queued for review.'
      : 'Account created and your store is queued for review. You can sign in now.';
    toast('Application received.');
  } catch (error) {
    message.textContent = error.message;
  } finally {
    button.disabled = false;
  }
}


/* ---------------------------------------------------------------------------
   Plans
   The tiers the panel asked us to think through, stated where an owner can
   actually see them. The limits are not decoration: the 8-product cap and
   premium-only featuring are enforced by the database, so what this panel
   claims is what the system does.
--------------------------------------------------------------------------- */

const PLANS = [
  {
    id: 'freemium',
    name: 'Freemium',
    price: 'Free',
    cadence: 'no card, no expiry',
    features: [
      'Up to 8 published products',
      'AR placement and room measurement',
      '3D model upload, 50 MB per file',
      'Store profile in every listing'
    ]
  },
  {
    id: 'premium',
    name: 'Premium',
    price: '₱499',
    cadence: 'per store, per month',
    features: [
      'Unlimited products',
      'Featured placement at the top of the catalog',
      'Everything in Freemium'
    ]
  }
];

function renderPlans() {
  const host = $('#plan-panel');
  if (!host) return;
  const current = usingSupabase() ? (state.user?.plan || 'freemium') : 'premium';
  const used = (usingSupabase() ? (state.ownProducts || []) : state.products.filter(p => p.storeId === state.user?.storeId)).length;

  host.innerHTML = PLANS.map(plan => {
    const isCurrent = plan.id === current;
    const usage = plan.id === 'freemium' && isCurrent
      ? `<p class="plan-usage">${used} of 8 products used</p>`
      : '';
    return `<article class="plan-card${isCurrent ? ' is-current' : ''}">
      <p class="eyebrow">${plan.name}${isCurrent ? ' · current' : ''}</p>
      <p class="plan-price">${plan.price}</p>
      <p class="plan-cadence">${plan.cadence}</p>
      ${usage}
      <ul class="plan-features">${plan.features.map(feature => `<li>${escapeHtml(feature)}</li>`).join('')}</ul>
      ${isCurrent ? '<p class="plan-note">Your current plan.</p>' : `<button class="button button-outline" data-plan-enquiry="${plan.id}">Ask about ${escapeHtml(plan.name)}</button>`}
    </article>`;
  }).join('');
}

function renderAdmin() {
  const loggedIn = Boolean(state.token && state.user);
  const awaitingApproval = loggedIn && usingSupabase() && !state.user.storeUuid;
  $('#login-panel').hidden = loggedIn;
  $('#pending-panel').hidden = !awaitingApproval;
  $('#dashboard').hidden = !loggedIn || awaitingApproval;
  if (!loggedIn) return;

  // A brand new account owns nothing until an admin approves its application.
  if (awaitingApproval) {
    $('#pending-email').textContent = state.user.email || '';
    return;
  }

  // Supabase owners edit their own rows, drafts included; the bundled
  // catalogue only has the published list to work from.
  const own = usingSupabase()
    ? (state.ownProducts || [])
    : state.products.filter(product => product.storeId === state.user.storeId);
  const plan = usingSupabase()
    ? (state.user.plan === 'premium' ? 'Premium' : 'Freemium')
    : (own.length > 0 ? 'Premium' : 'Freemium');
  const FREEMIUM_LIMIT = 8;
  const isFree = plan === 'Freemium';

  $('#owner-store').textContent = state.user.store;
  $('#inventory-summary').innerHTML = `<div class="inventory-stat"><span>Plan</span><strong>${plan}</strong></div><div class="inventory-stat"><span>Listed products</span><strong>${own.length}${isFree ? `/${FREEMIUM_LIMIT}` : ''}</strong></div><div class="inventory-stat"><span>Units available</span><strong>${own.reduce((sum, product) => sum + product.stock, 0)}</strong></div><div class="inventory-stat"><span>Catalog value</span><strong>${peso(own.reduce((sum, product) => sum + product.price * product.stock, 0))}</strong></div>`;
  renderPlans();
  $('#inventory-body').innerHTML = own.length ? own.map(product => `<tr><td>${escapeHtml(product.name)}<small>${escapeHtml(product.category)} · ${escapeHtml(product.color)}${product.modelGlb ? ' · 3D model' : ''}</small></td><td>${product.dimensions.width} × ${product.dimensions.depth} × ${product.dimensions.height} cm</td><td>${peso(product.price)}</td><td>${product.stock}</td><td><small>${relativeTime(product.updatedAt)}</small></td><td><div class="table-actions"><button class="icon-button" data-edit-product="${product.id}">Edit</button><button class="icon-button delete" data-delete-product="${product.id}">Delete</button></div></td></tr>`).join('') : '<tr><td colspan="6">No products listed yet. Add your first product above.</td></tr>';
}

function openProductForm(product = null) {
  const form = $('#product-form'); form.reset(); $('#product-form-error').textContent = ''; $('#form-title').textContent = product ? 'Edit product' : 'Add a product';
  if (product) {
    form.elements.id.value = product.id;
    for (const key of ['name', 'category', 'style', 'color', 'price', 'stock', 'model', 'description', 'modelGlb', 'modelUsdz']) form.elements[key].value = product[key] || '';
    form.elements.width.value = product.dimensions.width;
    form.elements.height.value = product.dimensions.height;
    form.elements.depth.value = product.dimensions.depth;
    form.elements.modelWidth.value = product.modelBounds?.width ?? product.dimensions.width;
    form.elements.modelHeight.value = product.modelBounds?.height ?? product.dimensions.height;
    form.elements.modelDepth.value = product.modelBounds?.depth ?? product.dimensions.depth;
  }
  openDialog($('#product-form-dialog'));
}

async function saveProduct(event) {
  event.preventDefault();
  const form = event.currentTarget;
  const values = Object.fromEntries(new FormData(form));
  const errorBox = $('#product-form-error');
  errorBox.textContent = '';
  const modelFile = form.elements.modelFile?.files?.[0] || null;
  const submit = form.querySelector('button[type="submit"]');

  const product = {
    ...values,
    price: Number(values.price),
    stock: Number(values.stock),
    dimensions: { width: Number(values.width), height: Number(values.height), depth: Number(values.depth) },
    modelGlb: values.modelGlb ? String(values.modelGlb).trim() : undefined,
    modelUsdz: values.modelUsdz ? String(values.modelUsdz).trim() : undefined,
    modelBounds: {
      width: Number(values.modelWidth || values.width),
      height: Number(values.modelHeight || values.height),
      depth: Number(values.modelDepth || values.depth)
    }
  };

  submit.disabled = true;
  try {
    if (usingSupabase()) {
      if (!state.user?.storeUuid) throw new Error('Your store is still awaiting approval.');
      const saved = await sb.saveProduct({ ...product, id: values.id || undefined }, state.user.storeUuid);
      if (modelFile) {
        submit.textContent = 'Uploading model…';
        await sb.uploadModel(modelFile, { storeUuid: state.user.storeUuid, productId: saved.id, kind: 'glb' });
      }
      await Promise.all([loadOwnProducts(), loadProducts()]);
    } else {
      if (modelFile) throw new Error('Model uploads need the Supabase backend. Set SUPABASE_URL and SUPABASE_ANON_KEY.');
      await api(values.id ? `/api/products/${values.id}` : '/api/products', {
        method: values.id ? 'PUT' : 'POST',
        body: JSON.stringify(product)
      });
      await loadProducts();
    }
    $('#product-form-dialog').close();
    toast(values.id ? 'Product updated.' : 'Product added to the catalog.');
  } catch (error) {
    errorBox.textContent = error.message;
  } finally {
    submit.disabled = false;
    submit.textContent = 'Save product';
  }
}

async function deleteProduct(id) {
  const list = usingSupabase() ? (state.ownProducts || []) : state.products;
  const product = list.find(item => item.id === id);
  if (!product || !confirm(`Remove “${product.name}” from your catalog?`)) return;
  try {
    if (usingSupabase()) {
      await sb.deleteProduct(id);
      await Promise.all([loadOwnProducts(), loadProducts()]);
    } else {
      await api(`/api/products/${id}`, { method: 'DELETE' });
      await loadProducts();
    }
    if (state.selected?.id === id) state.selected = null;
    toast('Product removed from the catalog.');
  } catch (error) {
    toast(error.message);
  }
}

const SKELETON_CARD = `<article class="skeleton-card" aria-hidden="true"><div class="skeleton-image"></div><div class="skeleton-info"><span class="skeleton-line is-short"></span><span class="skeleton-line is-title"></span><span class="skeleton-line is-short"></span></div></article>`;

function showCatalogSkeleton(count = 6) {
  const grid = $('#product-grid');
  if (!grid) return;
  grid.classList.add('is-loading');
  grid.setAttribute('aria-busy', 'true');
  grid.innerHTML = SKELETON_CARD.repeat(count);
}

async function loadProducts() {
  if (usingSupabase()) {
    const [products, stores] = await Promise.all([sb.listProducts(), sb.listStores()]);
    state.products = products;
    state.stores = Object.fromEntries(stores.map(store => [store.id, store]));
  } else {
    const data = await api('/api/products');
    state.products = data.products;
    try {
      const storesData = await api('/api/stores');
      state.stores = Object.fromEntries(storesData.stores.map(store => [store.id, store]));
    } catch (error) {
      console.warn('Could not load store information:', error);
    }
  }
  if (!state.selected || !state.products.some(product => product.id === state.selected.id)) state.selected = state.products[0] || null;
  const grid = $('#product-grid');
  grid.classList.remove('is-loading');
  grid.removeAttribute('aria-busy');
  renderColors(); renderCatalog(); renderPlanner(); renderAdmin();
}

/* The owner's own list, drafts included. Only Supabase distinguishes the two;
   the bundled catalogue has no draft state. */
async function loadOwnProducts() {
  if (!usingSupabase() || !state.user?.storeUuid) return;
  try {
    state.ownProducts = await sb.listOwnProducts(state.user.storeUuid);
    renderAdmin();
  } catch (error) {
    console.warn('Could not load store inventory:', error.message);
  }
}

function bindEvents() {
  if (typeof document === 'undefined') return;  // Skip on server
  document.addEventListener('click', event => {
    const view = event.target.closest('[data-view]')?.dataset.view; if (view) { changeView(view); return; }
    const open = event.target.closest('[data-open-product]')?.dataset.openProduct; if (open) return openProduct(open);
    const color = event.target.closest('[data-color]')?.dataset.color; if (color !== undefined) { state.filters.color = state.filters.color === color ? '' : color; renderColors(); renderCatalog(); return; }
    const planEnquiry = event.target.closest('[data-plan-enquiry]')?.dataset.planEnquiry;
    if (planEnquiry) { toast(`Thanks — we'll be in touch about the ${planEnquiry} plan.`); return; }
    const share = event.target.closest('[data-share-product]')?.dataset.shareProduct;
    if (share) { const item = state.products.find(p => p.id === share); if (item) shareProduct(item); return; }
    const place = event.target.closest('[data-place-product]')?.dataset.placeProduct; if (place) { selectProduct(place); return startExperience('placement'); }
    const plan = event.target.closest('[data-plan-product]')?.dataset.planProduct; if (plan) return selectProduct(plan, true);
    const edit = event.target.closest('[data-edit-product]')?.dataset.editProduct; if (edit) return openProductForm(state.products.find(product => product.id === edit));
    const remove = event.target.closest('[data-delete-product]')?.dataset.deleteProduct; if (remove) return deleteProduct(remove);
    if (event.target.closest('[data-close-dialog]')) $('#product-dialog').close();
    if (event.target.closest('[data-close-form]')) $('#product-form-dialog').close();
  });
  $('#search').addEventListener('input', event => { state.filters.search = event.target.value; renderCatalog(); });
  $('#filter-category').addEventListener('change', event => { state.filters.category = event.target.value; renderCatalog(); });
  $('#filter-store').addEventListener('change', event => { state.filters.store = event.target.value; renderCatalog(); });
  $('#filter-width').addEventListener('input', event => { state.filters.width = Number(event.target.value); $('#width-output').textContent = state.filters.width >= 240 ? 'No limit' : `Up to ${state.filters.width} cm`; renderCatalog(); });
  $('#clear-filters').addEventListener('click', () => { state.filters = { search: '', category: '', store: '', width: 240, color: '' }; $('#search').value = ''; $('#filter-category').value = ''; $('#filter-store').value = ''; $('#filter-width').value = 240; $('#width-output').textContent = 'No limit'; renderColors(); renderCatalog(); });
  $$('#point-a, #point-b').forEach(input => input.addEventListener('input', updateFitVerdict));
  $('#ar-button').addEventListener('click', () => startExperience('measurement'));
  $$('.mode-option').forEach(button => button.addEventListener('click', () => setMeasureMode(button.dataset.measureMode)));
  $('#close-outline')?.addEventListener('click', closeAreaOutline);
  ['#floor-area', '#floor-span'].forEach(selector => $(selector)?.addEventListener('input', () => { updateFitVerdict(); saveMeasurement(); }));
  ['#point-a', '#point-b'].forEach(selector => $(selector)?.addEventListener('input', saveMeasurement));
  $('#login-form').addEventListener('submit', login); $('#logout').addEventListener('click', logout);
  $('#show-signup').addEventListener('click', showSignup); $('#show-login').addEventListener('click', showLogin); $('#signup-form').addEventListener('submit', signup);
  $('#add-product').addEventListener('click', () => openProductForm()); $('#product-form').addEventListener('submit', saveProduct);
}

async function init() {
  bindEvents();
  showCatalogSkeleton();
  await initGeometry();
  let savedMode = 'clearance';
  try { savedMode = localStorage.getItem('furnishar-measure-mode') || 'clearance'; } catch { /* private mode */ }
  setMeasureMode(savedMode);
  await initBackend();

  try {
    await Promise.all([
      loadProducts(),
      loadThreeJS(),
      checkARSupport()
    ]);
    restoreMeasurement();
    openProductFromUrl();
    showBuildStamp();
  } catch (error) {
    $('#product-grid').classList.remove('is-loading');
    $('#product-grid').removeAttribute('aria-busy');
    $('#product-grid').innerHTML = usingSupabase()
      ? `<div class="no-results"><b>FurnishAR could not reach the catalog database.</b><br /><small>${escapeHtml(error.message)}</small></div>`
      : `<div class="no-results"><b>FurnishAR could not reach its local catalog.</b><br /><small>Start the app with <code>npm run local</code> and refresh this page.</small></div>`;
    toast(error.message);
  }

  if (!usingSupabase()) return;

  // Restore an existing session, and follow sign-ins and sign-outs made in
  // another tab.
  await applySupabaseSession();
  await sb.onAuthChange(async (event) => {
    if (event === 'SIGNED_IN' || event === 'SIGNED_OUT' || event === 'TOKEN_REFRESHED') {
      await applySupabaseSession();
    }
  });

  // Live catalogue: another shop publishing a piece updates this page without
  // a refresh.
  try {
    state.unsubscribeCatalog = await sb.subscribeToCatalog(() => {
      clearTimeout(state.catalogRefresh);
      state.catalogRefresh = setTimeout(() => loadProducts().catch(() => {}), 250);
    });
  } catch (error) {
    console.warn('[FurnishAR] Realtime unavailable:', error?.message);
  }
}

// Only initialize on browser, not on server
if (typeof document !== 'undefined') {
  window.addEventListener('popstate', () => {
    if ($('#ar-experience')) {
      if (state.session) state.session.end().catch(cleanupAR);
      else cleanupAR();
    }
  });
  init();
}
