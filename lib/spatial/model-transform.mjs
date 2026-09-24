/**
 * Put a loaded model at its true physical size, standing on the floor.
 *
 * The ONE place the physical transform happens. The store portal's preview
 * (app/portal/ModelPreview.js) and the AR session (app/plan/ar-engine.js) both
 * call this, so the same .glb with the same dimensions is exactly the same
 * size in both. Neither of them scales a model any other way.
 *
 * three.js is passed in rather than imported: the AR engine loads it lazily,
 * the tests import it directly, and this module must not pull in a second
 * copy.
 *
 * What it does, in order:
 *   1. measure the raw bounding box        (X = width, Y = height, Z = depth)
 *   2. ask the resolver for ONE factor      (./model-scale.mjs)
 *   3. apply it to all three axes           (model.scale.setScalar)
 *   4. centre X and Z, stand the bottom on Y = 0, so an arbitrary export
 *      origin never leaves the piece floating or half through the floor
 *   5. measure AGAIN and check the result against the target
 *
 * What it never does: scale an axis on its own, or shrink the model to fit a
 * viewport. Framing is the camera's job (see ModelPreview's frameCamera).
 */

import { resolveScale, verifyFinalBounds, SCALE_STATUS } from './model-scale.mjs';

/** A model's axis-aligned size, as {width, depth, height}, in scene units. */
export function measure(THREE, object) {
  object.updateMatrixWorld(true);
  const box = new THREE.Box3().setFromObject(object);
  if (box.isEmpty()) return { box, extent: { width: 0, depth: 0, height: 0 } };
  const size = box.getSize(new THREE.Vector3());
  return { box, extent: { width: size.x, depth: size.z, height: size.y } };
}

/**
 * Scale `object` to `dimensionsCm` and stand it on the floor.
 *
 * Returns { decision, verified, finalMeters, floorOffset, raw }:
 *   decision     the resolver's answer (status, scale, proportions, message)
 *   verified     true only when the decision was READY and the re-measured
 *                model is within tolerance of the target — the one condition
 *                under which anything may call this model true scale
 *   finalMeters  the re-measured size after the transform
 *   floorOffset  how far the lowest point sits from Y = 0 afterwards
 *   raw          the raw extent in the file's own units
 *
 * A model whose proportions do not match is still transformed (at the
 * geometric-mean factor) so a preview can show its shape beside the numbers
 * that explain the problem — but `verified` is false and callers must not
 * place it in AR.
 */
export function normalizeModel(THREE, object, dimensionsCm) {
  // Start from the file's own transform, so calling this twice (the owner
  // edits a dimension) never compounds a previous scale.
  object.scale.setScalar(1);
  object.position.set(0, 0, 0);

  const { extent: raw } = measure(THREE, object);
  let decision = resolveScale({ meshExtent: raw, dimensionsCm });

  if (!decision.scale) {
    return { decision, verified: false, finalMeters: null, floorOffset: null, raw };
  }

  object.scale.setScalar(decision.scale);
  const { box: scaled } = measure(THREE, object);
  const centre = scaled.getCenter(new THREE.Vector3());
  object.position.set(-centre.x, -scaled.min.y, -centre.z);

  const { box: placed, extent: finalMeters } = measure(THREE, object);
  const floorOffset = placed.min.y;
  const check = verifyFinalBounds(finalMeters, decision.targetMeters);

  if (decision.status === SCALE_STATUS.READY && !check.ok) {
    decision = {
      ...decision,
      usable: false,
      status: SCALE_STATUS.BOUNDS_MISMATCH,
      worstAxisError: check.worst,
      message: 'Scale needs attention: after scaling, the model measures '
        + `${Math.round(check.worst * 1000) / 10}% away from the furniture dimensions on one side.`
    };
  }

  return {
    decision,
    verified: decision.status === SCALE_STATUS.READY && check.ok && Math.abs(floorOffset) < 1e-6,
    finalMeters,
    floorOffset,
    raw
  };
}
