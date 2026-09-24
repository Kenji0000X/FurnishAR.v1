/**
 * The product's dimensions set the size; the model supplies the shape; and
 * no input of any kind may produce a non-uniform scale.
 *
 * This file used to assert the opposite of its first rule — "the mesh is the
 * measurement; the typed dimensions are a cross-check". That rule was
 * replaced deliberately (see lib/spatial/model-scale.mjs), and the tests that
 * encoded it were rewritten to encode the new one, not deleted.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import * as THREE from 'three';
import {
  resolveScale, verifyFinalBounds, classifyUnits, SCALE_STATUS,
  MODEL_PROPORTION_TOLERANCE, FINAL_BOUNDS_TOLERANCE
} from '../lib/spatial/model-scale.mjs';
import { normalizeModel, measure } from '../lib/spatial/model-transform.mjs';
import { dimensionsToCentimeters } from '../lib/spatial/units.mjs';

const extent = (width, depth, height) => ({ width, depth, height });
const close = (actual, expected, tolerance, label = '') =>
  assert.ok(Math.abs(actual - expected) <= tolerance, `${label}: expected ${expected}, got ${actual}`);

/** A box mesh with its origin somewhere arbitrary, like a Blender export. */
function boxModel(width, height, depth, origin = [0, 0, 0]) {
  const mesh = new THREE.Mesh(new THREE.BoxGeometry(width, height, depth), new THREE.MeshBasicMaterial());
  mesh.position.set(...origin);
  const root = new THREE.Group();
  root.add(mesh);
  return root;
}

/* ------------------------------------------------------------------------ */
/* 1. The dimensions are the physical authority, whatever the export units.  */
/* ------------------------------------------------------------------------ */

test('30 × 30 × 40 cm: metre, centimetre and millimetre exports all land at 0.30 × 0.30 × 0.40 m', () => {
  const declared = { width: 30, depth: 30, height: 40 };
  const cases = [
    { mesh: extent(0.3, 0.3, 0.4), scale: 1 },
    { mesh: extent(30, 30, 40), scale: 0.01 },
    { mesh: extent(300, 300, 400), scale: 0.001 }
  ];
  for (const { mesh, scale } of cases) {
    const decision = resolveScale({ meshExtent: mesh, dimensionsCm: declared });
    assert.equal(decision.status, SCALE_STATUS.READY, JSON.stringify(mesh));
    assert.equal(decision.usable, true);
    close(decision.scale, scale, 1e-12, `scale for ${mesh.width}`);
    close(decision.finalMeters.width, 0.30, 1e-12, 'width');
    close(decision.finalMeters.depth, 0.30, 1e-12, 'depth');
    close(decision.finalMeters.height, 0.40, 1e-12, 'height');
  }
});

test('the same holds for an arbitrary unit nobody would guess (a 7.3× export)', () => {
  const decision = resolveScale({ meshExtent: extent(2.19, 2.19, 2.92), dimensionsCm: { width: 30, depth: 30, height: 40 } });
  assert.equal(decision.usable, true);
  close(decision.finalMeters.height, 0.40, 1e-9, 'height');
});

test('the real cane-back armchair is now shown at its listed size, not its mesh size', () => {
  // Mesh 0.7935 × 0.8853 × 0.9995 m (measured from data/models/cane-back-armchair.glb);
  // listed 70 × 78 × 88 cm. Same proportions within 0.2%, so it is sized to the listing.
  const decision = resolveScale({ meshExtent: extent(0.7935, 0.8853, 0.9995), dimensionsCm: { width: 70, depth: 78, height: 88 } });
  assert.equal(decision.status, SCALE_STATUS.READY);
  assert.ok(decision.spread < 0.005, `spread ${decision.spread}`);
  close(decision.finalMeters.width, 0.70, 0.70 * FINAL_BOUNDS_TOLERANCE, 'width');
  close(decision.finalMeters.depth, 0.78, 0.78 * FINAL_BOUNDS_TOLERANCE, 'depth');
  close(decision.finalMeters.height, 0.88, 0.88 * FINAL_BOUNDS_TOLERANCE, 'height');
});

/* ------------------------------------------------------------------------ */
/* 2. Proportions that cannot be honoured are refused, not stretched.        */
/* ------------------------------------------------------------------------ */

test('a cube declared as 30 × 30 × 40 cm is refused: one factor cannot make it that shape', () => {
  const decision = resolveScale({ meshExtent: extent(1, 1, 1), dimensionsCm: { width: 30, depth: 30, height: 40 } });
  assert.equal(decision.usable, false);
  assert.equal(decision.status, SCALE_STATUS.PROPORTION_MISMATCH);
  assert.equal(decision.modelProportion, '1.00 : 1.00 : 1.00');
  assert.equal(decision.expectedProportion, '0.75 : 0.75 : 1.00');
  assert.match(decision.message, /proportions don't match/);
  assert.match(decision.message, /not stretched/);
  // No per-axis scale exists in the answer to be applied by mistake.
  for (const key of ['scaleX', 'scaleY', 'scaleZ']) assert.equal(decision[key], undefined);
  assert.equal(typeof decision.scale, 'number', 'one factor, for showing the shape in a preview');
});

test('the brief\'s example: a cube declared 30 × 30 × 100 cm shows 1 : 1 : 1 against 0.3 : 0.3 : 1', () => {
  const decision = resolveScale({ meshExtent: extent(1, 1, 1), dimensionsCm: { width: 30, depth: 30, height: 100 } });
  assert.equal(decision.status, SCALE_STATUS.PROPORTION_MISMATCH);
  assert.equal(decision.expectedProportion, '0.30 : 0.30 : 1.00');
});

test('the tolerance is one constant, and it decides both sides of the line', () => {
  const declared = { width: 100, depth: 100, height: 100 };
  const inside = resolveScale({ meshExtent: extent(1, 1, 1 / (1 + MODEL_PROPORTION_TOLERANCE * 0.99)), dimensionsCm: declared });
  const outside = resolveScale({ meshExtent: extent(1, 1, 1 / (1 + MODEL_PROPORTION_TOLERANCE * 1.01)), dimensionsCm: declared });
  assert.equal(inside.status, SCALE_STATUS.READY);
  assert.equal(outside.status, SCALE_STATUS.PROPORTION_MISMATCH);
  // Anything accepted is within the final-bounds tolerance on every axis.
  assert.ok(inside.worstAxisError <= FINAL_BOUNDS_TOLERANCE, `worst ${inside.worstAxisError}`);
});

test('a 30 cm axis entered as 32 cm is caught', () => {
  const decision = resolveScale({ meshExtent: extent(0.3, 0.3, 0.4), dimensionsCm: { width: 32, depth: 30, height: 40 } });
  assert.equal(decision.status, SCALE_STATUS.PROPORTION_MISMATCH);
});

/* ------------------------------------------------------------------------ */
/* 3. Things that cannot be measured are refused, not divided by.            */
/* ------------------------------------------------------------------------ */

test('degenerate geometry and missing dimensions are refused with their own status', () => {
  for (const bad of [extent(0, 0, 0), extent(NaN, 1, 1), extent(-1, -1, -1), extent(1, 0, 1)]) {
    const decision = resolveScale({ meshExtent: bad, dimensionsCm: { width: 70, depth: 78, height: 88 } });
    assert.equal(decision.usable, false);
    assert.equal(decision.status, SCALE_STATUS.DEGENERATE, JSON.stringify(bad));
    assert.equal(decision.scale, null);
  }
  for (const dims of [null, { width: 0, depth: 1, height: 1 }, { width: 'x', depth: 1, height: 1 }]) {
    const decision = resolveScale({ meshExtent: extent(1, 1, 1), dimensionsCm: dims });
    assert.equal(decision.status, SCALE_STATUS.NO_DIMENSIONS);
    assert.equal(decision.usable, false);
  }
});

test('the old parameter name still works rather than silently ignoring the size', () => {
  const decision = resolveScale({ meshExtent: extent(30, 30, 40), declaredCm: { width: 30, depth: 30, height: 40 } });
  assert.equal(decision.usable, true);
});

test('classifyUnits still describes a file\'s likely unit, and decides nothing', () => {
  assert.equal(classifyUnits(extent(0.793, 0.885, 1.0)).unit, 'metres');
  assert.equal(classifyUnits(extent(79.3, 88.5, 100)).unit, 'centimetres');
  assert.equal(classifyUnits(extent(793, 885, 1000)).unit, 'millimetres');
  // The 32 km living-room file: no believable unit — and yet with dimensions it can still be sized.
  assert.equal(classifyUnits(extent(32099, 27389, 15228)).unit, 'unknown');
  const decision = resolveScale({ meshExtent: extent(32099, 27389, 15228), dimensionsCm: { width: 321, depth: 273.9, height: 152.3 } });
  assert.equal(decision.usable, true);
});

/* ------------------------------------------------------------------------ */
/* 4. The property that matters most: uniform scale, for any input at all.   */
/* ------------------------------------------------------------------------ */

test('no input of any shape can produce a non-uniform scale', () => {
  const meshes = [extent(0.793, 0.885, 1.0), extent(2.4, 0.9, 0.75), extent(0.3, 0.3, 0.42), extent(79.3, 88.5, 100), extent(1200, 800, 750), extent(1e-6, 2e-6, 3e-6)];
  const declarations = [
    { width: 70, depth: 78, height: 88 },
    { width: 1, depth: 999, height: 40 },
    { width: 240, depth: 90, height: 75 },
    { width: 30, depth: 30, height: 40 }
  ];
  for (const meshExtent of meshes) {
    for (const dimensionsCm of declarations) {
      const decision = resolveScale({ meshExtent, dimensionsCm });
      if (decision.scale === null) continue;
      assert.equal(typeof decision.scale, 'number');
      assert.ok(decision.scale > 0 && Number.isFinite(decision.scale));
      // The reported final size is exactly the mesh times that one factor:
      // the rendered proportions cannot differ from the mesh's.
      for (const axis of ['width', 'depth', 'height']) {
        close(decision.finalMeters[axis], meshExtent[axis] * decision.scale, 1e-12, axis);
      }
      // And a usable decision is always within tolerance of the target.
      if (decision.usable) assert.ok(decision.worstAxisError <= FINAL_BOUNDS_TOLERANCE + 1e-12);
    }
  }
});

test('verifyFinalBounds names the worst axis and fails outside tolerance', () => {
  const target = { width: 0.3, depth: 0.3, height: 0.4 };
  assert.equal(verifyFinalBounds({ width: 0.3, depth: 0.3, height: 0.4 }, target).ok, true);
  const off = verifyFinalBounds({ width: 0.3, depth: 0.3, height: 0.43 }, target);
  assert.equal(off.ok, false);
  close(off.worst, 0.075, 1e-9, 'worst');
});

/* ------------------------------------------------------------------------ */
/* 5. The shared transform, on real three.js objects (preview and AR).        */
/* ------------------------------------------------------------------------ */

test('normalizeModel: a 300 × 400 × 300 mm export becomes 0.30 × 0.40 × 0.30 m, centred and on the floor', () => {
  // Origin deliberately off-centre and below zero, like an unapplied Blender transform.
  const model = boxModel(300, 400, 300, [120, -55, 40]);
  const result = normalizeModel(THREE, model, { width: 30, depth: 30, height: 40 });
  assert.equal(result.verified, true);
  assert.equal(result.decision.status, SCALE_STATUS.READY);
  close(result.decision.scale, 0.001, 1e-12, 'scale');
  const { box, extent: final } = measure(THREE, model);
  close(final.width, 0.30, 1e-9, 'world width');
  close(final.height, 0.40, 1e-9, 'world height');
  close(final.depth, 0.30, 1e-9, 'world depth');
  close(box.min.y, 0, 1e-9, 'bottom on the floor');
  close((box.min.x + box.max.x) / 2, 0, 1e-9, 'centred on X');
  close((box.min.z + box.max.z) / 2, 0, 1e-9, 'centred on Z');
  // One factor on every axis of the root.
  assert.equal(model.scale.x, model.scale.y);
  assert.equal(model.scale.y, model.scale.z);
});

test('normalizeModel: calling it again after a dimension change never compounds the previous scale', () => {
  const model = boxModel(30, 40, 30);
  normalizeModel(THREE, model, { width: 30, depth: 30, height: 40 });
  normalizeModel(THREE, model, { width: 60, depth: 60, height: 80 });
  const { extent: final } = measure(THREE, model);
  close(final.width, 0.60, 1e-9, 'width after resize');
  close(final.height, 0.80, 1e-9, 'height after resize');
});

test('normalizeModel: a mismatched model is not verified, and is still not stretched', () => {
  const model = boxModel(1, 1, 1);
  const result = normalizeModel(THREE, model, { width: 30, depth: 30, height: 40 });
  assert.equal(result.verified, false);
  assert.equal(result.decision.status, SCALE_STATUS.PROPORTION_MISMATCH);
  const { extent: final } = measure(THREE, model);
  // Still a cube: equal sides, whatever size the preview shows it at.
  close(final.width, final.height, 1e-9, 'cube stays a cube');
  close(final.depth, final.height, 1e-9, 'cube stays a cube');
});

test('normalizeModel: an empty scene is refused without dividing by zero', () => {
  const result = normalizeModel(THREE, new THREE.Group(), { width: 30, depth: 30, height: 40 });
  assert.equal(result.verified, false);
  assert.equal(result.decision.status, SCALE_STATUS.DEGENERATE);
});

test('rotating a placed model does not change its authoritative dimensions', () => {
  // The size shown and used for fit is the product's dimensions, not the
  // world-aligned box, which grows diagonally as the piece turns.
  const model = boxModel(300, 400, 300);
  const { decision } = normalizeModel(THREE, model, { width: 30, depth: 30, height: 40 });
  model.rotation.y = Math.PI / 4;
  const { extent: rotatedWorld } = measure(THREE, model);
  assert.ok(rotatedWorld.width > 0.30 + 1e-3, 'the world box does grow when turned');
  const authoritative = dimensionsToCentimeters({ width: 30, depth: 30, height: 40 }, 'cm');
  close(decision.targetMeters.width * 100, authoritative.width, 1e-9, 'target width unchanged');
  close(decision.targetMeters.height * 100, authoritative.height, 1e-9, 'target height unchanged');
  // The model's own scale (what AR renders) is untouched by the rotation.
  close(model.scale.x, 0.001, 1e-12, 'scale unchanged by rotation');
});
