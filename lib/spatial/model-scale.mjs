/**
 * How big is this model, really?
 *
 * One question, one answer, one place. Everything that puts a piece of
 * furniture into a room — the AR session, the planner preview, the portal's
 * confirmation view — asks here, so they cannot disagree about the size of the
 * same chair.
 *
 * ---------------------------------------------------------------------------
 * The rule this file exists to enforce: SCALE IS UNIFORM, ALWAYS.
 * ---------------------------------------------------------------------------
 *
 * The previous implementation computed three independent factors and applied
 * them:
 *
 *     model.scale.set(
 *       declaredWidth  / meshWidth,
 *       declaredHeight / meshHeight,
 *       declaredDepth  / meshDepth
 *     );
 *
 * which forces any mesh into whatever box a shop typed into a form. A chair
 * measured at 79.3 cm wide and listed as 70 cm was squeezed 12% on X alone.
 * The shopper then judged a piece of furniture that does not exist, and the
 * fit verdict answered for that imaginary shape. A real armchair does not get
 * narrower because somebody rounded a number down.
 *
 * So: one factor, on all three axes, or the model is not shown at all.
 *
 * ---------------------------------------------------------------------------
 * Where the truth comes from
 * ---------------------------------------------------------------------------
 *
 * glTF defines its unit as the METRE. A correctly exported .glb therefore
 * already carries real-world scale, and is the only *measured* quantity in the
 * system — the typed width/depth/height are a human's claim about the same
 * object, entered from a tape measure or from a supplier's page, and are
 * routinely a little wrong.
 *
 * Exports are not always correct, though. `modern-living-room.glb` in this
 * repo measures 32099 × 15228 × 27389 units; nothing sane is 32 km wide, so
 * that file was authored in some other unit. Guessing which one is a judgement
 * call, and this module makes it explicitly and reports what it did, rather
 * than silently rescaling and hoping.
 */

/**
 * What counts as a believable piece of furniture, in metres, on its longest
 * axis. A doll's-house chair and a shipping container are both outside it.
 *
 * Deliberately generous: a footstool is ~0.3 m, a long sectional sofa or a
 * wardrobe can reach 4 m. The range only has to be tight enough to tell a
 * metre-authored file from a centimetre-authored one, and those differ by
 * 100×, so there is no contest.
 */
export const PLAUSIBLE_METRES = { min: 0.05, max: 5 };

/** The unit a file was probably authored in, and what to multiply by to fix it. */
const CANDIDATES = [
  { unit: 'metres', factor: 1 },
  { unit: 'centimetres', factor: 0.01 },
  { unit: 'millimetres', factor: 0.001 },
  // Furniture modelled in the US is often authored in inches. Included because
  // it is common, last because it is only 2.54× from metres-adjacent values
  // and so is the easiest of these to claim wrongly.
  { unit: 'inches', factor: 0.0254 }
];

/**
 * Which unit was this mesh authored in?
 *
 * Takes the raw extent straight out of the glTF, in glTF units. Returns the
 * single candidate that lands the model inside PLAUSIBLE_METRES — and reports
 * `confident: false` when more than one does, because then the file genuinely
 * is ambiguous and nothing here can resolve it.
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
  // Several readings are believable (a 2-unit mesh is a plausible 2 m sofa and
  // an implausible 2 cm one — but a 200-unit mesh is a plausible 2 m sofa in
  // centimetres AND a plausible 5 m one in inches). Metres wins as the format's
  // own definition, but the ambiguity is reported rather than buried.
  return {
    unit: fits[0].unit,
    factor: fits[0].factor,
    confident: fits.length === 1,
    candidates: fits.map(f => f.unit)
  };
}

const cm = metres => Math.round(metres * 1000) / 10;

/**
 * Decide the one scale factor to render this product at, and say why.
 *
 * @param meshExtent  {width, depth, height} in raw glTF units, from the bbox.
 * @param declaredCm  {width, depth, height} in cm — what the shop typed.
 * @param overrideCm  {width, depth, height} in cm, optional — a size a human
 *                    explicitly confirmed for this model (products.bounds_*_cm).
 *
 * Returns a decision, never a silent adjustment:
 *
 *   usable      can this be put in a room at all
 *   scale       the ONE factor to apply to all three axes
 *   actualCm    what the shopper will actually see, in cm
 *   source      'model' | 'confirmed-override' | none
 *   agreement   worst per-axis disagreement with declaredCm, as a fraction
 *   verdict     'agrees' | 'differs' | 'unknown-units' | 'distorted-override'
 *   message     one sentence, safe to show a person
 */
export function resolveScale({ meshExtent, declaredCm, overrideCm = null }) {
  const units = classifyUnits(meshExtent);

  if (!units.factor) {
    // §24: never silently return false data. There is no honest number here,
    // so there is no number here.
    return {
      usable: false,
      scale: null,
      actualCm: null,
      source: null,
      units,
      agreement: null,
      verdict: 'unknown-units',
      message:
        'The size of this model could not be determined — its geometry is ' +
        `${Math.round(Math.max(meshExtent.width, meshExtent.depth, meshExtent.height))} units across, ` +
        'which is not a believable size in metres, centimetres, millimetres or inches. ' +
        'Re-export it with real-world dimensions.'
    };
  }

  const nativeCm = {
    width: cm(meshExtent.width * units.factor),
    depth: cm(meshExtent.depth * units.factor),
    height: cm(meshExtent.height * units.factor)
  };

  // A human explicitly confirmed a render size for this model. That outranks
  // both the mesh and the typed dimensions — but it still only ever produces
  // ONE factor, so it cannot be used to sneak a stretch back in.
  if (overrideCm && overrideCm.width > 0 && overrideCm.height > 0 && overrideCm.depth > 0) {
    const perAxis = [
      overrideCm.width / nativeCm.width,
      overrideCm.depth / nativeCm.depth,
      overrideCm.height / nativeCm.height
    ];
    // The uniform factor that best honours the confirmed size: the geometric
    // mean, so no single axis dominates and the error is spread evenly.
    const uniform = Math.cbrt(perAxis[0] * perAxis[1] * perAxis[2]);
    const spread = Math.max(...perAxis) / Math.min(...perAxis) - 1;
    const scale = units.factor * uniform;
    return {
      usable: true,
      scale,
      actualCm: {
        width: cm(meshExtent.width * scale),
        depth: cm(meshExtent.depth * scale),
        height: cm(meshExtent.height * scale)
      },
      source: 'confirmed-override',
      units,
      agreement: spread,
      // Worth saying out loud: the confirmed size does not have this model's
      // proportions, so it cannot be honoured exactly without distorting the
      // geometry — and distorting it is not on the table.
      verdict: spread > 0.02 ? 'distorted-override' : 'agrees',
      message: spread > 0.02
        ? `The confirmed size ${overrideCm.width} × ${overrideCm.depth} × ${overrideCm.height} cm has ` +
          `different proportions from the model (off by ${Math.round(spread * 100)}%). ` +
          'The model is shown at its own proportions, scaled to match as closely as possible, ' +
          'rather than stretched to fit.'
        : `Shown at the confirmed size, ${overrideCm.width} × ${overrideCm.depth} × ${overrideCm.height} cm.`
    };
  }

  // No override: the mesh is the measurement. The typed dimensions become a
  // cross-check that surfaces disagreement instead of an instruction that
  // silently overrules the geometry.
  const agreement = declaredCm && declaredCm.width > 0
    ? Math.max(
        Math.abs(nativeCm.width - declaredCm.width) / declaredCm.width,
        Math.abs(nativeCm.depth - declaredCm.depth) / declaredCm.depth,
        Math.abs(nativeCm.height - declaredCm.height) / declaredCm.height
      )
    : null;

  // 5% is the band within which a tape measure, a rounded listing and a mesh
  // that includes or excludes a cushion all plausibly describe one object.
  const differs = agreement !== null && agreement > 0.05;

  return {
    usable: true,
    scale: units.factor,
    actualCm: nativeCm,
    source: 'model',
    units,
    agreement,
    verdict: differs ? 'differs' : 'agrees',
    message: differs
      ? `This model measures ${nativeCm.width} × ${nativeCm.depth} × ${nativeCm.height} cm, ` +
        `but the listing says ${declaredCm.width} × ${declaredCm.depth} × ${declaredCm.height} cm ` +
        `— a difference of ${Math.round(agreement * 100)}%. The model is shown at its own size. ` +
        'Check which is right.'
      : `Shown at its own size, ${nativeCm.width} × ${nativeCm.depth} × ${nativeCm.height} cm.`
  };
}
