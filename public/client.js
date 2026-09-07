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
    console.log('[THREE.js] ✓ Loaded successfully from CDN');
    return true;
  } catch (error) {
    console.error('[THREE.js] Failed to load:', error?.message, '— app will degrade to CSS illustrations and camera fallback only');
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
  arLayoutObserver: null,
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
  arMode: null
};

const $ = (selector, parent = document) => parent.querySelector(selector);
const $$ = (selector, parent = document) => [...parent.querySelectorAll(selector)];
const peso = value => new Intl.NumberFormat('en-PH', { style: 'currency', currency: 'PHP', maximumFractionDigits: 0 }).format(value);
const cm = value => `${Math.round(value)} cm`;
const colorStyles = { Sand: '#d4b18b', Oak: '#aa7953', Terracotta: '#c46e50', Walnut: '#725343', Black: '#474b47', White: '#d9d4ca', Natural: '#b58d62' };

const AR_EXPERIENCE_HTML = `<div id="ar-experience" class="ar-experience"><video id="camera-feed" autoplay playsinline muted></video><canvas id="xr-canvas"></canvas><div id="fallback-product" class="fallback-product"></div><div class="ar-hud"><div><p class="eyebrow">FurnishAR placement</p><strong id="ar-product-name">Product</strong><span id="ar-mode-indicator" class="ar-mode-indicator" aria-label="AR mode"></span></div><button id="exit-ar" class="ar-exit">Exit</button></div><div class="ar-reticle"><i></i></div><div id="live-measurement" class="live-measurement" hidden><span id="live-cm">0 cm</span><span id="live-mm">0 mm</span><span id="live-m">0.00 m</span></div><div class="ar-instructions"><b id="ar-mode-label">Move your phone slowly to find the floor.</b><span>Tap the screen to place. Drag horizontally to rotate in preview mode.</span></div><div id="model-controls" class="model-controls" hidden><div class="control-group rotate-group"><button id="rotate-left" class="control-btn" aria-label="Rotate left" title="Rotate left">⟲</button><button id="rotate-right" class="control-btn" aria-label="Rotate right" title="Rotate right">⟳</button></div><div class="control-group move-group"><button id="move-up" class="control-btn" aria-label="Move away">↑</button><button id="move-down" class="control-btn" aria-label="Move closer">↓</button><button id="move-left" class="control-btn" aria-label="Move left">←</button><button id="move-right" class="control-btn" aria-label="Move right">→</button></div><div class="control-group zoom-group"><button id="zoom-in" class="control-btn" aria-label="Zoom in">+</button><button id="zoom-out" class="control-btn" aria-label="Zoom out">−</button></div><button id="reset-model" class="control-btn reset-btn" aria-label="Reset position" title="Reset to default position">⟲ Reset</button></div></div>`;

function mountARExperience() {
  let experience = $('#ar-experience');
  if (!experience) {
    document.body.insertAdjacentHTML('beforeend', AR_EXPERIENCE_HTML);
    experience = $('#ar-experience');
  }
  experience.hidden = false;
  layoutControlRing();
  state.arLayoutObserver?.disconnect();
  const banner = $('.ar-instructions');
  if (banner && typeof ResizeObserver !== 'undefined') {
    state.arLayoutObserver = new ResizeObserver(layoutControlRing);
    state.arLayoutObserver.observe(banner);
  }
  $('#exit-ar').addEventListener('click', () => state.session ? state.session.end() : cleanupAR(), { once: true });
  return experience;
}

function unmountARExperience() {
  state.arLayoutObserver?.disconnect();
  state.arLayoutObserver = null;
  $('#ar-experience')?.remove();
}

function setARMode(mode) {
  state.arMode = mode;
  const indicator = $('#ar-mode-indicator');
  if (!indicator) return;
  const modes = {
    'native-ar': '📡 Live AR',
    'camera-preview': '📷 Camera preview',
    'illustration-only': '🎨 Illustration'
  };
  indicator.textContent = modes[mode] || '';
  console.log(`[AR Mode] Switched to: ${mode}`);
}

function updateLiveMeasurementDisplay(distanceInMeters) {
  $('#live-cm').textContent = `${(distanceInMeters * 100).toFixed(1)} cm`;
  $('#live-mm').textContent = `${(distanceInMeters * 1000).toFixed(0)} mm`;
  $('#live-m').textContent = `${distanceInMeters.toFixed(3)} m`;
  $('#live-measurement').hidden = false;
}

function hideLiveMeasurement() {
  $('#live-measurement').hidden = true;
}

function layoutControlRing() {
  const tray = $('.model-controls');
  if (!tray) return;
  const ring = tray.querySelectorAll('button:not(#reset-model)');
  const traySize = tray.clientWidth;
  const center = traySize / 2;
  const halfButton = (ring[0]?.getBoundingClientRect().width || 40) / 2;
  const radius = Math.max(0, center - halfButton - 8);
  const banner = $('.ar-instructions');
  if (banner) tray.style.bottom = `${banner.offsetHeight + 12}px`;
  ring.forEach((button, index) => {
    const angle = (index / ring.length) * 2 * Math.PI - Math.PI / 2;
    button.style.left = `${center + radius * Math.cos(angle) - halfButton}px`;
    button.style.top = `${center + radius * Math.sin(angle) - halfButton}px`;
  });
}

window.addEventListener('resize', layoutControlRing, { passive: true });
window.addEventListener('orientationchange', layoutControlRing, { passive: true });
layoutControlRing();

let modelControlState = { initialScale: 1, initialRotation: 0, initialPosition: { x: 0, y: 0, z: 0 } };

function setupModelControls(modelRoot, syncSizeFunc) {
  if (!modelRoot) return;

  // Store initial state for reset
  modelControlState.initialScale = modelRoot.scale.x;
  modelControlState.initialRotation = modelRoot.rotation.y;
  modelControlState.initialPosition = { x: modelRoot.position.x, y: modelRoot.position.y, z: modelRoot.position.z };

  const step = { rotation: 0.15, movement: 0.05, scale: 0.1 };
  
  // Rotate left/right
  $('#rotate-left')?.addEventListener('click', (e) => {
    e.stopPropagation();
    modelRoot.rotation.y -= step.rotation;
  });
  $('#rotate-right')?.addEventListener('click', (e) => {
    e.stopPropagation();
    modelRoot.rotation.y += step.rotation;
  });

  // Move up/down/left/right
  $('#move-up')?.addEventListener('click', (e) => {
    e.stopPropagation();
    modelRoot.position.z += step.movement;
  });
  $('#move-down')?.addEventListener('click', (e) => {
    e.stopPropagation();
    modelRoot.position.z -= step.movement;
  });
  $('#move-left')?.addEventListener('click', (e) => {
    e.stopPropagation();
    modelRoot.position.x -= step.movement;
  });
  $('#move-right')?.addEventListener('click', (e) => {
    e.stopPropagation();
    modelRoot.position.x += step.movement;
  });

  // Zoom in/out
  $('#zoom-in')?.addEventListener('click', (e) => {
    e.stopPropagation();
    modelRoot.scale.multiplyScalar(1 + step.scale / modelRoot.scale.x);
    if (syncSizeFunc) syncSizeFunc();
  });
  $('#zoom-out')?.addEventListener('click', (e) => {
    e.stopPropagation();
    modelRoot.scale.multiplyScalar(1 - step.scale / modelRoot.scale.x);
    if (syncSizeFunc) syncSizeFunc();
  });

  // Reset
  $('#reset-model')?.addEventListener('click', (e) => {
    e.stopPropagation();
    modelRoot.scale.setScalar(modelControlState.initialScale);
    modelRoot.rotation.y = modelControlState.initialRotation;
    modelRoot.position.set(modelControlState.initialPosition.x, modelControlState.initialPosition.y, modelControlState.initialPosition.z);
    if (syncSizeFunc) syncSizeFunc();
  });
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
      <div class="product-image">${furniture(product)}<span class="ar-badge">⌑ AR READY</span><button class="view-button" data-open-product="${product.id}" aria-label="View ${escapeHtml(product.name)}">→</button></div>
      <div class="product-info"><p class="product-store">${escapeHtml(product.store)}</p><h3 class="product-name">${escapeHtml(product.name)}</h3><div class="product-meta"><span class="product-price">${peso(product.price)}</span><span class="product-dimension">${product.dimensions.width} × ${product.dimensions.depth} × ${product.dimensions.height} cm</span></div></div>
    </article>`).join('') : '<div class="no-results"><b>No furniture matches these filters.</b><br /><small>Try widening your search or clearing a filter.</small></div>';
}

function renderColors() {
  const colors = [...new Set(state.products.map(product => product.color))];
  $('#color-options').innerHTML = colors.map(color => `<button class="color-option ${state.filters.color === color ? 'active' : ''}" data-color="${color}" style="background:${colorFor({ color })}" aria-label="Filter by ${color}" aria-pressed="${state.filters.color === color}"></button>`).join('');
}

function openProduct(id) {
  const product = state.products.find(item => item.id === id);
  if (!product) return;
  state.selected = product;
  const storeInfo = state.stores[product.storeId];
  const storeBlock = storeInfo ? `<div style="background: #f5f5f5; padding: 12px; border-radius: 4px; margin-top: 12px; font-size: 13px;"><strong>📍 ${escapeHtml(storeInfo.name)}</strong><br />${escapeHtml(storeInfo.address)}<br />☎️ ${escapeHtml(storeInfo.contactNumber)}<br />🕒 ${escapeHtml(storeInfo.hours)}</div>` : '';
  const isIOS = /iPad|iPhone|iPod/.test(navigator.userAgent) || (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1);
  const quickLookLink = (isIOS && product.modelUsdz) ? `<a class="button button-primary" rel="ar" href="${product.modelUsdz}"><img src="${product.modelUsdz.replace(/\.(usdz|glb)$/i, '.png')}" alt="${escapeHtml(product.name)} preview" style="display:block;width:100%;max-width:180px;border-radius:12px;margin:0 auto 12px;" onerror="this.style.display='none'" />Open in AR</a>` : '';
  const arAction = (navigator.xr && !isIOS) ? `<button class="button button-primary" data-place-product="${product.id}">⌑ Place in your room</button>` : (product.modelUsdz && isIOS ? quickLookLink : `<button class="button button-primary" data-place-product="${product.id}">⌑ Place in your room</button>`);
  $('#dialog-content').innerHTML = `<div class="dialog-layout"><div class="dialog-image">${furniture(product)}</div><div class="dialog-info"><p class="product-store">${escapeHtml(product.store)} · ${escapeHtml(product.category)}</p><h2>${escapeHtml(product.name)}</h2><p class="dialog-price">${peso(product.price)}</p><p>${escapeHtml(product.description)}</p><div class="dialog-dimensions"><div><span>WIDTH</span><b>${cm(product.dimensions.width)}</b></div><div><span>DEPTH</span><b>${cm(product.dimensions.depth)}</b></div><div><span>HEIGHT</span><b>${cm(product.dimensions.height)}</b></div></div>${storeBlock}${arAction}<button class="button button-outline" data-plan-product="${product.id}">Measure the fit first</button></div></div>`;
  $('#product-dialog').showModal();
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
function updateFitVerdict() {
  const product = state.selected;
  if (!product) return;
  const clearance = measuredDistance();
  const needed = product.dimensions.width + 5;
  const passes = clearance >= needed;
  $('#measured-distance').textContent = cm(clearance);
  $('#visual-distance').textContent = cm(clearance);
  $('#check-clearance').textContent = cm(clearance);
  $('#fit-verdict').className = `fit-verdict ${passes ? '' : 'fail'}`;
  $('#fit-verdict').innerHTML = passes
    ? `<div class="verdict-icon">✓</div><h3>It should fit.</h3><p>You have ${cm(clearance - product.dimensions.width)} of remaining clearance. Keep a little extra room for comfortable movement.</p>`
    : `<div class="verdict-icon">!</div><h3>Needs more clearance.</h3><p>This piece needs at least ${cm(needed)} including a 5 cm comfort margin. Try a narrower option or re-measure the opening.</p>`;
}

function changeView(name) {
  if ($('#ar-experience')) {
    if (state.session) state.session.end().catch(cleanupAR);
    else cleanupAR();
  }
  $$('.view').forEach(view => view.classList.toggle('active', view.id === `${name}-view`));
  $$('.nav-link').forEach(button => button.classList.toggle('active', button.dataset.view === name));
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
    console.info('[AR Support] Branch: insecure-context -> camera/WebXR unavailable');
    status.textContent = 'Use HTTPS (or localhost) to enable camera and WebXR. Guided measurement is still available.';
    return false;
  }
  const isIOS = /iPad|iPhone|iPod/.test(navigator.userAgent) || (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1);
  if (isIOS && state.selected?.modelUsdz) {
    console.info('[AR Support] Branch: iOS Quick Look path selected for USDZ product');
    status.textContent = 'iPhone Safari detected. AR Quick Look will open the native USDZ viewer for this product.';
    return false;
  }
  if (!navigator.xr) {
    console.info('[AR Support] Branch: navigator.xr missing');
    status.textContent = 'WebXR is unavailable in this browser. The camera preview and guided measurement will still work.';
    return false;
  }
  try {
    const supported = await navigator.xr.isSessionSupported('immersive-ar');
    console.info(`[AR Support] Branch: isSessionSupported('immersive-ar') -> ${supported}`);
    status.textContent = supported ? 'AR-ready device detected. Use a bright, textured floor for best tracking.' : 'This device does not expose immersive AR. A camera preview will be used instead.';
    return supported;
  } catch (error) {
    console.warn('[AR Support] Branch: session support probe threw:', error?.name, error?.message);
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
    console.log(`[AR Model] THREE.js unavailable, using fallback cube for "${product.name}"`);
    return null;
  }

  const modelPath = product.modelGlb;
  if (!modelPath) {
    console.log(`[AR Model] Product "${product.name}" has no 3D model, using fallback cube`);
    return null;
  }

  try {
    const loader = new GLTFLoader();
    const gltf = await new Promise((resolve, reject) => {
      loader.load(
        modelPath,
        resolve,
        (progress) => console.log(`[AR Model] Loading ${modelPath}: ${Math.round((progress.loaded / progress.total) * 100)}%`),
        reject
      );
    });

    const model = gltf.scene;
    
    // Ensure vertex colors are preserved for models without image textures
    // Models like the cabinets use COLOR_0 vertex attributes instead of textures
    model.traverse(node => {
      if (node.isMesh && node.material) {
        if (Array.isArray(node.material)) {
          node.material.forEach(mat => {
            mat.vertexColors = true;
          });
        } else {
          node.material.vertexColors = true;
        }
      }
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

    console.log(`[AR Model] ✓ Loaded and scaled "${product.name}" to ${targetBounds.width}×${targetBounds.height}×${targetBounds.depth} cm`);
    return model;
  } catch (error) {
    console.error(`[AR Model] ✗ Failed to load ${modelPath}:`, error?.name, error?.message);
    return null;
  }
}

async function loadGLBModel(product) {
  state.loadedModel = await loadScaledModel(product);
  state.modelBounds = state.loadedModel ? { product: product.id } : null;
}

async function startNativeAR() {
  console.log('[AR Session] Requesting XR immersive-ar session...');
  setARMode('native-ar');
  const root = $('#ar-experience');
  
  // Flat-surface detection state
  let isSurfaceFlat = false;
  let recentHitHeights = []; // Rolling buffer of Y-position samples (last 10 frames)
  const flatnessThreshold = 0.015; // ~1.5 cm variance threshold
  let placedModelRedOverlay = null; // Red material overlay for not-flat state
  
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
    console.warn('[AR Session] hit-test required failed:', error?.name, error?.message, '— retrying without hit-test...');
    try {
      // Fallback: try without hit-test as required
      session = await navigator.xr.requestSession('immersive-ar', {
        optionalFeatures: ['hit-test', 'local-floor', 'dom-overlay', 'plane-detection'],
        domOverlay: { root }
      });
      state.hitTestRequired = false;
      console.log('[AR Session] ✓ Session created without hit-test requirement');
    } catch (finalError) {
      // Log detailed diagnostics
      console.error('[AR Session] XR session request failed:', {
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
  console.log('[AR Session] ✓ XR session created successfully');

  // Load THREE.js if needed
  if (!THREE) await loadThreeJS();

  const canvas = $('#xr-canvas');
  const gl = canvas.getContext('webgl2', { xrCompatible: true, alpha: true });
  if (!gl) {
    console.warn('[AR Session] WebGL2 not available, falling back to WebGL');
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
      console.log('[AR Session] ✓ Hit-test source initialized');
    } catch (err) {
      console.warn('[AR Session] Hit-test source unavailable:', err?.name, err?.message);
      state.hitTestSource = null;
    }
  }

  const product = state.selected;
  $('#ar-mode-label').textContent = state.arPurpose === 'measurement' ? 'Tap point A, then point B on the floor.' : 'Move your phone slowly to find the floor, then tap to place.';
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

  if (THREE && state.loadedModel) {
    console.log('[AR Render] Setting up THREE.js renderer for real 3D model');
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

      // Setup model controls (buttons work in native AR too)
      const nativeARSyncSize = () => {
        // In native AR, model position is controlled by hit-test placement
        // but we can still scale/rotate for preview before final placement
      };
      setupModelControls(placedModel, nativeARSyncSize);
      $('#model-controls').hidden = false;

      console.log('[AR Render] ✓ THREE.js scene initialized with 3D model');
    } catch (error) {
      console.error('[AR Render] Failed to initialize THREE.js:', error.message);
      renderer = null;
    }
  }

  let renderLogged = false;
  function frame(time, xrFrame) {
    session.requestAnimationFrame(frame);
    const pose = xrFrame.getViewerPose(state.referenceSpace);
    if (!pose) return;

    const hits = state.hitTestSource ? xrFrame.getHitTestResults(state.hitTestSource) : [];
    state.latestHitPose = hits[0]?.getPose(state.referenceSpace) || null;

    // ===== FLAT-SURFACE DETECTION =====
    if (state.arPurpose === 'placement' && state.latestHitPose) {
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

      // Apply visual feedback based on flatness
      if (placedModel) {
        if (!isSurfaceFlat) {
          // Not flat: tint model red, disable placement
          if (!placedModelRedOverlay) {
            placedModelRedOverlay = new THREE.MeshBasicMaterial({ color: 0xff4444, transparent: true, opacity: 0.4 });
          }
          placedModel.traverse(child => {
            if (child instanceof THREE.Mesh) {
              child.material = placedModelRedOverlay;
            }
          });
          $('#ar-mode-label').textContent = 'Surface looks uneven — find a flatter spot to place this item.';
          state.placementBlocked = true;
        } else {
          // Flat: restore original material, enable placement
          if (placedModelRedOverlay) {
            // Restore original materials by reloading if needed
            placedModel.traverse(child => {
              if (child instanceof THREE.Mesh && child.userData?.originalMaterial) {
                child.material = child.userData.originalMaterial;
              }
            });
          }
          $('#ar-mode-label').textContent = 'Flat surface detected. Tap to place.';
          state.placementBlocked = false;
        }
      }
    }
    // ===== END FLAT-SURFACE DETECTION =====

    // Live measurement display during measurement mode

    if (state.arPurpose === 'measurement' && state.arPoints.length === 1 && state.latestHitPose) {
      const point0 = state.arPoints[0];
      const hitPos = state.latestHitPose.transform.position;
      const liveDistanceM = Math.sqrt(
        (point0.x - hitPos.x) ** 2 +
        (point0.y - hitPos.y) ** 2 +
        (point0.z - hitPos.z) ** 2
      );
      updateLiveMeasurementDisplay(liveDistanceM);
    } else {
      hideLiveMeasurement();
    }

    if (!state.latestHitPose || state.arPurpose !== 'placement') return;

    // Use THREE.js renderer if available and model is loaded
    if (renderer && scene && placedModel && !renderLogged) {
      console.log(`[AR Render] Starting 3D model render loop for "${product.name}"`);
      renderLogged = true;
    }

    gl.bindFramebuffer(gl.FRAMEBUFFER, layer.framebuffer);
    gl.clearColor(0, 0, 0, 0);
    gl.clear(gl.COLOR_BUFFER_BIT | gl.DEPTH_BUFFER_BIT);
    gl.enable(gl.DEPTH_TEST);

    if (renderer && scene && placedModel) {
      // THREE.js rendering path
      for (const view of pose.views) {
        const viewport = layer.getViewport(view);
        gl.viewport(viewport.x, viewport.y, viewport.width, viewport.height);

        // Update camera with XR view
        camera.projectionMatrix.fromArray(view.projectionMatrix);
        camera.matrix.fromArray(view.transform.matrix);
        camera.matrixAutoUpdate = false;
        camera.updateMatrix();

        const placement = state.placedMatrix || state.latestHitPose.transform.matrix;
        const placementMatrix = new THREE.Matrix4().fromArray(placement);
        placedModel.position.setFromMatrixPosition(placementMatrix);
        placedModel.quaternion.setFromRotationMatrix(placementMatrix);

        renderer.render(scene, camera);
      }
    } else {
      // Fallback to cube rendering
      const dimensions = product.dimensions;
      const placement = state.placedMatrix || state.latestHitPose.transform.matrix;
      for (const view of pose.views) {
        const viewport = layer.getViewport(view);
        gl.viewport(viewport.x, viewport.y, viewport.width, viewport.height);
        const model = translateScale(placement, 0, dimensions.height / 200, 0, dimensions.width / 200, dimensions.height / 200, dimensions.depth / 200);
        fallbackRenderer.draw(matrixMultiply(view.projectionMatrix, matrixMultiply(view.transform.inverse.matrix, model)), [red, green, blue, .72]);
      }
    }
  }

  session.requestAnimationFrame(frame);
}

function captureNativePoint(frame) {
  const pose = state.latestHitPose;
  if (!pose) { toast('Move slowly until the floor target is detected, then tap again.'); return; }
  if (state.placementBlocked) { toast('Surface is uneven. Find a flatter spot to place this item.'); return; }
  const point = pose.transform.position;
  if (state.arPurpose === 'placement') { 
    state.placedMatrix = pose.transform.matrix.slice(); 
    console.log(`[AR Placement] "${state.selected.name}" placed at position (${point.x.toFixed(2)}, ${point.y.toFixed(2)}, ${point.z.toFixed(2)})`);
    if (state.loadedModel) {
      console.log(`[AR Placement] ✓ 3D model "${state.selected.name}" will render at placement point`);
    } else {
      console.log(`[AR Placement] ℹ Using box renderer for "${state.selected.name}"`);
    }
    $('#ar-mode-label').textContent = 'Placed. Walk around it to check the fit.'; 
    toast(`${state.selected.name} is placed at true scale. Walk around it to inspect the fit.`); 
    return; 
  }
  
  // Measurement mode: handle initial scan and confirmatory scan
  if (!state.arNeedsConfirmation) {
    // Initial measurement scan
    state.arPoints.push({ x: point.x, y: point.y, z: point.z });
    if (state.arPoints.length === 1) { 
      $('#ar-mode-label').textContent = 'Point A captured. Now tap point B.'; 
      toast('Point A captured. Tap the other side of the opening.'); 
      return; 
    }
    // Got both points for initial measurement
    state.arMeasurement = distanceBetween(state.arPoints[0], state.arPoints[1]) * 100;
    state.arNeedsConfirmation = true;
    state.arPoints = [];
    $('#ar-mode-label').textContent = 'First measurement complete. Tap to start confirmatory scan of the SAME span.';
    toast(`Initial reading: ${cm(state.arMeasurement)}. Please confirm by scanning the same span again.`);
    return;
  }
  
  // Confirmatory measurement scan
  state.arPoints.push({ x: point.x, y: point.y, z: point.z });
  if (state.arPoints.length === 1) { 
    $('#ar-mode-label').textContent = 'Point A captured. Tap point B to complete the confirmatory scan.'; 
    toast('Confirmatory scan - Point A captured.'); 
    return; 
  }
  
  // Got confirmatory measurement
  state.arConfirmationMeasurement = distanceBetween(state.arPoints[0], state.arPoints[1]) * 100;
  
  // Calculate difference and validate
  const diff = Math.abs(state.arMeasurement - state.arConfirmationMeasurement);
  const percentDiff = (diff / state.arMeasurement) * 100;
  
  if (percentDiff > 5) {
    // Readings differ by more than 5%
    $('#ar-mode-label').innerHTML = `<span style="color: #d32f2f;">⚠ Readings differ by ${Math.round(percentDiff)}%</span><br />Initial: ${cm(state.arMeasurement)} vs Confirmatory: ${cm(state.arConfirmationMeasurement)}<br />Tap to rescan or close the AR view to use the initial reading.`;
    toast(`Measurements differ by ${Math.round(percentDiff)}%. Within 5% is preferred. Rescan or accept?`);
    state.arPoints = [];
    state.arNeedsConfirmation = false;
    state.arMeasurement = null;
    state.arConfirmationMeasurement = null;
    return;
  }
  
  // Within 5% - average the readings
  const finalMeasurement = (state.arMeasurement + state.arConfirmationMeasurement) / 2;
  $('#point-a').value = 0;
  $('#point-b').value = Math.round(finalMeasurement);
  updateFitVerdict();
  toast(`Measurements verified (within 5%). Averaged: ${cm(finalMeasurement)}`);
  state.session?.end();
  
  // Reset
  state.arPoints = [];
  state.arMeasurement = null;
  state.arConfirmationMeasurement = null;
  state.arNeedsConfirmation = false;
}

async function startCameraFallback() {
  const product = state.selected;
  const isPlacement = state.arPurpose === 'placement';
  const fallbackHost = $('#fallback-product');
  const cameraVideo = $('#camera-feed');

  setARMode('camera-preview');

  $('#ar-mode-label').textContent = isPlacement
    ? 'Camera preview — drag to rotate, pinch to check scale. This device can\'t track the room, so use this to judge fit, not exact placement.'
    : 'Camera preview active — use the two fields after closing to enter your tape measure reading.';

  $('#xr-canvas').style.display = 'none';
  $('#fallback-product').style.display = isPlacement ? 'block' : 'none';
  cameraVideo.style.display = 'block';
  cameraVideo.style.opacity = '1';
  cameraVideo.style.zIndex = '1';
  fallbackHost.style.zIndex = '2';

  if (isPlacement) {
    // This is an unanchored, device-side approximation for fit checking only.
    // It is not tracked AR; the real room placement still comes from native WebXR.
    const fallbackCanvas = document.createElement('canvas');
    fallbackHost.innerHTML = '';
    fallbackHost.appendChild(fallbackCanvas);

    const model = await loadScaledModel(product);
    if (!model || !THREE || !fallbackCanvas) {
      setARMode('illustration-only');
      fallbackHost.innerHTML = `<div class="fallback-message">3D preview unavailable. Use guided measurement to check fit.</div>`;
      return;
    }

    const context = fallbackCanvas.getContext('webgl2', { alpha: true, antialias: true, premultipliedAlpha: false });
    if (!context) {
      setARMode('illustration-only');
      fallbackHost.innerHTML = `<div class="fallback-message">3D preview unavailable. Use guided measurement to check fit.</div>`;
      return;
    }

    const renderer = new THREE.WebGLRenderer({ canvas: fallbackCanvas, antialias: true, alpha: true, powerPreference: 'high-performance', premultipliedAlpha: false });
    renderer.setClearColor(0x000000, 0);
    renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 2));
    renderer.outputColorSpace = THREE.SRGBColorSpace;

    const scene = new THREE.Scene();
    const camera = new THREE.PerspectiveCamera(35, 1, 0.1, 1000);
    camera.position.set(0, 0.9, 2.8);

    const ambient = new THREE.HemisphereLight(0xffffff, 0x000000, 1.2);
    const key = new THREE.DirectionalLight(0xffffff, 1);
    key.position.set(2, 3, 2.5);
    scene.add(ambient, key);

    const modelRoot = model.clone();
    modelRoot.rotation.y = 0.6;
    scene.add(modelRoot);

    let currentScale = 1;
    let dragX = 0;
    let pinchDistance = null;
    let pinchStableFrames = 0; // Track stable pinch detection

    const updateScaleLabel = () => {
      const smoothScale = Math.round(currentScale * 20) / 20; // Round to nearest 5%
      const percent = Math.round((smoothScale / 1) * 100);
      $('#ar-mode-label').textContent = `Camera preview — drag to rotate, pinch to check scale. This device can't track the room, so use this to judge fit, not exact placement. Current size: ${percent}% of true scale.`;
    };

    const syncSize = () => {
      modelRoot.scale.setScalar(currentScale);
      // Re-center model on every scale change to keep it grounded at the same visual spot
      const scaledBbox = new THREE.Box3().setFromObject(modelRoot);
      const center = scaledBbox.getCenter(new THREE.Vector3());
      modelRoot.position.x = -center.x;
      modelRoot.position.y = -scaledBbox.min.y;
      modelRoot.position.z = -center.z;
      updateScaleLabel();
    };

    const resize = () => {
      const bounds = fallbackHost.getBoundingClientRect();
      const width = Math.max(bounds.width, 200);
      const height = Math.max(bounds.height, 160);
      renderer.setSize(width, height, false);
      camera.aspect = width / height;
      camera.updateProjectionMatrix();
    };

    resize();
    syncSize();

    // Setup model controls (rotate, move, zoom, reset buttons)
    setupModelControls(modelRoot, syncSize);
    $('#model-controls').hidden = false;

    fallbackHost.addEventListener('pointerdown', event => {
      fallbackHost.setPointerCapture(event.pointerId);
      fallbackHost.dataset.dragX = String(event.clientX);
    });

    fallbackHost.addEventListener('pointermove', event => {
      if (!fallbackHost.hasPointerCapture(event.pointerId)) return;
      const previousX = Number(fallbackHost.dataset.dragX || event.clientX);
      const delta = event.clientX - previousX;
      if (Math.abs(delta) > 1) {
        dragX += delta * 0.01;
        modelRoot.rotation.y = dragX;
        fallbackHost.dataset.dragX = String(event.clientX);
      }
    });

    fallbackHost.addEventListener('wheel', event => {
      event.preventDefault();
      currentScale = Math.min(3, Math.max(0.3, currentScale + (event.deltaY > 0 ? -0.1 : 0.1)));
      syncSize();
    }, { passive: false });

    fallbackHost.addEventListener('touchstart', event => {
      if (event.touches.length === 2) {
        const [a, b] = [event.touches[0], event.touches[1]];
        pinchDistance = Math.hypot(a.clientX - b.clientX, a.clientY - b.clientY);
        pinchStableFrames = 0; // Reset stability counter on new pinch start
      }
    }, { passive: true });

    fallbackHost.addEventListener('touchmove', event => {
      if (event.touches.length === 2 && pinchDistance) {
        const [a, b] = [event.touches[0], event.touches[1]];
        const nextDistance = Math.hypot(a.clientX - b.clientX, a.clientY - b.clientY);
        const deltaDistance = Math.abs(nextDistance - pinchDistance);
        
        // Require at least ~10px of movement to filter out accidental 2-touch frames
        if (deltaDistance > 10) {
          pinchStableFrames++;
          // Only apply scale after two consecutive stable frames confirm intentional pinch
          if (pinchStableFrames > 1) {
            const ratio = nextDistance / (pinchDistance || 1);
            currentScale = Math.min(2.0, Math.max(0.5, currentScale * ratio));
            syncSize();
          }
        }
        pinchDistance = nextDistance;
      }
    }, { passive: true });

    fallbackHost.addEventListener('touchend', event => {
      if (event.touches.length < 2) pinchDistance = null;
      pinchStableFrames = 0;
    }, { passive: true });

    fallbackHost.addEventListener('touchcancel', () => {
      pinchDistance = null;
      pinchStableFrames = 0;
    }, { passive: true });

    const tick = () => {
      renderer.setClearColor(0x000000, 0);
      renderer.render(scene, camera);
      requestAnimationFrame(tick);
    };
    tick();
    window.addEventListener('resize', resize, { passive: true });
    state.fallbackRender = { renderer, scene, camera, modelRoot, tick, resize };
    updateScaleLabel();

    // Gyroscope-based tilt detection for camera-preview fallback (D5)
    // Best-effort approximation: warn if device is tilted too far to judge flatness reliably
    if (window.DeviceOrientationEvent) {
      let lastCheck = 0;
      let latestBeta = 0;
      const statusEl = $('#ar-mode-label');
      const warning = 'Hold the phone more level for better surface detection in preview mode.';
      const normalMessage = statusEl.textContent;
      const updateOrientationWarning = (message) => {
        const nextMessage = message || normalMessage;
        if (statusEl.dataset.lastMsg === nextMessage) return;
        statusEl.dataset.lastMsg = nextMessage;
        statusEl.textContent = nextMessage;
      };
      const onOrientationTick = (timestamp) => {
        if (timestamp - lastCheck < 400) return;
        lastCheck = timestamp;
        updateOrientationWarning(Math.abs(latestBeta) > 45 ? warning : '');
      };
      window.addEventListener('deviceorientation', (event) => {
        latestBeta = event.beta || 0;
        onOrientationTick(performance.now());
      }, { passive: true });
    }
  }

  if (!navigator.mediaDevices?.getUserMedia) {
    $('#camera-feed').style.display = 'none';
    setARMode('illustration-only');
    $('#ar-mode-label').textContent = 'Camera access is not available. Use the guided measurement fields.';
    return;
  }

  try {
    state.cameraStream = await navigator.mediaDevices.getUserMedia({ video: { facingMode: { ideal: 'environment' } }, audio: false });
    $('#camera-feed').srcObject = state.cameraStream;
  } catch {
    $('#camera-feed').style.display = 'none';
    setARMode('illustration-only');
    $('#ar-mode-label').textContent = 'Camera permission was not granted. Use the guided measurement fields.';
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
        console.log(`[AR Flow] iOS Quick Look opened for ${product.modelUsdz}`);
        toast('Opening the native AR Quick Look viewer on iPhone Safari.');
        return;
      } else {
        console.warn(`[AR Flow] USDZ file returned ${response.status} at ${product.modelUsdz}`, { url: product.modelUsdz });
      }
    } catch (err) {
      console.warn(`[AR Flow] Could not verify USDZ availability (${err?.message}), falling back to WebXR/camera`, { url: product.modelUsdz, error: err?.message });
    }
  }

  mountARExperience();
  state.arPurpose = purpose; state.arPoints = []; state.placedMatrix = null; $('#camera-feed').style.display = ''; $('#xr-canvas').style.display = ''; $('#fallback-product').style.display = 'none';
  console.log(`[AR Flow] Starting AR experience for "${state.selected.name}" (${purpose} mode)`);
  try {
    const supportsAR = await checkARSupport();
    if (supportsAR) await startNativeAR(); else await startCameraFallback();
  } catch (error) {
    console.error('[AR Flow] Native AR start failed:', {
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
  $('#model-controls').hidden = true;

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

  state.cameraStream?.getTracks().forEach(track => track.stop());
  state.cameraStream = null;
  $('#camera-feed').srcObject = null;
  $('#fallback-product').style.display = 'none';
  unmountARExperience();
  state.placedMatrix = null;

  state.arPoints = [];
  state.arMeasurement = null;
  state.arConfirmationMeasurement = null;
  state.arNeedsConfirmation = false;
}

async function login(event) {
  event.preventDefault(); $('#login-error').textContent = '';
  const fields = new FormData(event.currentTarget);
  try { const response = await api('/api/auth/login', { method: 'POST', body: JSON.stringify(Object.fromEntries(fields)) }); state.token = response.token; state.user = response.user; sessionStorage.setItem('furnishar-token', state.token); sessionStorage.setItem('furnishar-user', JSON.stringify(state.user)); event.currentTarget.reset(); renderAdmin(); toast(`Signed in to ${state.user.store}.`); }
  catch (error) { $('#login-error').textContent = error.message; }
}

function renderAdmin() {
  const loggedIn = Boolean(state.token && state.user);
  $('#login-panel').hidden = loggedIn; $('#dashboard').hidden = !loggedIn;
  if (!loggedIn) return;
  const own = state.products.filter(product => product.storeId === state.user.storeId);
  const store = state.products.length > 0 && own.length > 0 ? own[0] : null;
  // Determine plan from first product or default to freemium
  const planInfo = store ? (state.products.find(p => p.storeId === state.user.storeId) ? 'Plan: Premium' : 'Plan: Freemium') : 'Plan: Freemium';
  const FREEMIUM_LIMIT = 8;
  const isFree = planInfo.includes('Freemium');
  const slotsRemaining = isFree ? Math.max(0, FREEMIUM_LIMIT - own.length) : null;
  $('#owner-store').textContent = state.user.store;
  $('#inventory-summary').innerHTML = `<div class="inventory-stat"><span>${planInfo}</span></div><div class="inventory-stat"><span>Listed products</span><strong>${own.length}${isFree ? `/${FREEMIUM_LIMIT}` : ''}</strong></div><div class="inventory-stat"><span>Units available</span><strong>${own.reduce((sum, product) => sum + product.stock, 0)}</strong></div><div class="inventory-stat"><span>Catalog value</span><strong>${peso(own.reduce((sum, product) => sum + product.price * product.stock, 0))}</strong></div>`;
  $('#inventory-body').innerHTML = own.length ? own.map(product => `<tr><td>${escapeHtml(product.name)}<small>${escapeHtml(product.category)} · ${escapeHtml(product.color)}</small></td><td>${product.dimensions.width} × ${product.dimensions.depth} × ${product.dimensions.height} cm</td><td>${peso(product.price)}</td><td>${product.stock}</td><td><small style="color: #999;">${relativeTime(product.updatedAt)}</small></td><td><div class="table-actions"><button class="icon-button" data-edit-product="${product.id}">Edit</button><button class="icon-button delete" data-delete-product="${product.id}">Delete</button></div></td></tr>`).join('') : '<tr><td colspan="6">No products listed yet. Add your first product above.</td></tr>';
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
  $('#product-form-dialog').showModal();
}

async function saveProduct(event) {
  event.preventDefault(); const form = event.currentTarget; const values = Object.fromEntries(new FormData(form)); $('#product-form-error').textContent = '';
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
  try { await api(values.id ? `/api/products/${values.id}` : '/api/products', { method: values.id ? 'PUT' : 'POST', body: JSON.stringify(product) }); await loadProducts(); $('#product-form-dialog').close(); toast(values.id ? 'Product updated.' : 'Product added to the catalog.'); }
  catch (error) { $('#product-form-error').textContent = error.message; }
}

async function deleteProduct(id) {
  const product = state.products.find(item => item.id === id); if (!product || !confirm(`Remove “${product.name}” from your catalog?`)) return;
  try { await api(`/api/products/${id}`, { method: 'DELETE' }); if (state.selected?.id === id) state.selected = null; await loadProducts(); toast('Product removed from the catalog.'); }
  catch (error) { toast(error.message); }
}

async function loadProducts() {
  const data = await api('/api/products'); 
  state.products = data.products;
  // Load store information
  try {
    const storesData = await api('/api/stores');
    state.stores = {};
    storesData.stores.forEach(store => {
      state.stores[store.id] = store;
    });
  } catch (error) {
    console.warn('Could not load store information:', error);
  }
  if (!state.selected || !state.products.some(product => product.id === state.selected.id)) state.selected = state.products[0] || null;
  renderColors(); renderCatalog(); renderPlanner(); renderAdmin();
}

function bindEvents() {
  if (typeof document === 'undefined') return;  // Skip on server
  document.addEventListener('click', event => {
    const view = event.target.closest('[data-view]')?.dataset.view; if (view) { changeView(view); return; }
    const open = event.target.closest('[data-open-product]')?.dataset.openProduct; if (open) return openProduct(open);
    const color = event.target.closest('[data-color]')?.dataset.color; if (color !== undefined) { state.filters.color = state.filters.color === color ? '' : color; renderColors(); renderCatalog(); return; }
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
  $('#login-form').addEventListener('submit', login); $('#logout').addEventListener('click', () => { state.token = ''; state.user = null; sessionStorage.removeItem('furnishar-token'); sessionStorage.removeItem('furnishar-user'); renderAdmin(); toast('Signed out.'); });
  $('#add-product').addEventListener('click', () => openProductForm()); $('#product-form').addEventListener('submit', saveProduct);
}

async function init() {
  bindEvents();
  try {
    // Pre-load THREE.js in parallel with products
    await Promise.all([
      loadProducts(),
      loadThreeJS(),
      checkARSupport()
    ]);
  } catch (error) {
    $('#product-grid').innerHTML = `<div class="no-results"><b>FurnishAR could not reach its local catalog.</b><br /><small>Start the app with <code>npm run local</code> and refresh this page.</small></div>`;
    toast(error.message);
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
