/**
 * How big should this model be, and can it honestly be shown that big?
 *
 * One question, one answer, one place. The store portal's 3D preview and the
 * AR session both ask here (through ./model-transform.mjs), so they cannot
 * disagree about the size of the same chair.
 *
 * ---------------------------------------------------------------------------
 * The rule: THE PRODUCT'S DIMENSIONS ARE THE SIZE. THE MODEL IS THE SHAPE.
 * ---------------------------------------------------------------------------
 *
 * A store owner measures the real piece and types 30 × 30 × 40 cm. That is
 * the size shoppers are buying, the size the fit check uses, and the size AR
 * must show: 0.30 × 0.30 × 0.40 m, whatever units the .glb happened to be
 * exported in. A mesh 0.3 × 0.3 × 0.4 units across, or 30 × 30 × 40, or
 * 300 × 300 × 400, is the same chair drawn in metres, centimetres or
 * millimetres, and all three land at 0.30 × 0.30 × 0.40 m.
 *
 * (This replaces the earlier rule, "the mesh is the measurement", under which
 * a model exported at the wrong scale was shown at the wrong size and the
 * typed dimensions were only a cross-check. The typed dimensions are what the
 * owner verified against the real piece; the export units are an accident of
 * whichever 3D tool made the file.)
 *
 * ---------------------------------------------------------------------------
 * And the rule that has not changed: SCALE IS UNIFORM, ALWAYS.
 * ---------------------------------------------------------------------------
 *
 * Three independent factors would always hit the target box exactly:
 *
 *     model.scale.set(targetW / meshW, targetH / meshH, targetD / meshD)
 *
 * and would do it by squashing the furniture. A chair must not become
 * thinner, taller or deeper to fit numbers typed into a form. So the three
 * per-axis factors are computed only to COMPARE them:
 *
 *   - if they agree, the model has the piece's proportions, and one factor
 *     (their geometric mean) makes it the right size on every axis;
 *   - if they do not, no single factor can make this model that size without
 *     distorting it. It is not stretched, and it is not claimed to be true
 *     scale. It is refused, with the numbers that show why, until the owner
 *     fixes the dimensions or the model.
 */

import { dimensionsToMeters } from './units.mjs';

/**
 * How far apart the three per-axis factors may be, as (largest / smallest) − 1,
 * and still describe the same shape.
 *
 * Why 3%: owners measure with a tape and round to the centimetre. On a 30 cm
 * axis that rounding alone is ±1.7%, and two axes rounded in opposite
 * directions differ by up to ~3.4%. A mesh that includes a cushion edge the
 * tape missed adds a little more. 3% accepts honest measuring and rejects any
 * real proportion error: the smallest mistake worth catching, a 30 cm axis
 * entered as 32, is a 6.7% spread.
 */
export const MODEL_PROPORTION_TOLERANCE = 0.03;

/**
 * How far each axis of the finished model may be from its target, as a
 * fraction, and still be called true scale.
 *
 * With factors inside MODEL_PROPORTION_TOLERANCE (s), the geometric mean sits
 * within s·2/3 of every factor, so no accepted model can be off by more than
 * 2% on any axis. The final check re-measures the rendered model against this,
 * which catches anything the arithmetic did not predict (a skinned mesh whose
 * pose moves its bounds, a loader quirk).
 */
export const FINAL_BOUNDS_TOLERANCE = 0.02;

/** The status a decision can have. Only READY may be placed or called true scale. */
export const SCALE_STATUS = Object.freeze({
  READY: 'ready',
  NO_DIMENSIONS: 'no-dimensions',
  DEGENERATE: 'degenerate-geometry',
  PROPORTION_MISMATCH: 'proportion-mismatch',
  BOUNDS_MISMATCH: 'bounds-mismatch'
});

/**
 * What counts as a believable piece of furniture, in metres, on its longest
 * axis. No longer used to decide the size; kept to describe a file's likely
 * authoring unit in messages ("this file looks like it is in millimetres").
 */
export const PLAUSIBLE_METRES = { min: 0.05, max: 5 };

const CANDIDATES = [
  { unit: 'metres', factor: 1 },
  { unit: 'centimetres', factor: 0.01 },
  { unit: 'millimetres', factor: 0.001 },
  { unit: 'inches', factor: 0.0254 }
];

/**
 * Which unit was this mesh probably authored in? Informational only.
 * Returns the first candidate that lands the model in PLAUSIBLE_METRES, and
 * `confident: false` when more than one does.
 */
export function classifyUnits(extent) {
  const longest = Math.max(extent.width, extent.depth, extent.height);
  if (!Number.isFinite(longest) || longest <= 0) {
    return { unit: 'unknown', factor: null, confident: false, candidates: [] };
  }
  const fits = CANDIDATES.filter(({ factor }) => {
    const metres = longest * factor;
    return metres >= PLAUSIBLE_METRES.min && metres <= PLAUSIBLE_METRES.max;
  });
  if (fits.length === 0) return { unit: 'unknown', factor: null, confident: false, candidates: [] };
  return { unit: fits[0].unit, factor: fits[0].factor, confident: fits.length === 1, candidates: fits.map(f => f.unit) };
}

const AXES = ['width', 'depth', 'height'];

function positiveFinite(value) {
  return Number.isFinite(value) && value > 0;
}

/**
 * Width : depth : height, each divided by the largest, to two places.
 * "1.00 : 0.52 : 1.80" style, but normalised so the largest axis reads 1.00.
 */
export function proportionOf(extent) {
  const largest = Math.max(extent.width, extent.depth, extent.height);
  return AXES.map(axis => (extent[axis] / largest));
}

export function formatProportion(extent) {
  return proportionOf(extent).map(value => value.toFixed(2)).join(' : ');
}

/**
 * Decide the ONE scale factor that makes this mesh the product's size.
 *
 * @param meshExtent    {width, depth, height} — the raw bounding box, in the
 *                      .glb's own units (X = width, Y = height, Z = depth).
 * @param dimensionsCm  {width, depth, height} in centimetres — the product's
 *                      verified physical size (products.*_cm).
 *
 * Returns a decision, never a silent adjustment:
 *
 *   status        one of SCALE_STATUS
 *   usable        status === READY: may be placed and called true scale
 *   scale         the ONE factor for all three axes (the geometric mean of the
 *                 per-axis factors). Present on a mismatch too, so a preview
 *                 can still show the model's shape at about the right size —
 *                 but a mismatch is never usable.
 *   factors       {width, depth, height}: what each axis alone would need
 *   spread        (largest factor / smallest) − 1
 *   targetMeters  the product's size in metres
 *   finalMeters   the size the model will be at `scale`, per axis
 *   worstAxisError  the largest |final − target| / target
 *   modelProportion / expectedProportion   "W : D : H" strings for the owner
 *   units         the file's probable authoring unit, for messages only
 *   message       one sentence, safe to show a person
 */
export function resolveScale({ meshExtent, dimensionsCm, declaredCm }) {
  // `declaredCm` is the name this parameter had before the dimensions became
  // the authority. Accepted so nothing calling the old name breaks silently.
  const dimensions = dimensionsCm || declaredCm || null;
  const units = classifyUnits(meshExtent || {});
  const base = { usable: false, scale: null, factors: null, spread: null, finalMeters: null,
    worstAxisError: null, modelProportion: null, expectedProportion: null, units };

  if (!dimensions || !AXES.every(axis => positiveFinite(Number(dimensions[axis])))) {
    return {
      ...base,
      status: SCALE_STATUS.NO_DIMENSIONS,
      targetMeters: null,
      message: 'Enter the width, depth and height first. They set how large the furniture appears in AR.'
    };
  }
  const targetMeters = dimensionsToMeters({
    width: Number(dimensions.width), depth: Number(dimensions.depth), height: Number(dimensions.height)
  });

  if (!meshExtent || !AXES.every(axis => positiveFinite(meshExtent[axis]))) {
    return {
      ...base,
      status: SCALE_STATUS.DEGENERATE,
      targetMeters,
      message: 'This model has no measurable size on one of its axes, so it cannot be scaled. '
        + 'Export it again with its full geometry.'
    };
  }

  const factors = {
    width: targetMeters.width / meshExtent.width,
    depth: targetMeters.depth / meshExtent.depth,
    height: targetMeters.height / meshExtent.height
  };
  const values = AXES.map(axis => factors[axis]);
  const spread = Math.max(...values) / Math.min(...values) - 1;
  // The one factor that honours all three axes as evenly as possible.
  const scale = Math.cbrt(values[0] * values[1] * values[2]);
  const finalMeters = {
    width: meshExtent.width * scale,
    depth: meshExtent.depth * scale,
    height: meshExtent.height * scale
  };
  const worstAxisError = Math.max(...AXES.map(axis => Math.abs(finalMeters[axis] - targetMeters[axis]) / targetMeters[axis]));
  const modelProportion = formatProportion(meshExtent);
  const expectedProportion = formatProportion(targetMeters);
  const decided = { ...base, scale, factors, spread, targetMeters, finalMeters, worstAxisError, modelProportion, expectedProportion };

  if (spread > MODEL_PROPORTION_TOLERANCE) {
    return {
      ...decided,
      usable: false,
      status: SCALE_STATUS.PROPORTION_MISMATCH,
      message: "The 3D model's proportions don't match the furniture dimensions. "
        + `Model ${modelProportion}, expected ${expectedProportion} (width : depth : height). `
        + 'To keep the furniture from being distorted, it is not stretched to fit.'
    };
  }

  if (worstAxisError > FINAL_BOUNDS_TOLERANCE) {
    // Unreachable while the two tolerances keep their documented relationship;
    // here so that changing one of them cannot quietly produce a false claim.
    return {
      ...decided,
      usable: false,
      status: SCALE_STATUS.BOUNDS_MISMATCH,
      message: 'Scale needs attention: the model cannot be sized to within '
        + `${Math.round(FINAL_BOUNDS_TOLERANCE * 100)}% of the furniture dimensions on every side.`
    };
  }

  return {
    ...decided,
    usable: true,
    status: SCALE_STATUS.READY,
    message: 'Shown at the furniture\'s own dimensions.'
  };
}

/**
 * Is a model that has been scaled and placed actually the size it should be?
 *
 * Called with the bounding box measured AFTER the transform is applied — not
 * the predicted one — so a model that does not end up the size the arithmetic
 * said is caught before it is called true scale.
 */
export function verifyFinalBounds(measuredMeters, targetMeters) {
  const errors = {};
  for (const axis of AXES) {
    errors[axis] = Math.abs(measuredMeters[axis] - targetMeters[axis]) / targetMeters[axis];
  }
  const worst = Math.max(...AXES.map(axis => errors[axis]));
  return { ok: Number.isFinite(worst) && worst <= FINAL_BOUNDS_TOLERANCE + 1e-9, worst, errors };
}
