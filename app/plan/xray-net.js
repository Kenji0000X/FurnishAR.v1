'use client';

/**
 * The x-ray net: a grid drawn over the surfaces the device has actually found.
 *
 * ---------------------------------------------------------------------------
 * The one rule
 * ---------------------------------------------------------------------------
 *
 * The net is only ever drawn where WebXR has reported a real surface. It is
 * never projected onto the camera image as decoration, never extended to
 * "probably a wall", never drawn at all on a device whose browser cannot
 * detect planes. A net over a surface that was not detected is a picture of a
 * measurement rather than a measurement, and somebody would place a sofa
 * against it.
 *
 * Two layers, in order of how much the device knows:
 *
 *   1. PLANE NET — the polygon WebXR reports for each detected floor, wall or
 *      ceiling, filled with a grid. Needs the `plane-detection` feature.
 *   2. DEPTH NET — a finer grid draped over everything in view, including
 *      furniture and clutter, built from the Depth API. Needs
 *      `depth-sensing`, which fewer devices have.
 *
 * Either can be missing. The caller asks what is live and tells the user.
 *
 * ---------------------------------------------------------------------------
 * How the grid is drawn
 * ---------------------------------------------------------------------------
 *
 * Not as line geometry. A detected plane is a ragged polygon that changes
 * shape every few frames as the scan improves, and clipping grid lines to a
 * moving concave outline every frame is both fiddly and slow.
 *
 * Instead each plane is one flat mesh of its own polygon, with a shader that
 * draws the grid from world-space position. The polygon clips the grid for
 * free because the grid only exists inside the mesh, the spacing stays
 * constant in metres however the plane is angled, and updating a plane means
 * replacing its vertices, not recomputing a line set.
 */

/** Grid spacing in metres. 25 cm reads as a net without turning into fog. */
const GRID_METRES = 0.25;

const NET_VERTEX = `
  varying vec3 vWorld;
  void main() {
    vec4 world = modelMatrix * vec4(position, 1.0);
    vWorld = world.xyz;
    gl_Position = projectionMatrix * viewMatrix * world;
  }
`;

/*
   The grid itself. `fwidth` keeps the lines one pixel wide whether the
   surface is under your feet or across the room — without it, distant floor
   turns into a solid sheet of colour (every grid line falls inside one pixel)
   and near floor shows lines several centimetres thick.
*/
const NET_FRAGMENT = `
  precision mediump float;
  varying vec3 vWorld;
  uniform vec3 uColor;
  uniform float uSpacing;
  uniform float uOpacity;
  uniform float uVertical;

  float gridLine(vec2 coord) {
    vec2 grid = abs(fract(coord / uSpacing - 0.5) - 0.5) / fwidth(coord / uSpacing);
    return 1.0 - min(min(grid.x, grid.y), 1.0);
  }

  void main() {
    // A wall's grid has to run along the wall, not be cast onto it from
    // above: using x/z on a vertical surface collapses one axis and draws
    // stripes instead of squares.
    vec2 coord = uVertical > 0.5 ? vec2(length(vWorld.xz), vWorld.y) : vWorld.xz;
    float line = gridLine(coord);
    float alpha = uOpacity * (0.12 + 0.88 * line);
    if (alpha < 0.01) discard;
    gl_FragColor = vec4(uColor, alpha);
  }
`;

/**
 * Read a colour token out of the live stylesheet.
 *
 * The net's colours belong in the same place as every other colour in this
 * product. Hard-coding them here would give the palette a second home that
 * nothing keeps in step with the first — and the whole reason BRAND.md points
 * at `:root` is that there is exactly one.
 */
function tokenColour(THREE, name, fallback) {
  try {
    const value = getComputedStyle(document.documentElement).getPropertyValue(name).trim();
    if (value) return new THREE.Color(value);
  } catch { /* no document, or a value three.js cannot parse */ }
  return new THREE.Color(fallback);
}

/**
 * @param THREE            the three.js module
 * @param scene            the scene to add the net to
 * @param colours.plane    override for the plane grid colour
 * @param colours.depth    override for the depth lattice colour
 */
export function createXrayNet({ THREE, scene, colours = {} }) {
  const planeColour = colours.plane
    ? new THREE.Color(colours.plane)
    : tokenColour(THREE, '--ar-net', 0x7fd4c1);
  const depthColour = colours.depth
    ? new THREE.Color(colours.depth)
    : tokenColour(THREE, '--ar-net-depth', 0xe0a184);

  const group = new THREE.Group();
  group.renderOrder = 2;
  scene.add(group);

  /*
     Occluders: real geometry hiding virtual furniture.
     ---------------------------------------------------------------------
     A sofa pushed past the far wall used to keep drawing on top of it, which
     makes the whole scene read as a sticker over a photograph rather than an
     object in a room — and, worse for this product, hides the single clearest
     signal that a piece does not fit.

     These meshes write DEPTH ONLY: colorWrite is off, so nothing appears, but
     the depth buffer afterwards says "there is a wall here". Anything drawn
     later and further away fails the depth test and is not seen.

     They live in their own group at a lower renderOrder because the trick
     only works in that order: depth first, furniture second.
  */
  const occluders = new THREE.Group();
  occluders.renderOrder = -1;
  scene.add(occluders);

  const occluderMaterial = new THREE.MeshBasicMaterial({
    colorWrite: false,
    depthWrite: true,
    depthTest: true,
    side: THREE.DoubleSide
  });

  let occlusionOn = true;
  const occluderMeshes = new Map();

  // One mesh per XRPlane, keyed by the plane object itself. WebXR reuses the
  // same XRPlane instance as it grows, and gives a `lastChangedTime` so the
  // geometry is only rebuilt when the plane actually changed — rebuilding
  // every plane every frame is the easiest way to make this feature cost more
  // than it is worth.
  const meshes = new Map();

  let visible = true;
  let depthMesh = null;
  let depthOccluder = null;
  let depthLastBuilt = 0;

  function makeMaterial(colour, vertical) {
    return new THREE.ShaderMaterial({
      vertexShader: NET_VERTEX,
      fragmentShader: NET_FRAGMENT,
      transparent: true,
      depthWrite: false,
      side: THREE.DoubleSide,
      uniforms: {
        uColor: { value: colour },
        uSpacing: { value: GRID_METRES },
        uOpacity: { value: 0.85 },
        uVertical: { value: vertical ? 1 : 0 }
      }
    });
  }

  /**
   * Turn an XRPlane's polygon into a mesh, in the plane's own local space.
   *
   * The polygon arrives as points on the plane's X/Z plane, in order around
   * the outline. A triangle fan from the centroid covers any convex polygon
   * and every realistic concave one a tracker produces; the mesh is then
   * positioned by the plane's pose, so the vertices stay local and only the
   * transform changes as tracking refines.
   */
  function polygonGeometry(polygon) {
    const count = polygon.length;
    if (count < 3) return null;

    let cx = 0;
    let cz = 0;
    for (const point of polygon) { cx += point.x; cz += point.z; }
    cx /= count;
    cz /= count;

    const positions = new Float32Array(count * 3 * 3);
    let offset = 0;
    for (let i = 0; i < count; i++) {
      const a = polygon[i];
      const b = polygon[(i + 1) % count];
      positions[offset++] = cx;  positions[offset++] = 0; positions[offset++] = cz;
      positions[offset++] = a.x; positions[offset++] = 0; positions[offset++] = a.z;
      positions[offset++] = b.x; positions[offset++] = 0; positions[offset++] = b.z;
    }

    const geometry = new THREE.BufferGeometry();
    geometry.setAttribute('position', new THREE.BufferAttribute(positions, 3));
    return geometry;
  }

  /**
   * Read this frame's detected planes, update the net, and hand back the
   * surfaces in world space for the measuring code.
   *
   * @returns {{ supported, surfaces }} — `supported` false means this browser
   *          does not do plane detection at all, which the caller must say
   *          rather than quietly showing an empty room.
   */
  function update(frame, referenceSpace) {
    const planes = frame.detectedPlanes;
    if (!planes) return { supported: false, surfaces: [] };

    const surfaces = [];
    const alive = new Set();

    for (const plane of planes) {
      const pose = frame.getPose(plane.planeSpace, referenceSpace);
      // A plane the tracker has temporarily lost. Its mesh is kept — it will
      // almost certainly come back — but it contributes no measurement this
      // frame, because where it is is exactly what is unknown.
      if (!pose) continue;
      alive.add(plane);

      let entry = meshes.get(plane);
      const vertical = plane.orientation === 'vertical';

      if (!entry || entry.changed !== plane.lastChangedTime) {
        entry?.mesh.geometry.dispose();
        const geometry = polygonGeometry(plane.polygon);
        if (!geometry) continue;

        if (entry) {
          entry.mesh.geometry = geometry;
          entry.changed = plane.lastChangedTime;
        } else {
          const mesh = new THREE.Mesh(geometry, makeMaterial(planeColour, vertical));
          mesh.matrixAutoUpdate = false;
          group.add(mesh);
          entry = { mesh, changed: plane.lastChangedTime };
          meshes.set(plane, entry);
        }
      }

      entry.mesh.matrix.fromArray(pose.transform.matrix);
      entry.mesh.visible = visible;

      /* The same polygon again, writing depth only. Shares the plane mesh's
         geometry rather than copying it: the two are always the same shape,
         and a second copy is a second thing to keep in step and to dispose. */
      let occluder = occluderMeshes.get(plane);
      if (!occluder) {
        occluder = new THREE.Mesh(entry.mesh.geometry, occluderMaterial);
        occluder.matrixAutoUpdate = false;
        occluder.renderOrder = -1;
        occluders.add(occluder);
        occluderMeshes.set(plane, occluder);
      } else if (occluder.geometry !== entry.mesh.geometry) {
        // The plane grew and its geometry was replaced.
        occluder.geometry = entry.mesh.geometry;
      }
      occluder.matrix.copy(entry.mesh.matrix);
      occluder.visible = occlusionOn;

      // The polygon in world space, for room measurement. Done here because
      // this is the one place that already holds both the polygon and its
      // pose, and doing it twice invites the two copies to disagree.
      const matrix = entry.mesh.matrix;
      const world = plane.polygon.map(point => {
        const vector = new THREE.Vector3(point.x, 0, point.z).applyMatrix4(matrix);
        return { x: vector.x, y: vector.y, z: vector.z };
      });

      surfaces.push({
        orientation: plane.orientation,
        polygon: world,
        plane,
        semanticLabel: plane.semanticLabel || null
      });
    }

    // Planes the tracker has dropped for good.
    for (const [plane, entry] of meshes) {
      if (alive.has(plane)) continue;
      const occluder = occluderMeshes.get(plane);
      if (occluder) {
        occluders.remove(occluder);
        // The geometry belongs to the plane mesh and is disposed below; the
        // material is shared by every occluder and outlives all of them.
        occluderMeshes.delete(plane);
      }
      group.remove(entry.mesh);
      entry.mesh.geometry.dispose();
      entry.mesh.material.dispose();
      meshes.delete(plane);
    }

    return { supported: true, surfaces };
  }

  /**
   * The finer net, from the Depth API.
   *
   * Rebuilt at a few frames a second rather than every frame: reading the
   * depth buffer back to the CPU is the expensive part, and a net that
   * updates at 5 Hz looks the same to a person sweeping a room slowly while
   * costing a twelfth as much.
   *
   * @returns true when a depth net is live this frame.
   */
  function updateDepth(frame, view, referenceSpace, now) {
    if (typeof frame.getDepthInformation !== 'function') return false;
    if (now - depthLastBuilt < 200) return depthMesh !== null;

    let depth;
    try {
      depth = frame.getDepthInformation(view);
    } catch {
      return false;          // the feature was granted but is not ready
    }
    if (!depth) return false;
    depthLastBuilt = now;

    // A coarse lattice: enough to read as a net draped over real objects,
    // few enough points to rebuild without a frame-rate cost.
    const COLS = 40;
    const ROWS = 30;
    const points = [];

    for (let row = 0; row < ROWS; row++) {
      for (let col = 0; col < COLS; col++) {
        const u = (col + 0.5) / COLS;
        const v = (row + 0.5) / ROWS;
        let metres;
        try {
          metres = depth.getDepthInMeters(u, v);
        } catch {
          continue;          // outside the depth buffer's valid region
        }
        // 0 means "no reading here", and the far end is noise on most
        // hardware. Neither is drawn, so the net has holes exactly where the
        // device does not know — which is the honest picture.
        if (!(metres > 0.2) || metres > 5) continue;
        points.push({ u, v, metres, row, col });
      }
    }

    if (points.length < 16) return false;

    // Unproject each sample through the view's own projection, so the lattice
    // lands on the real geometry rather than on a flat card in front of it.
    const inverseProjection = new THREE.Matrix4()
      .fromArray(view.projectionMatrix).invert();
    const viewMatrix = new THREE.Matrix4().fromArray(view.transform.matrix);

    const positions = new Float32Array(points.length * 3);
    let offset = 0;
    for (const point of points) {
      const ndc = new THREE.Vector3(point.u * 2 - 1, (1 - point.v) * 2 - 1, -1)
        .applyMatrix4(inverseProjection);
      ndc.multiplyScalar(point.metres / Math.max(Math.abs(ndc.z), 1e-6));
      ndc.applyMatrix4(viewMatrix);
      positions[offset++] = ndc.x;
      positions[offset++] = ndc.y;
      positions[offset++] = ndc.z;
    }

    const geometry = new THREE.BufferGeometry();
    geometry.setAttribute('position', new THREE.BufferAttribute(positions, 3));

    if (depthMesh) {
      depthMesh.geometry.dispose();
      depthMesh.geometry = geometry;
    } else {
      depthMesh = new THREE.Points(
        geometry,
        new THREE.PointsMaterial({
          color: depthColour, size: 0.012, sizeAttenuation: true,
          transparent: true, opacity: 0.7, depthWrite: false
        })
      );
      group.add(depthMesh);
    }
    depthMesh.visible = visible;

    /*
       The same samples again, as a surface that writes depth.
       ------------------------------------------------------------------
       This is what makes a real table hide a virtual chair behind it, not
       only a wall the tracker happened to classify as a plane.

       Built from the lattice rather than by injecting the depth texture into
       every furniture material. Shader surgery on the model's material is the
       textbook approach and gives per-pixel edges, but it cannot be verified
       anywhere in this project's test setup, and getting it wrong does not
       degrade — it makes the furniture vanish. A 40x30 depth surface is
       coarser at the silhouette and is ordinary geometry that either draws or
       does not.

       Neighbouring samples are only joined when they agree about how far away
       they are. Across a real silhouette — the edge of a table against the
       far wall — they disagree by metres, and stitching those into a triangle
       would drape a sheet across open space and swallow anything behind it.
    */
    const index = new Map(points.map((point, i) => [`${point.row}:${point.col}`, i]));
    const triangles = [];
    const AGREE = 0.15;        // metres two neighbours may differ by

    for (const point of points) {
      const right = index.get(`${point.row}:${point.col + 1}`);
      const below = index.get(`${point.row + 1}:${point.col}`);
      const corner = index.get(`${point.row + 1}:${point.col + 1}`);
      if (right === undefined || below === undefined || corner === undefined) continue;

      const quad = [point, points[right], points[below], points[corner]];
      const depths = quad.map(q => q.metres);
      if (Math.max(...depths) - Math.min(...depths) > AGREE) continue;

      const self = index.get(`${point.row}:${point.col}`);
      triangles.push(self, right, below, right, corner, below);
    }

    if (triangles.length >= 3) {
      const occluderGeometry = new THREE.BufferGeometry();
      occluderGeometry.setAttribute('position', new THREE.BufferAttribute(positions, 3));
      occluderGeometry.setIndex(triangles);

      if (depthOccluder) {
        depthOccluder.geometry.dispose();
        depthOccluder.geometry = occluderGeometry;
      } else {
        depthOccluder = new THREE.Mesh(occluderGeometry, occluderMaterial);
        depthOccluder.renderOrder = -1;
        occluders.add(depthOccluder);
      }
      depthOccluder.visible = occlusionOn;
    }

    return true;
  }

  function setVisible(next) {
    visible = next;
    group.visible = next;
  }

  /**
   * Occlusion on or off.
   *
   * Worth being able to turn off, and worth saying which it is. A detected
   * plane sits where the tracker thinks the wall is, which on a bad scan can
   * be tens of centimetres in front of the real one — and then a piece of
   * furniture that is genuinely in the room disappears into a wall that is not
   * there. Somebody seeing that needs a way to rule it out.
   */
  function setOcclusion(next) {
    occlusionOn = next;
    occluders.visible = next;
    if (depthOccluder) depthOccluder.visible = next;
  }

  function dispose() {
    for (const [, entry] of meshes) {
      entry.mesh.geometry.dispose();
      entry.mesh.material.dispose();
    }
    meshes.clear();
    occluderMeshes.clear();
    occluders.clear();
    occluderMaterial.dispose();
    if (depthOccluder) {
      depthOccluder.geometry.dispose();
      depthOccluder = null;
    }
    scene.remove(occluders);
    if (depthMesh) {
      depthMesh.geometry.dispose();
      depthMesh.material.dispose();
      depthMesh = null;
    }
    scene.remove(group);
  }

  return {
    update, updateDepth, setVisible, setOcclusion, dispose,
    get planeCount() { return meshes.size; },
    get occlusionOn() { return occlusionOn; },
    get depthOcclusion() { return depthOccluder !== null; }
  };
}
