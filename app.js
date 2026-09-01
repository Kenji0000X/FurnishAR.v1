/* FurnishAR client — no build step required. It talks to the local Node API. */
const state = {
  products: [],
  selected: null,
  filters: { search: '', category: '', store: '', width: 240, color: '' },
  session: null,
  hitTestSource: null,
  referenceSpace: null,
  latestHitPose: null,
  placedMatrix: null,
  arPurpose: null,
  arPoints: [],
  cameraStream: null,
  token: (typeof sessionStorage !== 'undefined' ? sessionStorage.getItem('furnishar-token') : null) || '',
  user: JSON.parse((typeof sessionStorage !== 'undefined' ? sessionStorage.getItem('furnishar-user') : null) || 'null')
};

const $ = (selector, parent = document) => parent.querySelector(selector);
const $$ = (selector, parent = document) => [...parent.querySelectorAll(selector)];
const peso = value => new Intl.NumberFormat('en-PH', { style: 'currency', currency: 'PHP', maximumFractionDigits: 0 }).format(value);
const cm = value => `${Math.round(value)} cm`;
const colorStyles = { Sand: '#d4b18b', Oak: '#aa7953', Terracotta: '#c46e50', Walnut: '#725343', Black: '#474b47', White: '#d9d4ca', Natural: '#b58d62' };

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
      <div class="product-image">${furniture(product)}<span class="ar-badge">⌑ AR READY</span><button class="view-button" data-open-product="${product.id}" aria-label="View ${product.name}">→</button></div>
      <div class="product-info"><p class="product-store">${product.store}</p><h3 class="product-name">${product.name}</h3><div class="product-meta"><span class="product-price">${peso(product.price)}</span><span class="product-dimension">${product.dimensions.width} × ${product.dimensions.depth} × ${product.dimensions.height} cm</span></div></div>
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
  $('#dialog-content').innerHTML = `<div class="dialog-layout"><div class="dialog-image">${furniture(product)}</div><div class="dialog-info"><p class="product-store">${product.store} · ${product.category}</p><h2>${product.name}</h2><p class="dialog-price">${peso(product.price)}</p><p>${product.description}</p><div class="dialog-dimensions"><div><span>WIDTH</span><b>${cm(product.dimensions.width)}</b></div><div><span>DEPTH</span><b>${cm(product.dimensions.depth)}</b></div><div><span>HEIGHT</span><b>${cm(product.dimensions.height)}</b></div></div><button class="button button-primary" data-place-product="${product.id}">⌑ Place in your room</button><button class="button button-outline" data-plan-product="${product.id}">Measure the fit first</button></div></div>`;
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
  $('#planner-product').innerHTML = `<div class="planner-product-inner">${furniture(product)}<div><h3>${product.name}</h3><p>${product.store}</p><p>${product.dimensions.width} W × ${product.dimensions.depth} D × ${product.dimensions.height} H</p></div></div>`;
  $('#check-width').textContent = cm(product.dimensions.width);
  $('#check-depth').textContent = cm(product.dimensions.depth);
  $('#ar-product-name').textContent = product.name;
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
  if (!window.isSecureContext) { status.textContent = 'Use HTTPS (or localhost) to enable camera and WebXR. Guided measurement is still available.'; return false; }
  if (!navigator.xr) { status.textContent = 'WebXR is unavailable in this browser. The camera preview and guided measurement will still work.'; return false; }
  try {
    const supported = await navigator.xr.isSessionSupported('immersive-ar');
    status.textContent = supported ? 'AR-ready device detected. Use a bright, textured floor for best tracking.' : 'This device does not expose immersive AR. A camera preview will be used instead.';
    return supported;
  } catch { status.textContent = 'AR availability could not be checked. Guided measurement is available.'; return false; }
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

async function startNativeAR() {
  const root = $('#ar-experience');
  const session = await navigator.xr.requestSession('immersive-ar', { requiredFeatures: ['hit-test'], optionalFeatures: ['local-floor', 'dom-overlay'], domOverlay: { root } });
  state.session = session;
  const canvas = $('#xr-canvas');
  const gl = canvas.getContext('webgl', { xrCompatible: true, alpha: true });
  await gl.makeXRCompatible();
  const layer = new XRWebGLLayer(session, gl);
  session.updateRenderState({ baseLayer: layer });
  const viewerSpace = await session.requestReferenceSpace('viewer');
  state.referenceSpace = await session.requestReferenceSpace('local');
  state.hitTestSource = await session.requestHitTestSource({ space: viewerSpace });
  const renderer = arRenderer(gl);
  const product = state.selected;
  const [red, green, blue] = (colorFor(product).match(/[a-f\d]{2}/gi) || ['8c','9d','88']).map(value => parseInt(value, 16) / 255);
  $('#ar-mode-label').textContent = state.arPurpose === 'measurement' ? 'Tap point A, then point B on the floor.' : 'Move your phone slowly to find the floor, then tap to place.';
  session.addEventListener('select', event => captureNativePoint(event.frame));
  session.addEventListener('end', cleanupAR);
  function frame(time, xrFrame) {
    session.requestAnimationFrame(frame);
    const pose = xrFrame.getViewerPose(state.referenceSpace); if (!pose) return;
    const hits = xrFrame.getHitTestResults(state.hitTestSource);
    state.latestHitPose = hits[0]?.getPose(state.referenceSpace) || null;
    gl.bindFramebuffer(gl.FRAMEBUFFER, layer.framebuffer); gl.clearColor(0, 0, 0, 0); gl.clear(gl.COLOR_BUFFER_BIT | gl.DEPTH_BUFFER_BIT); gl.enable(gl.DEPTH_TEST);
    if (!state.latestHitPose || state.arPurpose !== 'placement') return;
    const dimensions = product.dimensions;
    const placement = state.placedMatrix || state.latestHitPose.transform.matrix;
    for (const view of pose.views) { const viewport = layer.getViewport(view); gl.viewport(viewport.x, viewport.y, viewport.width, viewport.height); const model = translateScale(placement, 0, dimensions.height / 200, 0, dimensions.width / 200, dimensions.height / 200, dimensions.depth / 200); renderer.draw(matrixMultiply(view.projectionMatrix, matrixMultiply(view.transform.inverse.matrix, model)), [red, green, blue, .72]); }
  }
  session.requestAnimationFrame(frame);
}

function captureNativePoint(frame) {
  const pose = state.latestHitPose;
  if (!pose) { toast('Move slowly until the floor target is detected, then tap again.'); return; }
  const point = pose.transform.position;
  if (state.arPurpose === 'placement') { state.placedMatrix = pose.transform.matrix.slice(); $('#ar-mode-label').textContent = 'Placed. Walk around it to check the fit.'; toast(`${state.selected.name} is placed at true scale. Walk around it to inspect the fit.`); return; }
  state.arPoints.push({ x: point.x, y: point.y, z: point.z });
  if (state.arPoints.length === 1) { $('#ar-mode-label').textContent = 'Point A captured. Now tap point B.'; toast('Point A captured. Tap the other side of the opening.'); return; }
  const scan = distanceBetween(state.arPoints[0], state.arPoints[1]) * 100;
  $('#point-a').value = 0; $('#point-b').value = Math.round(scan); updateFitVerdict();
  toast(`Measured ${cm(scan)}. Comparing it with the selected furniture.`); state.session?.end();
}

async function startCameraFallback() {
  $('#ar-mode-label').textContent = state.arPurpose === 'measurement' ? 'Camera preview active — use the two fields after closing to enter your tape measure reading.' : 'Camera preview active — drag your phone to judge the scale and placement.';
  $('#xr-canvas').style.display = 'none';
  $('#fallback-product').style.display = state.arPurpose === 'placement' ? 'block' : 'none';
  if (state.arPurpose === 'placement') $('#fallback-product').innerHTML = furniture(state.selected);
  if (!navigator.mediaDevices?.getUserMedia) { $('#camera-feed').style.display = 'none'; $('#ar-mode-label').textContent = 'Camera access is not available. Use the guided measurement fields.'; return; }
  try { state.cameraStream = await navigator.mediaDevices.getUserMedia({ video: { facingMode: { ideal: 'environment' } }, audio: false }); $('#camera-feed').srcObject = state.cameraStream; }
  catch { $('#camera-feed').style.display = 'none'; $('#ar-mode-label').textContent = 'Camera permission was not granted. Use the guided measurement fields.'; }
}

async function startExperience(purpose) {
  if (!state.selected) return toast('Choose a product first.');
  state.arPurpose = purpose; state.arPoints = []; state.placedMatrix = null; $('#ar-experience').hidden = false; $('#camera-feed').style.display = ''; $('#xr-canvas').style.display = ''; $('#fallback-product').style.display = 'none';
  try {
    const supportsAR = await checkARSupport();
    if (supportsAR) await startNativeAR(); else await startCameraFallback();
  } catch (error) { console.warn(error); await startCameraFallback(); toast('Live AR could not start; switched to the camera preview.'); }
}

function cleanupAR() {
  state.hitTestSource?.cancel?.(); state.hitTestSource = null; state.referenceSpace = null; state.latestHitPose = null; state.session = null;
  state.cameraStream?.getTracks().forEach(track => track.stop()); state.cameraStream = null;
  $('#camera-feed').srcObject = null; $('#fallback-product').style.display = 'none'; $('#ar-experience').hidden = true; state.placedMatrix = null;
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
  $('#owner-store').textContent = state.user.store;
  $('#inventory-summary').innerHTML = `<div class="inventory-stat"><span>Listed products</span><strong>${own.length}</strong></div><div class="inventory-stat"><span>Units available</span><strong>${own.reduce((sum, product) => sum + product.stock, 0)}</strong></div><div class="inventory-stat"><span>Catalog value</span><strong>${peso(own.reduce((sum, product) => sum + product.price * product.stock, 0))}</strong></div>`;
  $('#inventory-body').innerHTML = own.length ? own.map(product => `<tr><td>${product.name}<small>${product.category} · ${product.color}</small></td><td>${product.dimensions.width} × ${product.dimensions.depth} × ${product.dimensions.height} cm</td><td>${peso(product.price)}</td><td>${product.stock}</td><td><div class="table-actions"><button class="icon-button" data-edit-product="${product.id}">Edit</button><button class="icon-button delete" data-delete-product="${product.id}">Delete</button></div></td></tr>`).join('') : '<tr><td colspan="5">No products listed yet. Add your first product above.</td></tr>';
}

function openProductForm(product = null) {
  const form = $('#product-form'); form.reset(); $('#product-form-error').textContent = ''; $('#form-title').textContent = product ? 'Edit product' : 'Add a product';
  if (product) { form.elements.id.value = product.id; for (const key of ['name', 'category', 'style', 'color', 'price', 'stock', 'model', 'description']) form.elements[key].value = product[key]; form.elements.width.value = product.dimensions.width; form.elements.height.value = product.dimensions.height; form.elements.depth.value = product.dimensions.depth; }
  $('#product-form-dialog').showModal();
}

async function saveProduct(event) {
  event.preventDefault(); const form = event.currentTarget; const values = Object.fromEntries(new FormData(form)); $('#product-form-error').textContent = '';
  const product = { ...values, price: Number(values.price), stock: Number(values.stock), dimensions: { width: Number(values.width), height: Number(values.height), depth: Number(values.depth) } };
  try { await api(values.id ? `/api/products/${values.id}` : '/api/products', { method: values.id ? 'PUT' : 'POST', body: JSON.stringify(product) }); await loadProducts(); $('#product-form-dialog').close(); toast(values.id ? 'Product updated.' : 'Product added to the catalog.'); }
  catch (error) { $('#product-form-error').textContent = error.message; }
}

async function deleteProduct(id) {
  const product = state.products.find(item => item.id === id); if (!product || !confirm(`Remove “${product.name}” from your catalog?`)) return;
  try { await api(`/api/products/${id}`, { method: 'DELETE' }); if (state.selected?.id === id) state.selected = null; await loadProducts(); toast('Product removed from the catalog.'); }
  catch (error) { toast(error.message); }
}

async function loadProducts() {
  const data = await api('/api/products'); state.products = data.products; if (!state.selected || !state.products.some(product => product.id === state.selected.id)) state.selected = state.products[0] || null;
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
  $('#exit-ar').addEventListener('click', () => state.session ? state.session.end() : cleanupAR());
  $('#login-form').addEventListener('submit', login); $('#logout').addEventListener('click', () => { state.token = ''; state.user = null; sessionStorage.removeItem('furnishar-token'); sessionStorage.removeItem('furnishar-user'); renderAdmin(); toast('Signed out.'); });
  $('#add-product').addEventListener('click', () => openProductForm()); $('#product-form').addEventListener('submit', saveProduct);
}

async function init() { bindEvents(); try { await loadProducts(); await checkARSupport(); } catch (error) { $('#product-grid').innerHTML = `<div class="no-results"><b>FurnishAR could not reach its local catalog.</b><br /><small>Start the app with <code>npm.cmd start</code> and refresh this page.</small></div>`; toast(error.message); } }
// Only initialize on browser, not on server
if (typeof document !== 'undefined') {
  init();
}
