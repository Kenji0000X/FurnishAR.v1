/**
 * The catalogue poster: one small picture of a product, rendered from its own
 * 3D model in the owner's browser, at the moment they save it.
 *
 * WHY HERE
 * The model is already parsed, measured and checked by ModelPreview when the
 * owner saves. Rendering the picture from that same scene costs one frame; a
 * server-side renderer would need a headless GPU and a second download of a
 * file that can be 80 MB. And it cannot be the wrong picture: it is drawn
 * from the exact model being uploaded, never a stock photo or another
 * product's render.
 *
 * WHAT IT IS
 *   - 640 × 640, a three-quarter view from the front-right, a little above.
 *   - Transparent WebP (quality 0.82), so the card's own surface shows
 *     through and one picture suits both themes. A furniture render at this
 *     size is typically 15–40 KB, against the model's megabytes.
 *   - A browser that cannot encode WebP gets an opaque JPEG on a neutral
 *     ground instead (JPEG has no transparency).
 *
 * FRAMING IS NOT SCALE
 * The camera moves until the piece fills the frame, so a stool and a
 * wardrobe are equally legible on their cards. That changes where the camera
 * is, never the model: its physical size is untouched, exactly as ModelPreview
 * already does for the preview (lib/spatial/model-transform.mjs).
 */

export const POSTER_SIZE = 640;
const WEBP_QUALITY = 0.82;
const JPEG_QUALITY = 0.85;
/* The only colour here that is not the model's own: the fallback ground for
   a JPEG, a light neutral close to the light theme's card surface. */
const JPEG_GROUND = 0xeef1f0;
const FILL = 0.84;                     // share of the frame the piece fills

let webpSupport = null;
function canEncodeWebp() {
  if (webpSupport === null) {
    try {
      const probe = document.createElement('canvas');
      probe.width = probe.height = 1;
      webpSupport = probe.toDataURL('image/webp').startsWith('data:image/webp');
    } catch {
      webpSupport = false;
    }
  }
  return webpSupport;
}

/**
 * Where the camera must stand to show the whole piece from `direction`,
 * centred, filling FILL of the frame. Iterates on the projected corners of
 * the bounding box rather than a bounding sphere, which would leave a long
 * sofa as a thin strip in the middle of a square.
 */
function frameCamera(THREE, camera, box, direction) {
  const centre = box.getCenter(new THREE.Vector3());
  const corners = [];
  for (const x of [box.min.x, box.max.x]) for (const y of [box.min.y, box.max.y]) for (const z of [box.min.z, box.max.z]) {
    corners.push(new THREE.Vector3(x, y, z));
  }
  const size = box.getSize(new THREE.Vector3());
  let distance = Math.max(size.length(), 1e-3) * 1.6;
  const target = centre.clone();
  const projected = new THREE.Vector3();

  for (let pass = 0; pass < 6; pass += 1) {
    camera.position.copy(target).addScaledVector(direction, distance);
    camera.near = distance / 100;
    camera.far = distance * 100;
    camera.lookAt(target);
    camera.updateProjectionMatrix();
    camera.updateMatrixWorld(true);

    let minX = Infinity, maxX = -Infinity, minY = Infinity, maxY = -Infinity;
    for (const corner of corners) {
      projected.copy(corner).project(camera);
      minX = Math.min(minX, projected.x); maxX = Math.max(maxX, projected.x);
      minY = Math.min(minY, projected.y); maxY = Math.max(maxY, projected.y);
    }
    // Re-centre: move the target by the offset of the projected box's middle.
    const offsetX = (minX + maxX) / 2;
    const offsetY = (minY + maxY) / 2;
    const depth = target.clone().project(camera).z;
    const middle = new THREE.Vector3(offsetX, offsetY, depth).unproject(camera);
    target.add(middle.sub(target).multiplyScalar(0.9));
    // Re-fit: the larger half-extent should come to FILL.
    const extent = Math.max(maxX - minX, maxY - minY) / 2;
    if (extent > 0) distance *= extent / FILL;
  }
  camera.position.copy(target).addScaledVector(direction, distance);
  camera.lookAt(target);
  camera.updateProjectionMatrix();
}

/**
 * Renders `model` (already in its scene at true scale) to a poster Blob.
 *
 * The model is lent to a private scene for one synchronous render and handed
 * straight back to its own parent, so the live preview never draws a frame
 * without it. The poster's WebGL context is released before this returns.
 */
export async function renderPoster(THREE, model) {
  const webp = canEncodeWebp();
  const canvas = document.createElement('canvas');
  canvas.width = canvas.height = POSTER_SIZE;

  const renderer = new THREE.WebGLRenderer({
    canvas, alpha: webp, antialias: true, preserveDrawingBuffer: true
  });
  try {
    renderer.setPixelRatio(1);
    renderer.setSize(POSTER_SIZE, POSTER_SIZE, false);
    renderer.outputColorSpace = THREE.SRGBColorSpace;
    renderer.toneMapping = THREE.ACESFilmicToneMapping;
    renderer.toneMappingExposure = 1.1;
    if (webp) renderer.setClearColor(0x000000, 0);
    else renderer.setClearColor(JPEG_GROUND, 1);

    const scene = new THREE.Scene();
    scene.add(new THREE.HemisphereLight(0xffffff, 0xc9c5bb, 2.0));
    const key = new THREE.DirectionalLight(0xfff6ec, 2.2);
    key.position.set(3, 5, 4);
    scene.add(key);
    const fillLight = new THREE.DirectionalLight(0xffffff, 0.6);
    fillLight.position.set(-4, 2, -2);
    scene.add(fillLight);

    const camera = new THREE.PerspectiveCamera(30, 1, 0.01, 200);
    const direction = new THREE.Vector3(0.8, 0.45, 1).normalize();

    const parent = model.parent;
    scene.add(model);
    try {
      model.updateMatrixWorld(true);
      frameCamera(THREE, camera, new THREE.Box3().setFromObject(model), direction);
      renderer.render(scene, camera);
    } finally {
      if (parent) parent.add(model); else scene.remove(model);
    }

    const type = webp ? 'image/webp' : 'image/jpeg';
    const blob = await new Promise(resolve => canvas.toBlob(resolve, type, webp ? WEBP_QUALITY : JPEG_QUALITY));
    if (!blob || !blob.size) throw new Error('The preview image could not be encoded.');
    return blob;
  } finally {
    renderer.dispose();
    renderer.forceContextLoss?.();
  }
}
